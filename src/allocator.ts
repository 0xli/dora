/**
 * IP allocation policy for the registry.
 *
 * v0.1 is intentionally dumb: walk a configured range and return the
 * first free address. The subnet is small enough (a /24 ≈ 254 hosts)
 * that linear scan costs nothing.
 */

import type { RegistryStore } from "./store.js";

export interface AllocatorOptions {
  /** Default `10.86.1.0` — the first /24 of the agentnet subnet,
   *  reserved for general allocation. `10.86.0.0/24` is held for
   *  the registry node itself + future infrastructure. */
  rangeStart?: string;
  /** Default `10.86.254.254`. */
  rangeEnd?: string;
}

export class IpAllocator {
  private start: number;
  private end: number;
  private store: RegistryStore;

  constructor(store: RegistryStore, opts: AllocatorOptions = {}) {
    this.store = store;
    this.start = ipToNum(opts.rangeStart ?? "10.86.1.10");
    this.end = ipToNum(opts.rangeEnd ?? "10.86.254.254");
  }

  /** The band we claim, as `<start>-<end>`. Advertised to siblings so an
   *  overlapping federation is detectable instead of silently handing two
   *  nodes the same virtual IP. */
  segment(): string {
    return `${numToIp(this.start)}-${numToIp(this.end)}`;
  }

  /** True when the two bands intersect — i.e. both registries would allocate
   *  from some of the same addresses. */
  overlaps(segment: string): boolean {
    const [a, b] = segment.split("-");
    if (!a || !b) return false;
    const start = ipToNum(a.trim());
    const end = ipToNum(b.trim());
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return this.start <= end && start <= this.end;
  }

  /** True when `ip` falls inside THIS registry's own segment, i.e. we are the
   *  authority for it. Replication uses this to refuse copies of records we
   *  own — a sibling's stale view must never shadow our live allocation. */
  ownsIp(ip: string): boolean {
    const n = ipToNum(ip);
    return Number.isFinite(n) && n >= this.start && n <= this.end;
  }

  /** Confirm the caller's requested IP is free AND within THIS registry's own
   *  range; otherwise reject so the client walks to the owning registry.
   *
   *  Was checking the whole /16 (10.86.0.0–255.254), so every dora accepted any
   *  10.86.x request. Effect: a node registered with whichever dora it reached
   *  first — not the one that owns its IP range — scattering registrations
   *  across the federation. Since clients discover a peer only by pulling the
   *  dora it registered with, two nodes on different (arbitrary) doras couldn't
   *  see each other's virtual IP even while Carrier-connected (observed:
   *  mac-dev on dora-mac, node-6232 on dora-tokyo — friends, but no L3). */
  acceptRequested(ip: string): boolean {
    if (this.store.findByIp(ip)) return false;
    const n = ipToNum(ip);
    return n >= this.start && n <= this.end;
  }

  /** Walk the range and return the first IP that isn't already in
   *  the store. Returns null if the range is exhausted. */
  nextFree(): string | null {
    for (let n = this.start; n <= this.end; n++) {
      const ip = numToIp(n);
      if (!this.store.findByIp(ip)) return ip;
    }
    return null;
  }
}

function ipToNum(ip: string): number {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function numToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join(".");
}
