/**
 * Sibling availability log.
 *
 * A federation is only as good as its least reliable member: a registry that
 * is usually unreachable still owns a segment nobody else can allocate from,
 * so its downtime is the network's downtime. Reachability is therefore
 * recorded rather than guessed — every sync round votes, transitions are
 * timestamped, and the accumulated uptime is what says whether a registry is
 * fit to keep holding a segment.
 *
 * Deliberately small: a current state, the moment it last changed, and
 * cumulative up/down milliseconds. No unbounded event history to rotate.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import yaml from "js-yaml";

export interface SiblingAvailability {
  userid: string;
  /** Label for logs, when known. */
  name?: string;
  /** Whether the last probe reached it. `null` before the first probe. */
  up: boolean | null;
  /** ISO 8601 of the last probe. */
  lastProbeAt?: string;
  /** ISO 8601 of the last up→down or down→up transition. */
  lastChangeAt?: string;
  /** ISO 8601 of the last successful probe — "when did this registry last
   *  actually answer", the question during an incident. */
  lastUpAt?: string;
  upMs: number;
  downMs: number;
  probes: number;
  failures: number;
  /** Number of up→down transitions; a registry that flaps is as unusable as
   *  one that is simply down, and a plain uptime ratio hides that. */
  outages: number;
}

interface StoredAvailability {
  siblings: SiblingAvailability[];
}

export class AvailabilityLog {
  private entries: Map<string, SiblingAvailability> = new Map();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    try {
      const parsed = yaml.load(readFileSync(this.filePath, "utf-8")) as StoredAvailability | null;
      for (const s of parsed?.siblings ?? []) if (s?.userid) this.entries.set(s.userid, s);
    } catch {
      // first run / unreadable — start empty
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const out: StoredAvailability = { siblings: [...this.entries.values()] };
    writeFileSync(this.filePath, yaml.dump(out, { lineWidth: -1 }), "utf-8");
  }

  /**
   * Record one probe. Time since the previous probe is credited to whichever
   * state we were in, so uptime reflects wall-clock rather than probe counts
   * (a registry down over a long gap should not look equal to one down for a
   * single round).
   *
   * Returns a transition string when the state flipped, for logging.
   */
  record(userid: string, up: boolean, name?: string, now: number = Date.now()): "up" | "down" | null {
    const nowIso = new Date(now).toISOString();
    let e = this.entries.get(userid);
    if (!e) {
      e = { userid, name, up: null, upMs: 0, downMs: 0, probes: 0, failures: 0, outages: 0 };
      this.entries.set(userid, e);
    }
    if (name) e.name = name;

    const prevAt = e.lastProbeAt ? Date.parse(e.lastProbeAt) : null;
    if (prevAt !== null && Number.isFinite(prevAt) && now > prevAt && e.up !== null) {
      const delta = now - prevAt;
      if (e.up) e.upMs += delta;
      else e.downMs += delta;
    }

    const changed = e.up !== null && e.up !== up;
    if (changed) {
      e.lastChangeAt = nowIso;
      if (!up) e.outages++;
    }
    if (e.up === null) e.lastChangeAt = nowIso;

    e.up = up;
    e.lastProbeAt = nowIso;
    e.probes++;
    if (up) e.lastUpAt = nowIso;
    else e.failures++;

    this.persist();
    return changed ? (up ? "up" : "down") : null;
  }

  get(userid: string): SiblingAvailability | null {
    return this.entries.get(userid) ?? null;
  }

  list(): SiblingAvailability[] {
    return [...this.entries.values()];
  }

  /** Uptime as a 0–1 ratio of observed wall-clock, or null before there are
   *  two probes to measure an interval between. */
  uptimeRatio(userid: string): number | null {
    const e = this.entries.get(userid);
    if (!e) return null;
    const total = e.upMs + e.downMs;
    return total > 0 ? e.upMs / total : null;
  }

  /** One line per sibling, for `dora availability` and incident triage. */
  summary(): string[] {
    return this.list().map((e) => {
      const ratio = this.uptimeRatio(e.userid);
      const pct = ratio === null ? "n/a" : `${(ratio * 100).toFixed(1)}%`;
      const state = e.up === null ? "unknown" : e.up ? "up" : "DOWN";
      return (
        `${(e.name ?? e.userid.slice(0, 12)).padEnd(14)} ${state.padEnd(7)} ` +
        `uptime=${pct.padStart(6)} probes=${e.probes} failures=${e.failures} ` +
        `outages=${e.outages} lastUp=${e.lastUpAt ?? "never"}`
      );
    });
  }
}
