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

  /** Confirm the caller's requested IP is free; on conflict, return null. */
  acceptRequested(ip: string): boolean {
    if (this.store.findByIp(ip)) return false;
    const n = ipToNum(ip);
    return n >= ipToNum("10.86.0.0") && n <= ipToNum("10.86.255.254");
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
