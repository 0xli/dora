/**
 * Registry server. Listens for incoming Carrier text messages with the
 * `DECENT_REGISTRY:` prefix and answers register/lookup/list operations.
 *
 * Identity: the registry IS a Carrier peer. Operators friend it the
 * same way they friend any decentlan node. The userid of the registry
 * is what clients put in their `registry.userid` config field.
 */

import { Peer } from "@decentnetwork/peer";
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
}

export class RegistryServer {
  private peer: Peer;
  private store: RegistryStore;
  private allocator: IpAllocator;
  private verbose: boolean;
  private isRunning = false;

  constructor(opts: RegistryServerOptions) {
    this.peer = opts.peer;
    this.store = opts.store;
    this.allocator = opts.allocator;
    this.verbose = opts.verbose ?? false;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.peer.onText((msg: { pubkey: string; text: string }) => {
      const req = decode(msg.text);
      if (!req) return; // not a registry message
      this.handle(msg.pubkey, req as RegistryRequest).catch((err) => {
        this.log(`error handling ${(req as RegistryRequest).op} from ${msg.pubkey.slice(0, 12)}: ${err}`);
      });
    });

    this.log("registry server started");
  }

  private async handle(fromUserid: string, req: RegistryRequest): Promise<void> {
    let response: RegistryResponse;

    switch (req.op) {
      case "register":
        response = this.handleRegister(fromUserid, req);
        break;
      case "lookup":
        response = this.handleLookup(req);
        break;
      case "list":
        response = { op: "list-ok", records: this.store.list() };
        break;
      default:
        // Future ops we don't know yet — silently ignore so old servers
        // don't reject newer clients.
        return;
    }

    try {
      await this.peer.sendText(fromUserid, encode(response));
    } catch (err) {
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
