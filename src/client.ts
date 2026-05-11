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
