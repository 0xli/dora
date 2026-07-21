/**
 * Registry server. Listens for incoming Carrier text messages with the
 * `DECENT_REGISTRY:` prefix and answers register/lookup/list operations.
 *
 * Identity: the registry IS a Carrier peer. Operators friend it the
 * same way they friend any decentlan node. The userid of the registry
 * is what clients put in their `registry.userid` config field.
 */

import { Peer } from "@decentnetwork/peer";
// Dora control rides toxcore custom packet 162 (lossless), matching
// decentlan's client side — NOT the chat/message channel (64). See
// decentlan docs/PROTOCOL.md.
const PACKET_ID_DL_DORA = 162;
import type { RegistryStore } from "./store.js";
import type { IpAllocator } from "./allocator.js";
import {
  decode,
  encode,
  type RegistryRequest,
  type RegistryResponse,
  type RegistryRecord,
} from "./types.js";

export interface RegistryServerOptions {
  peer: Peer;
  store: RegistryStore;
  allocator: IpAllocator;
  /** Emit log lines for every served operation. */
  verbose?: boolean;
  /**
   * Sibling registries to replicate from, as `{ userid, address? }`.
   * Empty (the default) keeps replication OFF and the server behaves
   * exactly as before.
   *
   * Why: each dora is authoritative for one IP segment and nothing else,
   * so losing one dora used to blind the whole network to that segment —
   * clients could still get their own IP from a surviving dora but could
   * not resolve anybody in the dead dora's range. Pulling siblings'
   * rosters makes every dora able to answer for the whole /16, so a
   * single dora going down stops being a network-wide outage.
   */
  siblings?: Array<{ userid: string; address?: string }>;
  /** How often to pull sibling rosters. Default 60s. */
  syncIntervalMs?: number;
  /** Drop replicas not re-asserted within this window. Default 15min —
   *  long enough to ride out a sibling restart, short enough that a
   *  retired record doesn't answer for hours. */
  replicaTtlMs?: number;
}

export class RegistryServer {
  private peer: Peer;
  private store: RegistryStore;
  private allocator: IpAllocator;
  private verbose: boolean;
  private isRunning = false;
  private kickFriendsTimer: NodeJS.Timeout | null = null;
  private siblings: Array<{ userid: string; address?: string }>;
  private syncIntervalMs: number;
  private replicaTtlMs: number;
  private syncTimer: NodeJS.Timeout | null = null;
  /** In-flight sibling list requests, keyed by sibling userid. Responses
   *  arrive on the same custom-packet channel as requests, so the packet
   *  handler routes `*-ok`/`*-err` here instead of into `handle()`. */
  private pendingSync = new Map<string, (res: RegistryResponse) => void>();

  constructor(opts: RegistryServerOptions) {
    this.peer = opts.peer;
    this.store = opts.store;
    this.allocator = opts.allocator;
    this.verbose = opts.verbose ?? false;
    this.siblings = opts.siblings ?? [];
    this.syncIntervalMs = opts.syncIntervalMs ?? 60_000;
    this.replicaTtlMs = opts.replicaTtlMs ?? 15 * 60_000;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // DORA is a public service — accept every incoming friend request
    // automatically. That's the whole point: an operator publishes the
    // server's Carrier address, every decentlan node sends a friend
    // request to it on startup, and the server says yes so the two can
    // exchange register/lookup/list messages over Carrier.
    //
    // No anti-spam here in v0.1. If that becomes a problem we'll add a
    // rate-limiter or a registration token; for now the trust model
    // matches a public WiFi router that hands out DHCP leases to
    // anything that asks.
    this.peer.onFriendRequest(
      (req: { pubkey: string; name?: string; hello?: string }) => {
        const who = `${req.name || "(unnamed)"} ${req.pubkey.slice(0, 16)}...`;
        this.log(`friend request from ${who} — auto-accepting`);
        this.peer.acceptFriendRequest(req.pubkey).catch((err) => {
          this.log(`auto-accept failed for ${who}: ${err}`);
        });
      }
    );

    this.peer.onCustomPacket((pkt: { pubkey: string; id: number; data: Uint8Array }) => {
      if (pkt.id !== PACKET_ID_DL_DORA) return;
      const msg = decode(Buffer.from(pkt.data).toString("utf-8"));
      if (!msg) return; // not a registry message
      const op = (msg as { op?: string }).op ?? "";
      // Replies to OUR sibling-sync requests share this channel with
      // inbound client requests. Route them to the waiter; they are not
      // operations to serve.
      if (op.endsWith("-ok") || op.endsWith("-err")) {
        const waiter = this.pendingSync.get(pkt.pubkey);
        if (waiter) {
          this.pendingSync.delete(pkt.pubkey);
          waiter(msg as RegistryResponse);
        }
        return;
      }
      this.handle(pkt.pubkey, msg as RegistryRequest).catch((err) => {
        this.log(`error handling ${(msg as RegistryRequest).op} from ${pkt.pubkey.slice(0, 12)}: ${err}`);
      });
    });

    // Aggressively re-establish Carrier sessions with every persisted
    // friend on startup. Without this, dora's friends.json view of a
    // peer can stay "offline" indefinitely even after the peer's
    // daemon is up and pings dora as a friend — asymmetric session
    // state. Subsequent sendText replies fail silently because dora
    // thinks the peer is unreachable. Kicking on a 8s cadence is the
    // same pattern decentlan uses; it's a no-op for already-online
    // friends and the SDK swallows the "offline" error internally.
    this.kickFriendsTimer = setInterval(() => {
      for (const f of this.peer.friends()) {
        const target = f.userid ?? f.pubkey;
        if (!target) continue;
        // sendText("") triggers #initiateSession in the SDK; we
        // ignore errors because we expect them for genuinely-offline
        // friends.
        this.peer.sendText(target, "").catch(() => undefined);
      }
    }, 8000);
    this.kickFriendsTimer.unref?.();
    // Run once immediately so we don't wait 8s for the first kick.
    setTimeout(() => {
      for (const f of this.peer.friends()) {
        const target = f.userid ?? f.pubkey;
        if (target) this.peer.sendText(target, "").catch(() => undefined);
      }
    }, 1000);

    this.startSiblingSync();

    this.log("dora server started — friend requests will auto-accept");
  }

  /**
   * Replicate sibling registries' rosters so this dora can answer for the
   * whole /16, not just its own segment. Off unless siblings are configured.
   */
  private startSiblingSync(): void {
    if (this.siblings.length === 0) return;

    // We can only exchange packets with a friend, so make sure we are one.
    // Siblings auto-accept, same as any client.
    for (const s of this.siblings) {
      if (!s.address) continue;
      this.peer.sendFriendRequest(s.address, "dora sibling replication").catch(() => undefined);
    }

    const run = (): void => {
      const dropped = this.store.pruneStaleReplicas(this.replicaTtlMs);
      if (dropped) this.log(`replication: pruned ${dropped} stale replica(s)`);
      for (const s of this.siblings) {
        this.syncFrom(s.userid).catch((err) => {
          this.log(`replication: sync from ${s.userid.slice(0, 12)} failed: ${err}`);
        });
      }
    };
    this.syncTimer = setInterval(run, this.syncIntervalMs);
    this.syncTimer.unref?.();
    // First pass shortly after start, once sessions have had a moment.
    setTimeout(run, 10_000);
    this.log(
      `replication: enabled for ${this.siblings.length} sibling(s), every ${Math.round(this.syncIntervalMs / 1000)}s`
    );
  }

  /** Page through one sibling's roster and merge what it is authoritative
   *  for. Records it merely replicates itself are skipped, so every record
   *  has exactly one origin and a retired one can actually expire instead of
   *  being kept alive forever by replicas echoing each other. */
  private async syncFrom(siblingUserid: string): Promise<void> {
    const collected: RegistryRecord[] = [];
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const res = await this.request(siblingUserid, { op: "list", offset } as RegistryRequest);
      if (!res || res.op !== "list-ok") return;
      // Segment uniqueness is the invariant the whole federation rests on;
      // nothing used to be able to check it. A sibling claiming part of our
      // band means both of us can allocate the same address to different
      // nodes, so say so loudly every round until an operator fixes it.
      if (page === 0 && res.seg && this.allocator.overlaps(res.seg)) {
        this.log(
          `replication: SEGMENT OVERLAP with ${siblingUserid.slice(0, 12)} — ` +
          `it claims ${res.seg}, we claim ${this.allocator.segment()}. ` +
          `Both may hand out the same virtual IP; fix the --range-start/--range-end split.`
        );
      }
      const records = (res.records ?? []) as Array<RegistryRecord & { rep?: number }>;
      for (const r of records) {
        if (r.rep) continue; // the sibling's own replica — not its to vouch for
        collected.push(r);
      }
      offset += records.length;
      if (records.length === 0 || offset >= (res.total ?? 0)) break;
    }
    if (collected.length === 0) return;
    // Never accept a copy of anything in our own segment: we are the
    // authority there and a sibling's view may be stale.
    const merged = this.store.putReplicatedBatch(collected, siblingUserid, (rec) =>
      this.allocator.ownsIp(rec.virtualIp)
    );
    if (merged) {
      this.log(`replication: merged ${merged} record(s) from ${siblingUserid.slice(0, 12)}`);
    }
  }

  /** One request/response round-trip to a sibling over the dora channel. */
  private request(
    toUserid: string,
    req: RegistryRequest,
    timeoutMs = 15_000
  ): Promise<RegistryResponse | null> {
    return new Promise((resolve) => {
      // Only one in-flight request per sibling — the sync loop is serial.
      if (this.pendingSync.has(toUserid)) return resolve(null);
      const timer = setTimeout(() => {
        this.pendingSync.delete(toUserid);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pendingSync.set(toUserid, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.peer
        .sendCustomPacket(toUserid, PACKET_ID_DL_DORA, Buffer.from(encode(req), "utf-8"))
        .catch(() => {
          clearTimeout(timer);
          this.pendingSync.delete(toUserid);
          resolve(null);
        });
    });
  }

  private async handle(fromUserid: string, req: RegistryRequest): Promise<void> {
    // TEMP: always-on debug to diagnose CN's list-timeout — drop
    // me when CN works.
    process.stderr.write(
      `[dora-debug] handle op=${req.op} from=${fromUserid.slice(0, 12)} at=${new Date().toISOString()}\n`
    );
    let response: RegistryResponse;

    switch (req.op) {
      case "register":
        response = this.handleRegister(fromUserid, req);
        break;
      case "lookup":
        response = this.handleLookup(req);
        break;
      case "list": {
        // Trim records to the fields the client actually consumes
        // (userid, name, virtualIp, address). registeredAt and
        // lastSeenAt save ~80 bytes per record.
        // `rep: 1` marks a record we do NOT vouch for, so a syncing sibling
        // skips it and every record keeps exactly one authoritative origin.
        // Two cases qualify:
        //  - a replica we pulled from a sibling (second-hand), and
        //  - a record outside our own segment. Authority IS the segment: a
        //    dora that once ran with the default whole-/16 range still holds
        //    records in other doras' segments, and without this it would
        //    replicate them out as if it owned them and could beat the real
        //    segment owner to becoming their origin.
        // Clients ignore the extra field and still see the full roster.
        const all = this.store.list().map((r) => ({
          userid: r.userid,
          name: r.name,
          virtualIp: r.virtualIp,
          address: r.address,
          ...(r.replicatedFrom || !this.allocator.ownsIp(r.virtualIp) ? { rep: 1 } : {}),
        }));
        // Paginate: even trimmed, a roster of >~8 peers blows past
        // Carrier's ~1372-byte text-message limit, so the whole reply
        // gets dropped at the SDK layer and the client times out. Return
        // a bounded page from `offset` plus the full `total`; the client
        // pages through until it has them all. A page small enough to fit
        // one record's worst case (~160 B) × LIST_PAGE_SIZE stays well
        // under the limit with room for the JSON envelope.
        const offset = Math.max(0, (req as { offset?: number }).offset ?? 0);
        const LIST_PAGE_SIZE = 6;
        const page = all.slice(offset, offset + LIST_PAGE_SIZE);
        // `seg` advertises the band we claim. A syncing sibling compares it
        // with its own and screams if they intersect — segment uniqueness was
        // previously a convention nothing could check, and two registries
        // allocating from the same band hand two nodes the same virtual IP.
        response = {
          op: "list-ok",
          records: page as RegistryRecord[],
          total: all.length,
          seg: this.allocator.segment(),
        } as RegistryResponse;
        break;
      }
      default:
        // Future ops we don't know yet — silently ignore so old servers
        // don't reject newer clients.
        return;
    }

    const encoded = encode(response);
    process.stderr.write(
      `[dora-debug] send ${response.op} to=${fromUserid.slice(0, 12)} bytes=${Buffer.byteLength(encoded, "utf-8")}\n`
    );
    try {
      await this.peer.sendCustomPacket(fromUserid, PACKET_ID_DL_DORA, Buffer.from(encoded, "utf-8"));
      process.stderr.write(`[dora-debug] send ${response.op} to=${fromUserid.slice(0, 12)} OK\n`);
    } catch (err) {
      process.stderr.write(`[dora-debug] send ${response.op} to=${fromUserid.slice(0, 12)} ERR: ${err}\n`);
      this.log(`reply to ${fromUserid.slice(0, 12)} failed: ${err}`);
    }
  }

  private handleRegister(
    fromUserid: string,
    req: Extract<RegistryRequest, { op: "register" }>
  ): RegistryResponse {
    // A peer can only register/modify its own record. The userid in the
    // request must match the Carrier-level sender userid.
    if (req.userid !== fromUserid) {
      return {
        op: "register-err",
        reason: `register-as-other not allowed (sender=${fromUserid.slice(0, 12)}..., claimed=${req.userid.slice(0, 12)}...)`,
      };
    }

    const existing = this.store.get(req.userid);

    // Idempotent re-register from same peer with same name+ip.
    if (
      existing &&
      existing.name === req.name &&
      (!req.requestedIp || existing.virtualIp === req.requestedIp)
    ) {
      this.store.touch(req.userid);
      return { op: "register-ok", record: existing };
    }

    // Rename/IP-change requires replace=true.
    if (existing && !req.replace) {
      return {
        op: "register-err",
        reason: `userid already registered as ${existing.name} (${existing.virtualIp}); pass replace=true to overwrite`,
      };
    }

    // Name collision (someone else holds the name).
    const nameHolder = this.store.findByName(req.name);
    if (nameHolder && nameHolder.userid !== req.userid) {
      return {
        op: "register-err",
        reason: `name ${req.name} is held by ${nameHolder.userid.slice(0, 12)}...`,
        suggestion: `${req.name}-2`,
      };
    }

    // IP allocation.
    let ip: string | null;
    if (req.requestedIp) {
      const ipHolder = this.store.findByIp(req.requestedIp);
      if (ipHolder && ipHolder.userid !== req.userid) {
        return {
          op: "register-err",
          reason: `ip ${req.requestedIp} is held by ${ipHolder.name}`,
        };
      }
      if (!this.allocator.acceptRequested(req.requestedIp)) {
        return { op: "register-err", reason: `ip ${req.requestedIp} is out of range` };
      }
      ip = req.requestedIp;
    } else {
      ip = this.allocator.nextFree();
      if (!ip) {
        return { op: "register-err", reason: "registry IP pool exhausted" };
      }
    }

    const now = new Date().toISOString();
    const record: RegistryRecord = {
      userid: req.userid,
      name: req.name,
      virtualIp: ip,
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
      // Carry forward whichever address we have. Newer clients send
      // their full Carrier address (with nospam + checksum); older
      // ones may not, in which case we preserve any previously-stored
      // value so the roster doesn't lose it on re-registration.
      address: req.address ?? existing?.address,
    };
    this.store.put(record);
    this.log(`register: ${record.name} (${record.userid.slice(0, 12)}...) -> ${record.virtualIp}`);
    return { op: "register-ok", record };
  }

  private handleLookup(
    req: Extract<RegistryRequest, { op: "lookup" }>
  ): RegistryResponse {
    let record: RegistryRecord | null;
    switch (req.by) {
      case "userid":
        record = this.store.get(req.value);
        break;
      case "name":
        record = this.store.findByName(req.value);
        break;
      case "ip":
        record = this.store.findByIp(req.value);
        break;
      default:
        return { op: "lookup-err", reason: `unknown lookup key '${(req as { by: string }).by}'` };
    }
    if (!record) {
      return { op: "lookup-err", reason: `no record for ${req.by}='${req.value}'` };
    }
    return { op: "lookup-ok", record };
  }

  private log(msg: string): void {
    if (this.verbose) console.log(`[registry] ${msg}`);
  }
}
