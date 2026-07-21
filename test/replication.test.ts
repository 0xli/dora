/**
 * Cross-dora roster replication.
 *
 * Each dora is authoritative for one IP segment, so before replication a
 * dora going down blinded the whole network to that segment. Replication
 * lets every dora answer for the whole /16 — but only if it can't corrupt
 * the data it owns. These tests pin the rules that make that safe.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RegistryStore } from "../src/store.js";
import { IpAllocator } from "../src/allocator.js";
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
  dir = mkdtempSync(join(tmpdir(), "dora-repl-"));
  store = new RegistryStore(join(dir, "roster.yaml"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("replica merge", () => {
  it("adds a sibling's records and marks their origin", () => {
    const { merged: n } = store.putReplicatedBatch([rec("u1", "peer-a", "10.86.70.5")], "sibA");
    expect(n).toBe(1);
    const got = store.get("u1")!;
    expect(got.virtualIp).toBe("10.86.70.5");
    expect(got.replicatedFrom).toBe("sibA");
    expect(got.replicatedAt).toBeTruthy();
  });

  it("never lets a replica overwrite a record we own", () => {
    // We are authoritative for u1 at .17 — a sibling's stale .99 must lose.
    store.put(rec("u1", "callpass", "10.86.1.17"));
    const { merged: n } = store.putReplicatedBatch([rec("u1", "callpass", "10.86.1.99")], "sibA");
    expect(n).toBe(0);
    const got = store.get("u1")!;
    expect(got.virtualIp).toBe("10.86.1.17");
    expect(got.replicatedFrom).toBeUndefined();
  });

  it("skips records in our own segment via the skip predicate", () => {
    const alloc = new IpAllocator(store, { rangeStart: "10.86.1.10", rangeEnd: "10.86.63.254" });
    const { merged: n } = store.putReplicatedBatch(
      [rec("mine", "in-my-range", "10.86.1.20"), rec("theirs", "not-mine", "10.86.70.5")],
      "sibA",
      (r) => alloc.ownsIp(r.virtualIp)
    );
    expect(n).toBe(1);
    expect(store.get("mine")).toBeNull();
    expect(store.get("theirs")).not.toBeNull();
  });

  it("only the origin sibling can refresh a replica", () => {
    store.putReplicatedBatch([rec("u1", "peer-a", "10.86.70.5")], "sibA");
    // A different sibling must not hijack it — otherwise two siblings with
    // divergent views would flap the record on every sync round.
    const { merged: n } = store.putReplicatedBatch([rec("u1", "peer-a", "10.86.80.9")], "sibB");
    expect(n).toBe(0);
    expect(store.get("u1")!.virtualIp).toBe("10.86.70.5");
    // …but its own origin can.
    expect(store.putReplicatedBatch([rec("u1", "peer-a", "10.86.70.6")], "sibA").merged).toBe(1);
    expect(store.get("u1")!.virtualIp).toBe("10.86.70.6");
  });
});

describe("replica expiry", () => {
  it("prunes replicas past the TTL but keeps owned records", () => {
    store.put(rec("owned", "mine", "10.86.1.5"));
    store.putReplicatedBatch([rec("copy", "theirs", "10.86.70.5")], "sibA");

    // Nothing expires while fresh.
    expect(store.pruneStaleReplicas(15 * 60_000)).toBe(0);

    // A record the origin stopped publishing must fade instead of
    // answering with a long-dead IP forever.
    const later = Date.now() + 16 * 60_000;
    expect(store.pruneStaleReplicas(15 * 60_000, later)).toBe(1);
    expect(store.get("copy")).toBeNull();
    expect(store.get("owned")).not.toBeNull();
  });

  it("a fresh sync re-asserts a replica so a live record never expires", () => {
    store.putReplicatedBatch([rec("copy", "theirs", "10.86.70.5")], "sibA");
    const later = Date.now() + 16 * 60_000;
    // Origin still publishing it: the next round refreshes replicatedAt.
    store.putReplicatedBatch([rec("copy", "theirs", "10.86.70.5")], "sibA");
    expect(store.pruneStaleReplicas(15 * 60_000, later - 60_000)).toBe(0);
    expect(store.get("copy")).not.toBeNull();
  });
});

describe("authority split", () => {
  it("listOwned exposes only records we vouch for", () => {
    store.put(rec("owned", "mine", "10.86.1.5"));
    store.putReplicatedBatch([rec("copy", "theirs", "10.86.70.5")], "sibA");
    expect(store.listOwned().map((r) => r.userid)).toEqual(["owned"]);
    // list() still serves everything — that's the point of replicating.
    expect(store.list().length).toBe(2);
  });

  it("ownsIp draws the segment boundary", () => {
    const alloc = new IpAllocator(store, { rangeStart: "10.86.64.10", rangeEnd: "10.86.127.254" });
    expect(alloc.ownsIp("10.86.90.96")).toBe(true);
    expect(alloc.ownsIp("10.86.1.17")).toBe(false);
    expect(alloc.ownsIp("10.86.200.1")).toBe(false);
  });
});

describe("segment authority", () => {
  it("a dora only vouches for records inside its own segment", () => {
    // Mirrors the real roster: a dora that once ran with the default
    // whole-/16 range still holds records in other doras' segments.
    // It must not offer those to siblings as its own, or it could beat the
    // true segment owner to becoming their origin.
    const alloc = new IpAllocator(store, { rangeStart: "10.86.1.10", rangeEnd: "10.86.63.254" });
    store.put(rec("mine", "callpass", "10.86.1.17"));
    store.put(rec("legacy", "snoopy", "10.86.156.164")); // owned flag, wrong segment
    store.putReplicatedBatch([rec("copy", "gfax", "10.86.134.139")], "sibA");

    const vouched = (r: RegistryRecord): boolean =>
      !r.replicatedFrom && alloc.ownsIp(r.virtualIp);

    expect(store.list().filter(vouched).map((r) => r.userid)).toEqual(["mine"]);
  });
});

describe("segment overlap detection", () => {
  it("reports its own band and spots a sibling claiming part of it", () => {
    const beagle = new IpAllocator(store, { rangeStart: "10.86.64.10", rangeEnd: "10.86.127.254" });
    expect(beagle.segment()).toBe("10.86.64.10-10.86.127.254");

    // The federation's real split — no intersection.
    expect(beagle.overlaps("10.86.128.10-10.86.191.254")).toBe(false);
    expect(beagle.overlaps("10.86.1.10-10.86.63.254")).toBe(false);

    // The bug that actually shipped: a dora left on the whole-/16 default
    // swallows every sibling's band.
    expect(beagle.overlaps("10.86.1.10-10.86.254.254")).toBe(true);
    // Partial overlap at either edge counts too.
    expect(beagle.overlaps("10.86.100.0-10.86.200.0")).toBe(true);
    expect(beagle.overlaps("10.86.1.10-10.86.64.10")).toBe(true);
  });
});
