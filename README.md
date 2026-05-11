# dora

Published as **`@decent/dora`** on npm.
Source: `git@github.com:0xli/dora.git`.

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

## Runs as a normal user

DORA does **not** need root / admin. It's a plain Carrier peer that
listens for text messages and writes a YAML file in its config dir —
no TUN device, no privileged sockets, no system services. Run it as
yourself:

```bash
npm install -g @decent/dora    # (once published)
dora --data-dir ~/.dora --verbose
```

This is intentional separation from decentlan (which DOES need root
for TUN). DORA is small, stable, and safe to leave running on any
always-on box you happen to have.

## Deployment flow

DORA is **optional** in the decent network. Carrier peers that are
happy talking by userid don't need it. DORA exists for the subset of
users that want classic TCP/UDP-over-IP addressing through decentlan;
those users need a way to agree on `userid ↔ ip` mappings, and DORA
is the service that holds the map.

Step-by-step:

1. **Run dora on some always-on box.**
   ```bash
   dora --data-dir ~/.dora --verbose
   ```
   On startup it prints:
   ```
   dora identity: address=8Abcfxp4UgpXuL... userid=4G5utnVUeigyUgt...
   ```
   Copy the **address** (the longer string with the checksum) and
   share it with whoever wants to use this DORA — same way you'd
   share a Carrier friend address.

2. **Each decentlan node sends a friend request to that address.**
   This happens once per node. DORA auto-accepts every incoming
   friend request — no manual approval, no waiting for the operator
   to do `friend-accept` on the server side. That's the whole point
   of being a public registry.

3. **Once friended, the node knows DORA's userid** (the friend store
   maps address → userid). The node puts that userid in its
   `config.yaml` under `registry.userids` and from then on talks to
   DORA over Carrier text messages.

4. **Discover-Offer-Request-Acknowledge** plays out over Carrier:
   the node sends a `register` op asking for an IP, DORA picks one
   from its pool, the node uses it, and other nodes that ask DORA
   for `lookup` see the mapping.

If DORA goes offline, every node keeps working at its cached IP and
new nodes fall back to a random IP in the subnet (APIPA style). No
single-point-of-failure for already-connected peers.

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
