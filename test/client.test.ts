import { describe, it, expect } from "vitest";
import {
  RegistryClient,
  AllRegistriesUnavailableError,
  randomIpInSubnet,
} from "../src/client.js";
import { decode, encode, type RegistryRequest } from "../src/types.js";

/** Fake transport that pairs a client with one or more in-memory
 *  "registries". Each registry is configured with a fixed reply
 *  function; tests inject the behavior they want. */
function fakeTransport(): {
  send: (toUserid: string, text: string) => Promise<void>;
  onText: (handler: (fromUserid: string, text: string) => void) => void;
  // Register a fake registry at the given userid.
  registerFake: (
    userid: string,
    reply: (req: RegistryRequest) => Promise<string | null>
  ) => void;
} {
  const fakes = new Map<string, (req: RegistryRequest) => Promise<string | null>>();
  let inHandler: ((fromUserid: string, text: string) => void) | undefined;

  return {
    send: async (toUserid, text) => {
      const reply = fakes.get(toUserid);
      if (!reply) throw new Error(`no fake for ${toUserid}`);
      const req = decode(text);
      if (!req) throw new Error("malformed request");
      const respText = await reply(req as RegistryRequest);
      if (respText && inHandler) {
        // Deliver async, like a real network would.
        setTimeout(() => inHandler!(toUserid, respText), 0);
      }
    },
    onText: (handler) => {
      inHandler = handler;
    },
    registerFake: (userid, reply) => fakes.set(userid, reply),
  };
}

describe("RegistryClient", () => {
  it("succeeds when the first registry answers", async () => {
    const t = fakeTransport();
    t.registerFake("R1", async (_req) =>
      encode({
        op: "lookup-ok",
        record: {
          userid: "U1",
          name: "host1",
          virtualIp: "10.86.1.10",
          registeredAt: "2026-05-10T00:00:00Z",
        },
      })
    );
    const client = new RegistryClient({
      registryUserids: ["R1"],
      sendText: t.send,
      onText: t.onText,
      timeoutMs: 1000,
    });

    const rec = await client.lookup({ by: "userid", value: "U1" });
    expect(rec?.name).toBe("host1");
  });

  it("falls over to the second registry when the first times out", async () => {
    const t = fakeTransport();
    // R1 accepts the send but never replies.
    t.registerFake("R1", async () => null);
    t.registerFake("R2", async (_req) =>
      encode({
        op: "lookup-ok",
        record: {
          userid: "U1",
          name: "host1",
          virtualIp: "10.86.1.10",
          registeredAt: "2026-05-10T00:00:00Z",
        },
      })
    );

    const client = new RegistryClient({
      registryUserids: ["R1", "R2"],
      sendText: t.send,
      onText: t.onText,
      timeoutMs: 50, // fail fast
    });

    const rec = await client.lookup({ by: "userid", value: "U1" });
    expect(rec?.name).toBe("host1");
  });

  it("throws AllRegistriesUnavailableError when every registry fails", async () => {
    const t = fakeTransport();
    t.registerFake("R1", async () => null);
    t.registerFake("R2", async () => null);

    const client = new RegistryClient({
      registryUserids: ["R1", "R2"],
      sendText: t.send,
      onText: t.onText,
      timeoutMs: 30,
    });

    await expect(client.lookup({ by: "userid", value: "U1" })).rejects.toThrow(
      AllRegistriesUnavailableError
    );
  });

  it("throws AllRegistriesUnavailableError when no userids configured", async () => {
    const t = fakeTransport();
    const client = new RegistryClient({
      registryUserids: [],
      sendText: t.send,
      onText: t.onText,
    });
    await expect(client.lookup({ by: "userid", value: "U1" })).rejects.toThrow(
      AllRegistriesUnavailableError
    );
  });
});

describe("randomIpInSubnet", () => {
  it("picks an IP inside the 10.86.0.0/16 range, skipping the first /24", () => {
    for (let i = 0; i < 50; i++) {
      const ip = randomIpInSubnet("10.86.0.0/16");
      const [a, b, c, d] = ip.split(".").map((p) => parseInt(p, 10));
      expect(a).toBe(10);
      expect(b).toBe(86);
      // First /24 (10.86.0.x) is reserved for infrastructure.
      expect(c).toBeGreaterThanOrEqual(1);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(254);
    }
  });

  it("rejects non-/16 subnets in v0.1", () => {
    expect(() => randomIpInSubnet("10.86.0.0/24")).toThrow();
  });

  it("rejects malformed subnets", () => {
    expect(() => randomIpInSubnet("not-an-ip/16")).toThrow();
  });
});
