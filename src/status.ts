/**
 * Registry status — what this dora knows about the network, as data.
 *
 * The federation was operated blind: which registries were answering, how
 * much of a band was spoken for, whether two identities were fighting over
 * an address — all of it had to be reconstructed by hand from ssh + YAML.
 * That is why an overlap went unnoticed until nodes collided. This assembles
 * the same picture in one place so it can be read at a glance and served
 * over HTTP.
 */

import type { RegistryStore, IpConflict } from "./store.js";
import type { IpAllocator } from "./allocator.js";
import type { AvailabilityLog, SiblingAvailability } from "./availability.js";
import type { RegistryRecord } from "./types.js";

export interface RegistryStatus {
  self: {
    userid: string;
    address: string;
    name?: string;
    segment: string;
    capacity: number;
    /** Records we are authoritative for AND that fall inside our band. */
    used: number;
    usedPct: number;
    /** Held with an owned flag but outside our band — legacy of the old
     *  whole-/16 default. Not vouched for, not replicated out. */
    outOfBand: number;
    replicasHeld: number;
    startedAt: string;
    uptimeMs: number;
  };
  siblings: Array<
    SiblingAvailability & {
      uptimeRatio: number | null;
      /** Records in the roster that came from this sibling. */
      recordsFrom: number;
    }
  >;
  /** Every record this registry can answer for, own or replicated. */
  records: Array<
    Pick<RegistryRecord, "userid" | "name" | "virtualIp" | "registeredAt" | "lastSeenAt"> & {
      origin: "self" | "replica" | "out-of-band";
      replicatedFrom?: string;
    }
  >;
  conflicts: IpConflict[];
  /** Coverage per /16 band, so it is obvious at a glance whether a band
   *  would still resolve if its owner went down. */
  coverage: Array<{ band: string; records: number; fromSelf: boolean }>;
  generatedAt: string;
}

const BANDS: Array<{ name: string; lo: number; hi: number }> = [
  { name: "10.86.1-63 (dora-mac)", lo: 1, hi: 63 },
  { name: "10.86.64-127 (dora-beagle)", lo: 64, hi: 127 },
  { name: "10.86.128-191 (dora-sh)", lo: 128, hi: 191 },
  { name: "10.86.192-254 (dora-tokyo)", lo: 192, hi: 254 },
];

const thirdOctet = (ip: string): number => Number(ip.split(".")[2] ?? -1);

export function buildStatus(opts: {
  store: RegistryStore;
  allocator: IpAllocator;
  availability: AvailabilityLog | null;
  userid: string;
  address: string;
  name?: string;
  startedAt: number;
  siblingNames?: Map<string, string>;
}): RegistryStatus {
  const { store, allocator, availability } = opts;
  const all = store.list();
  const owned = all.filter((r) => !r.replicatedFrom);
  const inBand = owned.filter((r) => allocator.ownsIp(r.virtualIp));
  const capacity = allocator.capacity();

  const recordsFrom = new Map<string, number>();
  for (const r of all) {
    if (!r.replicatedFrom) continue;
    recordsFrom.set(r.replicatedFrom, (recordsFrom.get(r.replicatedFrom) ?? 0) + 1);
  }

  return {
    self: {
      userid: opts.userid,
      address: opts.address,
      name: opts.name,
      segment: allocator.segment(),
      capacity,
      used: inBand.length,
      usedPct: capacity > 0 ? (inBand.length / capacity) * 100 : 0,
      outOfBand: owned.length - inBand.length,
      replicasHeld: all.length - owned.length,
      startedAt: new Date(opts.startedAt).toISOString(),
      uptimeMs: Date.now() - opts.startedAt,
    },
    siblings: (availability?.list() ?? []).map((s) => ({
      ...s,
      name: s.name ?? opts.siblingNames?.get(s.userid),
      uptimeRatio: availability?.uptimeRatio(s.userid) ?? null,
      recordsFrom: recordsFrom.get(s.userid) ?? 0,
    })),
    records: all
      .map((r) => ({
        userid: r.userid,
        name: r.name,
        virtualIp: r.virtualIp,
        registeredAt: r.registeredAt,
        lastSeenAt: r.lastSeenAt,
        origin: r.replicatedFrom
          ? ("replica" as const)
          : allocator.ownsIp(r.virtualIp)
            ? ("self" as const)
            : ("out-of-band" as const),
        replicatedFrom: r.replicatedFrom,
      }))
      .sort((a, b) => thirdOctet(a.virtualIp) - thirdOctet(b.virtualIp)),
    conflicts: store.findIpConflicts(),
    coverage: BANDS.map((b) => {
      const records = all.filter((r) => {
        const o = thirdOctet(r.virtualIp);
        return o >= b.lo && o <= b.hi;
      }).length;
      return { band: b.name, records, fromSelf: allocator.ownsIp(`10.86.${b.lo}.10`) };
    }),
    generatedAt: new Date().toISOString(),
  };
}
