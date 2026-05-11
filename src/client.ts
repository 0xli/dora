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
  /** Userid of the registry node — set by the operator in config.yaml. */
  registryUserid: string;
  /** Send a text message to a Carrier peer. Decentlan supplies this. */
  sendText: (toUserid: string, text: string) => Promise<void>;
  /** Subscribe to incoming text messages. Decentlan supplies this. */
  onText: (handler: (fromUserid: string, text: string) => void) => void;
  /** How long to wait for the registry to reply. Default 15s. */
  timeoutMs?: number;
}

export class RegistryClient {
  private opts: RegistryClientOptions;
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
      if (fromUserid !== this.opts.registryUserid) return;
      const decoded = decode(text);
      if (!decoded) return;
      // Match the response to whichever pending request is waiting.
      // V0.1 doesn't include correlation IDs — we assume at most one
      // pending request at a time per op type. Sufficient for the
      // current call sites; revisit if we add overlapping queries.
      const key = (decoded as RegistryResponse).op.replace(/-ok|-err/, "");
      const waiter = this.pending.get(key);
      if (waiter) {
        this.pending.delete(key);
        waiter(decoded as RegistryResponse);
      }
    });
  }

  async register(opts: {
    userid: string;
    name: string;
    requestedIp?: string;
    replace?: boolean;
  }): Promise<RegistryRecord> {
    const res = await this.exchange({
      op: "register",
      userid: opts.userid,
      name: opts.name,
      requestedIp: opts.requestedIp,
      replace: opts.replace,
    });
    if (res.op === "register-ok") return res.record;
    if (res.op === "register-err") throw new Error(`register failed: ${res.reason}`);
    throw new Error(`unexpected response op: ${res.op}`);
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
    const res = await this.exchange({ op: "list" });
    if (res.op === "list-ok") return res.records;
    if (res.op === "list-err") throw new Error(`list failed: ${res.reason}`);
    throw new Error(`unexpected response op: ${res.op}`);
  }

  private async exchange(req: RegistryRequest): Promise<RegistryResponse> {
    this.ensureSubscribed();
    const key = req.op;
    const timeoutMs = this.opts.timeoutMs ?? 15000;

    return new Promise<RegistryResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`registry ${req.op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(key, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      this.opts
        .sendText(this.opts.registryUserid, encode(req))
        .catch((err) => {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(err);
        });
    });
  }
}
