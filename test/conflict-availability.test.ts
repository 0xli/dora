/**
 * Duplicate-address protection and the sibling availability record.
 *
 * Segments exist so two registries never hand out the same address. When
 * that guarantee is broken anyway — overlapping ranges, a registry rebuilt
 * from a stale roster — the duplicate must be refused and reported, because
 * routing to an address two identities claim reaches the wrong machine half
 * the time and looks like packet loss rather than a config error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RegistryStore } from "../src/store.js";
import { AvailabilityLog } from "../src/availability.js";
import type { RegistryRecord } from "../src/types.js";

let dir: string;
let store: RegistryStore;

const rec = (userid: string, name: string, virtualIp: string): RegistryRecord => ({
  userid,
  name,
  virtualIp,
  registeredAt: new Date().toISOString(),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dora-conf-"));
  store = new RegistryStore(join(dir, "roster.yaml"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("duplicate address protection", () => {
  it("refuses a replica claiming an address another identity already holds", () => {
    store.put(rec("callpass", "callpass", "10.86.1.17"));
    const { merged, conflicts } = store.putReplicatedBatch(
      [rec("impostor", "someone-else", "10.86.1.17")],
      "sibA"
    );
    expect(merged).toBe(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      virtualIp: "10.86.1.17",
      heldBy: "callpass",
      claimedBy: "impostor",
      source: "sibA",
    });
    // The live mapping is untouched.
    expect(store.get("callpass")!.virtualIp).toBe("10.86.1.17");
    expect(store.get("impostor")).toBeNull();
  });

  it("a record keeping its own address is not a conflict", () => {
    store.putReplicatedBatch([rec("u1", "peer", "10.86.70.5")], "sibA");
    const { merged, conflicts } = store.putReplicatedBatch([rec("u1", "peer", "10.86.70.5")], "sibA");
    expect(conflicts).toHaveLength(0);
    expect(merged).toBe(1);
  });

  it("finds duplicates already sitting in the roster", () => {
    // Pre-dates the guards: two identities persisted on one address.
    store.put(rec("a", "node-a", "10.86.1.20"));
    store.put(rec("b", "node-b", "10.86.1.20"));
    const found = store.findIpConflicts();
    expect(found).toHaveLength(1);
    expect(found[0]!.virtualIp).toBe("10.86.1.20");
  });

  it("reports nothing for a clean roster", () => {
    store.put(rec("a", "node-a", "10.86.1.20"));
    store.put(rec("b", "node-b", "10.86.1.21"));
    expect(store.findIpConflicts()).toEqual([]);
  });
});

describe("sibling availability record", () => {
  const file = (): string => join(dir, "avail.yaml");

  it("credits wall-clock time to the state it was observed in", () => {
    const log = new AvailabilityLog(file());
    const t0 = 1_000_000;
    log.record("sibA", true, "beagle", t0);
    log.record("sibA", true, "beagle", t0 + 60_000); // 60s up
    log.record("sibA", false, "beagle", t0 + 120_000); // +60s still counted up
    log.record("sibA", false, "beagle", t0 + 180_000); // 60s down

    const e = log.get("sibA")!;
    expect(e.upMs).toBe(120_000);
    expect(e.downMs).toBe(60_000);
    expect(log.uptimeRatio("sibA")).toBeCloseTo(2 / 3, 5);
  });

  it("counts outages, so a flapping registry can't hide behind a ratio", () => {
    const log = new AvailabilityLog(file());
    let t = 1_000_000;
    for (const up of [true, false, true, false, true]) {
      log.record("sibA", up, "beagle", (t += 30_000));
    }
    const e = log.get("sibA")!;
    expect(e.outages).toBe(2); // two up→down transitions
    expect(e.probes).toBe(5);
    expect(e.failures).toBe(2);
  });

  it("remembers when a registry last actually answered", () => {
    const log = new AvailabilityLog(file());
    const t0 = 1_000_000;
    log.record("sibA", true, "beagle", t0);
    log.record("sibA", false, "beagle", t0 + 60_000);
    log.record("sibA", false, "beagle", t0 + 120_000);
    expect(log.get("sibA")!.lastUpAt).toBe(new Date(t0).toISOString());
    expect(log.get("sibA")!.up).toBe(false);
  });

  it("survives a restart", () => {
    const log = new AvailabilityLog(file());
    const t0 = 1_000_000;
    log.record("sibA", true, "beagle", t0);
    log.record("sibA", true, "beagle", t0 + 60_000);

    const reloaded = new AvailabilityLog(file());
    expect(reloaded.get("sibA")!.upMs).toBe(60_000);
    expect(reloaded.get("sibA")!.name).toBe("beagle");
  });

  it("has no uptime figure before it has seen an interval", () => {
    const log = new AvailabilityLog(file());
    log.record("sibA", true, "beagle", 1_000_000);
    expect(log.uptimeRatio("sibA")).toBeNull();
  });
});
