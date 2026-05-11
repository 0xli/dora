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
