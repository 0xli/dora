import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RegistryStore } from "../src/store.js";
import { IpAllocator } from "../src/allocator.js";

function freshStore(): RegistryStore {
  const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
  return new RegistryStore(join(dir, "roster.yaml"));
}

describe("IpAllocator", () => {
  let store: RegistryStore;
  let alloc: IpAllocator;

  beforeEach(() => {
    store = freshStore();
    alloc = new IpAllocator(store, { rangeStart: "10.86.1.10" });
  });

  it("hands out the first address in range on a fresh store", () => {
    expect(alloc.nextFree()).toBe("10.86.1.10");
  });

  it("skips IPs already in the store", () => {
    store.put({
      userid: "u1",
      name: "host1",
      virtualIp: "10.86.1.10",
      registeredAt: new Date().toISOString(),
    });
    expect(alloc.nextFree()).toBe("10.86.1.11");
  });

  it("walks across octet boundaries", () => {
    // Fill .1.10 through .1.255 (no /24 broadcast skipping in a /16).
    for (let i = 10; i <= 255; i++) {
      store.put({
        userid: `u${i}`,
        name: `h${i}`,
        virtualIp: `10.86.1.${i}`,
        registeredAt: new Date().toISOString(),
      });
    }
    expect(alloc.nextFree()).toBe("10.86.2.0");
  });

  it("rejects out-of-range requested IPs", () => {
    expect(alloc.acceptRequested("10.86.1.10")).toBe(true);
    expect(alloc.acceptRequested("192.168.1.1")).toBe(false);
  });

  it("rejects requested IPs already in use", () => {
    store.put({
      userid: "u1",
      name: "host1",
      virtualIp: "10.86.1.10",
      registeredAt: new Date().toISOString(),
    });
    expect(alloc.acceptRequested("10.86.1.10")).toBe(false);
    expect(alloc.acceptRequested("10.86.1.11")).toBe(true);
  });
});
