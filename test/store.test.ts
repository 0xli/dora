import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RegistryStore } from "../src/store.js";

function fresh(): { store: RegistryStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
  const path = join(dir, "roster.yaml");
  return { store: new RegistryStore(path), path };
}

describe("RegistryStore", () => {
  let store: RegistryStore;
  let path: string;

  beforeEach(() => {
    ({ store, path } = fresh());
  });

  it("starts empty when the roster file doesn't exist", () => {
    expect(store.list()).toEqual([]);
    expect(store.get("u1")).toBeNull();
  });

  it("persists to YAML on put and reads it back on reload", () => {
    store.put({
      userid: "u1",
      name: "host1",
      virtualIp: "10.86.1.10",
      registeredAt: "2026-05-10T00:00:00Z",
    });
    const reloaded = new RegistryStore(path);
    expect(reloaded.get("u1")?.name).toBe("host1");
    expect(reloaded.get("u1")?.virtualIp).toBe("10.86.1.10");
  });

  it("indexes by name and ip", () => {
    store.put({
      userid: "u1",
      name: "host1",
      virtualIp: "10.86.1.10",
      registeredAt: "2026-05-10T00:00:00Z",
    });
    expect(store.findByName("host1")?.userid).toBe("u1");
    expect(store.findByIp("10.86.1.10")?.userid).toBe("u1");
    expect(store.findByName("nope")).toBeNull();
    expect(store.findByIp("10.86.99.99")).toBeNull();
  });

  it("updates lastSeenAt on touch and persists", () => {
    store.put({
      userid: "u1",
      name: "host1",
      virtualIp: "10.86.1.10",
      registeredAt: "2026-05-10T00:00:00Z",
    });
    const before = store.get("u1")!.lastSeenAt;
    store.touch("u1");
    const after = store.get("u1")!.lastSeenAt;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    // Persisted:
    expect(readFileSync(path, "utf-8")).toContain("lastSeenAt");
  });

  it("touch is a no-op for unknown userid", () => {
    expect(() => store.touch("unknown")).not.toThrow();
  });

  it("remove() reports correctly", () => {
    store.put({
      userid: "u1",
      name: "host1",
      virtualIp: "10.86.1.10",
      registeredAt: "2026-05-10T00:00:00Z",
    });
    expect(store.remove("u1")).toBe(true);
    expect(store.remove("u1")).toBe(false);
    expect(store.get("u1")).toBeNull();
  });
});
