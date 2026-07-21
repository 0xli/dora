/**
 * In-memory registry with YAML persistence.
 *
 * The roster is small (dozens of records for a typical friend network),
 * so we keep the whole thing in memory and rewrite the file on each
 * mutation. No incremental writes, no compaction, no journal.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import yaml from "js-yaml";
import type { RegistryRecord } from "./types.js";

interface StoredRoster {
  records: RegistryRecord[];
}

/** Two identities claiming one virtual IP. Routing to it is a coin flip, so
 *  the duplicate is always refused and surfaced rather than applied. */
export interface IpConflict {
  virtualIp: string;
  heldBy: string;
  heldByName: string;
  claimedBy: string;
  claimedByName: string;
  /** Sibling userid the losing claim arrived from, or "local". */
  source: string;
}

export class RegistryStore {
  private records: Map<string, RegistryRecord> = new Map(); // keyed by userid
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    let content: string;
    try {
      content = readFileSync(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First run — empty roster.
        return;
      }
      throw err;
    }
    const parsed = yaml.load(content) as StoredRoster | null;
    if (!parsed || !Array.isArray(parsed.records)) return;
    for (const r of parsed.records) {
      this.records.set(r.userid, r);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const out: StoredRoster = { records: [...this.records.values()] };
    writeFileSync(this.filePath, yaml.dump(out, { lineWidth: -1 }), "utf-8");
  }

  get(userid: string): RegistryRecord | null {
    return this.records.get(userid) ?? null;
  }

  findByName(name: string): RegistryRecord | null {
    for (const r of this.records.values()) if (r.name === name) return r;
    return null;
  }

  findByIp(ip: string): RegistryRecord | null {
    for (const r of this.records.values()) if (r.virtualIp === ip) return r;
    return null;
  }

  list(): RegistryRecord[] {
    return [...this.records.values()];
  }

  /** Atomic upsert + persist. Caller is responsible for collision checks. */
  put(record: RegistryRecord): void {
    this.records.set(record.userid, record);
    this.persist();
  }

  /** Records this registry owns (no `replicatedFrom`) — the ones it is
   *  authoritative for and the only ones a sibling may replicate. */
  listOwned(): RegistryRecord[] {
    return [...this.records.values()].filter((r) => !r.replicatedFrom);
  }

  /**
   * Merge a batch of records pulled from a sibling registry.
   *
   * Rules that keep replication safe:
   *  - An OWNED record is never overwritten by a replica. We are the
   *    authority for our own segment; a sibling's stale copy must not
   *    clobber it.
   *  - A replica is only refreshed by the sibling it came from, so two
   *    siblings can't fight over the same record.
   *  - `skip` lets the caller drop records it is authoritative for
   *    (its own IP range) before they ever enter the store.
   *
   * One persist for the whole batch — not one per record.
   * Returns how many records were added or refreshed.
   */
  putReplicatedBatch(
    records: RegistryRecord[],
    fromUserid: string,
    skip: (rec: RegistryRecord) => boolean = () => false
  ): { merged: number; conflicts: IpConflict[] } {
    const now = new Date().toISOString();
    let merged = 0;
    const conflicts: IpConflict[] = [];
    for (const rec of records) {
      if (!rec?.userid || skip(rec)) continue;
      const existing = this.records.get(rec.userid);
      // Never let a replica shadow a record we own.
      if (existing && !existing.replicatedFrom) continue;
      // Only the sibling that supplied a replica may refresh it.
      if (existing?.replicatedFrom && existing.replicatedFrom !== fromUserid) continue;
      // Two identities on one address is the failure the segment split exists
      // to prevent; if it still happens (overlapping ranges, a registry
      // rebuilt from a stale roster) the duplicate must be refused and
      // reported rather than silently overwriting a live mapping — whoever
      // routes to that IP would otherwise reach the wrong machine.
      const holder = this.findByIp(rec.virtualIp);
      if (holder && holder.userid !== rec.userid) {
        conflicts.push({
          virtualIp: rec.virtualIp,
          heldBy: holder.userid,
          heldByName: holder.name,
          claimedBy: rec.userid,
          claimedByName: rec.name,
          source: fromUserid,
        });
        continue;
      }
      this.records.set(rec.userid, {
        ...rec,
        replicatedFrom: fromUserid,
        replicatedAt: now,
      });
      merged++;
    }
    if (merged) this.persist();
    return { merged, conflicts };
  }

  /** Every address currently claimed by more than one identity. Should always
   *  be empty; a non-empty result means routing to those IPs is ambiguous. */
  findIpConflicts(): IpConflict[] {
    const byIp = new Map<string, RegistryRecord[]>();
    for (const r of this.records.values()) {
      const list = byIp.get(r.virtualIp);
      if (list) list.push(r);
      else byIp.set(r.virtualIp, [r]);
    }
    const out: IpConflict[] = [];
    for (const [ip, list] of byIp) {
      if (list.length < 2) continue;
      const [first, ...rest] = list as [RegistryRecord, ...RegistryRecord[]];
      for (const other of rest) {
        out.push({
          virtualIp: ip,
          heldBy: first.userid,
          heldByName: first.name,
          claimedBy: other.userid,
          claimedByName: other.name,
          source: other.replicatedFrom ?? "local",
        });
      }
    }
    return out;
  }

  /**
   * Drop replicas not re-asserted within `ttlMs`. This is what makes a
   * replica soft state: when the owning registry goes away (or simply
   * stops publishing a record) the copies fade instead of becoming
   * immortal zombies that answer with long-dead IPs. Owned records are
   * never pruned here. Returns how many were dropped.
   */
  pruneStaleReplicas(ttlMs: number, now: number = Date.now()): number {
    let dropped = 0;
    for (const [userid, r] of this.records) {
      if (!r.replicatedFrom) continue;
      const at = r.replicatedAt ? Date.parse(r.replicatedAt) : 0;
      if (!Number.isFinite(at) || now - at > ttlMs) {
        this.records.delete(userid);
        dropped++;
      }
    }
    if (dropped) this.persist();
    return dropped;
  }

  /** Returns true if a record was removed. */
  remove(userid: string): boolean {
    const ok = this.records.delete(userid);
    if (ok) this.persist();
    return ok;
  }

  /** Mark a record as recently seen (heartbeat). Persists asynchronously
   *  via a debounced flush would be nicer, but for v0.1 every write is
   *  immediate. */
  touch(userid: string): void {
    const r = this.records.get(userid);
    if (!r) return;
    r.lastSeenAt = new Date().toISOString();
    this.persist();
  }
}
