/**
 * Registry client — used by decentlan daemons to talk to the registry.
 *
 * Design intent: this module is the ONE place decentlan imports from
 * decent-registry. It hides the Carrier text-message dance behind a
 * Promise-based API and is the seam where caching, retries, and
 * fallbacks live.
 *
 * Not implementing the actual Carrier send/receive here yet — the
 * decentlan side will provide a `sendText` / `onText` adapter to keep
 * this module SDK-agnostic and testable in isolation.
 */

import {
  decode,
  encode,
  type RegistryRequest,
  type RegistryResponse,
  type RegistryRecord,
} from "./types.js";

export interface RegistryClientOptions {
  /** Userids of registries to try, in order. Same role as Carrier's
   *  bootstrap-node list: addressed by userid only, first responder
   *  wins, can be multiple for hot-standby / regional pairs. Empty
   *  list = caller will rely on the fallback (`randomIpInSubnet`). */
  registryUserids: string[];
  /** Send a text message to a Carrier peer. Decentlan supplies this. */
  sendText: (toUserid: string, text: string) => Promise<void>;
  /** Subscribe to incoming text messages. Decentlan supplies this. */
  onText: (handler: (fromUserid: string, text: string) => void) => void;
  /** How long to wait for each registry to reply before trying the next.
   *  Default 10s. The total timeout per RPC is N * timeoutMs in the
   *  worst case (all registries unreachable). */
  timeoutMs?: number;
}

export class RegistryClient {
  private opts: RegistryClientOptions;
  /** Pending request lookup, keyed by `${registryUserid}|${opKey}`.
   *  The op key strips `-ok` / `-err` so request and response match. */
  private pending: Map<string, (res: RegistryResponse) => void> = new Map();
  private subscribed = false;

  constructor(opts: RegistryClientOptions) {
    this.opts = opts;
  }

  /** Wire up the incoming-text handler. Idempotent. */
  ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.opts.onText((fromUserid, text) => {
      // Only consider responses from one of our configured registries.
      if (!this.opts.registryUserids.includes(fromUserid)) return;
      const decoded = decode(text);
      if (!decoded) return;
      const opKey = (decoded as RegistryResponse).op.replace(/-ok|-err/, "");
      const waiter = this.pending.get(`${fromUserid}|${opKey}`);
      if (waiter) {
        this.pending.delete(`${fromUserid}|${opKey}`);
        waiter(decoded as RegistryResponse);
      }
    });
  }

  async register(opts: {
    userid: string;
    name: string;
    /** Full Carrier address with nospam + checksum. Needed so other
     *  peers fetched from `list()` can be sent a friend-request. */
    address?: string;
    requestedIp?: string;
    replace?: boolean;
  }): Promise<RegistryRecord> {
    this.ensureSubscribed();
    const timeoutMs = this.opts.timeoutMs ?? 10000;
    const userids = this.opts.registryUserids;
    if (userids.length === 0) {
      throw new AllRegistriesUnavailableError("no registry userids configured");
    }
    const req: RegistryRequest = {
      op: "register",
      userid: opts.userid,
      name: opts.name,
      address: opts.address,
      requestedIp: opts.requestedIp,
      replace: opts.replace,
    };

    // Federated registries each allocate from a NON-OVERLAPPING segment.
    // A fixed requestedIp (e.g. a node's stable config IP) is only valid for
    // the ONE registry that owns its segment — every other registry answers
    // "ip … is out of range". The generic exchange() returns the FIRST
    // response, so if a sibling registry replied first the register failed
    // and the node fell back to its (now unregistered) config IP, dropping
    // all traffic to peers it never learned from the roster. Instead, walk
    // the registries and treat an out-of-range rejection as "wrong segment,
    // try the next one" — so the request reaches the registry that owns the
    // IP and the node keeps its stable address. A NON-range rejection (IP
    // collision / name taken) is definitive: we reached the owning registry
    // and the slot is genuinely unavailable, so surface it immediately.
    const transportErrors: string[] = [];
    let lastRangeRejection: string | undefined;
    for (const registryUserid of userids) {
      let res: RegistryResponse;
      try {
        res = await this.exchangeOne(req, registryUserid, timeoutMs);
      } catch (err) {
        transportErrors.push(`${registryUserid.slice(0, 12)}...: ${(err as Error).message}`);
        continue;
      }
      if (res.op === "register-ok") return res.record;
      if (res.op === "register-err") {
        if (/out of range/i.test(res.reason)) {
          lastRangeRejection = res.reason;
          continue; // wrong segment — ask a sibling registry
        }
        throw new Error(`register failed: ${res.reason}`);
      }
      throw new Error(`unexpected response op: ${res.op}`);
    }
    // No registry accepted the IP. If at least one reached us and said
    // out-of-range, that's the meaningful error (the requested IP belongs to
    // no live segment); otherwise every registry was unreachable.
    if (lastRangeRejection !== undefined) {
      throw new Error(`register failed: ${lastRangeRejection}`);
    }
    throw new AllRegistriesUnavailableError(
      `all ${userids.length} registries unreachable: ${transportErrors.join("; ")}`
    );
  }

  async lookup(opts: {
    by: "userid" | "name" | "ip";
    value: string;
  }): Promise<RegistryRecord | null> {
    const res = await this.exchange({
      op: "lookup",
      by: opts.by,
      value: opts.value,
    });
    if (res.op === "lookup-ok") return res.record;
    if (res.op === "lookup-err") return null; // not-found is not an exception
    throw new Error(`unexpected response op: ${res.op}`);
  }

  async list(): Promise<RegistryRecord[]> {
    // Query EVERY configured registry and MERGE their rosters — do NOT return
    // just the first responder (the old behaviour, via exchange()).
    //
    // Federated doras each own a DISJOINT segment of the address space and only
    // hold the peers registered in their own segment. So a client that reads one
    // dora sees only one slice of the network: mac-dev (registered with dora-mac)
    // and node-6232 (registered with dora-tokyo) end up Carrier-friends yet never
    // learn each other's virtual IP, because whichever dora answered first didn't
    // hold the other peer's record. The whole point of the federation is that the
    // client stitches the segments back together — that stitching happens HERE.
    //
    // Fault tolerance is the same property the operator asked for: as long as ONE
    // dora answers, its peers are visible; a down dora only hides the peers that
    // registered exclusively with it, never the rest. We throw only when EVERY
    // dora is unreachable (so the caller keeps its last-known IPAM instead of
    // wiping it). Queried concurrently so one slow/dead dora doesn't add its full
    // timeout to the others — a sequential walk over 4 doras with a 30s timeout
    // could stall the 60s refresh for two minutes.
    this.ensureSubscribed();
    const timeoutMs = this.opts.timeoutMs ?? 10000;
    const userids = this.opts.registryUserids;
    if (userids.length === 0) {
      throw new AllRegistriesUnavailableError("no registry userids configured");
    }
    const results = await Promise.allSettled(
      userids.map((id) => this.listOne(id, timeoutMs))
    );
    // Merge, deduping by userid. First dora to report a userid wins; with
    // disjoint segments there's no overlap, but a peer that re-registered across
    // a segment boundary (or a misconfigured dora) can't produce a duplicate.
    const byUserid = new Map<string, RegistryRecord>();
    const errors: string[] = [];
    let anyOk = false;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") {
        anyOk = true;
        for (const rec of r.value) {
          if (!byUserid.has(rec.userid)) byUserid.set(rec.userid, rec);
        }
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        errors.push(`${userids[i]!.slice(0, 12)}...: ${reason}`);
      }
    }
    if (!anyOk) {
      throw new AllRegistriesUnavailableError(
        `all ${userids.length} registries unreachable: ${errors.join("; ")}`
      );
    }
    return [...byUserid.values()];
  }

  /** Page through ONE registry's roster and return all of its records.
   *  A large roster exceeds Carrier's ~1372-byte text-message limit in one
   *  reply, so the server returns a bounded page + the full `total`, and we
   *  keep requesting the next offset until we've collected them all. Old
   *  servers omit `total` (and ignore `offset`) → the first reply is the whole
   *  roster and the loop exits after one round. A safety cap stops a
   *  misbehaving server from looping forever. Throws on transport failure /
   *  server error so the caller (list) can record it as one dora being down. */
  private async listOne(
    registryUserid: string,
    timeoutMs: number
  ): Promise<RegistryRecord[]> {
    const collected: RegistryRecord[] = [];
    let offset = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const res = await this.exchangeOne({ op: "list", offset }, registryUserid, timeoutMs);
      if (res.op === "list-err") throw new Error(`list failed: ${res.reason}`);
      if (res.op !== "list-ok") throw new Error(`unexpected response op: ${res.op}`);
      collected.push(...res.records);
      const total = res.total;
      // No total (old server) or we've got everything, or the server
      // returned an empty page (nothing more) → done.
      if (total === undefined || collected.length >= total || res.records.length === 0) {
        break;
      }
      offset = collected.length;
    }
    return collected;
  }

  /** Try each configured registry in order; return the first response.
   *  Throws AllRegistriesUnavailableError only when every registry
   *  either fails to send or times out. */
  private async exchange(req: RegistryRequest): Promise<RegistryResponse> {
    this.ensureSubscribed();
    const timeoutMs = this.opts.timeoutMs ?? 10000;
    const userids = this.opts.registryUserids;
    if (userids.length === 0) {
      throw new AllRegistriesUnavailableError("no registry userids configured");
    }

    const errors: string[] = [];
    for (const registryUserid of userids) {
      try {
        return await this.exchangeOne(req, registryUserid, timeoutMs);
      } catch (err) {
        errors.push(`${registryUserid.slice(0, 12)}...: ${(err as Error).message}`);
      }
    }
    throw new AllRegistriesUnavailableError(
      `all ${userids.length} registries unreachable: ${errors.join("; ")}`
    );
  }

  private exchangeOne(
    req: RegistryRequest,
    registryUserid: string,
    timeoutMs: number
  ): Promise<RegistryResponse> {
    const opKey = req.op;
    const pendingKey = `${registryUserid}|${opKey}`;
    return new Promise<RegistryResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(pendingKey, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      this.opts.sendText(registryUserid, encode(req)).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(pendingKey);
        reject(err);
      });
    });
  }
}

/** Thrown when none of the configured registries answered. Callers
 *  catch this to know they should fall back to local self-assignment
 *  (e.g. `randomIpInSubnet`). */
export class AllRegistriesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllRegistriesUnavailableError";
  }
}

/**
 * Pick a random IP from a subnet for the fallback path. The first /24
 * is reserved for infrastructure (registry node, future use), and the
 * subnet's `.0`/`.255` boundaries are skipped.
 *
 * Decentlan should call this when `AllRegistriesUnavailableError`
 * comes back from the client and the daemon has no cached IP yet.
 * The chosen IP should be persisted locally so a restart picks the
 * same one — otherwise a flapping registry causes IP churn.
 */
export function randomIpInSubnet(
  subnetCidr: string = "10.86.0.0/16",
  reservedFirstSlashTwentyFour: boolean = true
): string {
  const [base, prefixStr] = subnetCidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  const [a, b, c, d] = base.split(".").map((p) => parseInt(p, 10));
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`invalid subnet: ${subnetCidr}`);
  }
  if (prefix !== 16) {
    // Only /16 is implemented in v0.1; sufficient for decentlan's 10.86.0.0/16.
    throw new Error(`only /16 subnets supported in v0.1, got /${prefix}`);
  }
  // Avoid .0 and .255 in each variable octet, and skip the first /24.
  const minOctet3 = reservedFirstSlashTwentyFour ? 1 : 0;
  const o3 = minOctet3 + Math.floor(Math.random() * (255 - minOctet3));
  const o4 = 1 + Math.floor(Math.random() * 254);
  return `${a}.${b}.${o3}.${o4}`;
  // Intentionally ignores the literal base[2] and base[3] — for a /16,
  // those bits are assigned-from, not part of the subnet identifier.
}
