# decent-dora

DHCP for Decent AgentNet, named after **DORA** — the four-step flow
your WiFi router uses to hand out IPs:

| step | who | what |
|---|---|---|
| **D**iscover | peer | "Is there a DORA server out there?" |
| **O**ffer    | server | "Sure — try `10.86.1.42`." |
| **R**equest  | peer | "I'll take it." |
| **A**cknowledge | server | "Confirmed. It's yours." |

One node on the agentnet runs the DORA daemon. New peers ask it for
an IP + name + register their userid; everyone else looks up
peers by name/userid/IP. Replaces the per-node `ipam.yaml` editing.

## How decentlan finds the server

The DORA server is just a Carrier peer. Decentlan addresses it by
its userid, the same way Carrier addresses bootstrap nodes — userid
swapped in for `host+port+pk`. Multiple userids allowed (hot standby).

```yaml
# decentlan config.yaml
registry:
  userids:
    - 4G5utnVUeigyUgtfRBGU62orNU3NZi7GFARH9755fymC

  # If no server answers within this many ms, fall back to a random
  # IP in the subnet (APIPA / 169.254.x.x style). The daemon stays
  # functional; it just doesn't know peer names.
  fallbackTimeoutMs: 10000
  fallbackSubnet: 10.86.0.0/16
```

## Topology

```
+-- decentlan node A --+        +-- decentlan node B --+
|  on start:           |        |  on start:           |
|    ask DORA for IP   |        |    ask DORA for IP   |
|    cache the roster  |        |    cache the roster  |
|                      |        |                      |
| dora-client ─────────+──┐  ┌──+ dora-client          |
+----------------------+  │  │  +----------------------+
                          ▼  ▼
                   +-- DORA server --+
                   | userid: 4G5u... |
                   | roster.yaml     |
                   | IP allocator    |
                   +-----------------+
```

DORA is a peer like any other — same `@decentnetwork/peer` SDK, same
trust model (friend it before you trust its replies). Lose it: every
client keeps working at its cached IP; new peers fall back to APIPA.

## v0.1 scope

- Carrier-text wire protocol: register / lookup / list
  (the "Request → Acknowledge" half of DORA; the Discover-Offer half
  is implicit because the client already knows the server's userid).
- YAML roster persistence.
- Linear IP allocator over a configurable range.
- Multi-server failover in the client.
- `randomIpInSubnet()` fallback when no server answers.

## See

- [docs/DESIGN.md](docs/DESIGN.md) — wire format, allocation policy,
  auth model, decentlan integration notes.
- Decent AgentNet PRD v0.4 §4.3.
