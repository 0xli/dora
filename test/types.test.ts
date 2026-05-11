import { describe, it, expect } from "vitest";
import { encode, decode, DORA_PREFIX } from "../src/types.js";

describe("types — wire format", () => {
  it("round-trips register requests", () => {
    const enc = encode({
      op: "register",
      userid: "EjU8U",
      name: "snoopy",
      requestedIp: "10.86.1.10",
    });
    expect(enc.startsWith(DORA_PREFIX)).toBe(true);
    const dec = decode(enc);
    expect(dec).toEqual({
      op: "register",
      userid: "EjU8U",
      name: "snoopy",
      requestedIp: "10.86.1.10",
    });
  });

  it("returns null for unprefixed text (regular decentlan packet)", () => {
    expect(decode("qgAAAAEB")).toBeNull(); // base64 packet frame
    expect(decode("")).toBeNull();
  });

  it("returns null for prefixed-but-malformed bodies", () => {
    expect(decode(`${DORA_PREFIX}{not json`)).toBeNull();
  });
});
