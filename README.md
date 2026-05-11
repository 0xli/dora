# decent-registry

The naming + IP allocation service for the Decent AgentNet network.

## What it is

One node on the decentlan network runs this daemon. Other nodes query it
over Carrier to:

- **register**: claim a virtual IP (or accept one the registry assigns)
  alongside a human-readable name keyed by Carrier userid;
- **lookup**: resolve `name → userid + ip`, `userid → name + ip`, or
  `ip → name + userid`;
- **list**: get the whole roster (small, fits in one message).

This replaces the per-node `ipam.yaml` editing that previously required
operators to copy userids around by hand. Adding a peer becomes: friend
it on Carrier, the registry assigns its IP on first contact, all other
peers learn about it from the registry.

## Why a separate project

Decentlan is the *transport* — TUN, packet routing, ACL, the built-in
CONNECT proxy. It's a leaf application on top of the
`@decentnetwork/peer` SDK.

The registry is a different concern — naming and address allocation —
and it lives somewhere durable in the network (the operator's "router"
node). Splitting it out keeps decentlan small and lets the registry
evolve independently (blockchain-backed records later, multi-namespace,
etc.) without dragging decentlan with it.

## Topology

```
+-------- decentlan node A --------+        +-------- decentlan node B --------+
| agentnet daemon                  |        | agentnet daemon                  |
|   - on start: query registry     |        |   - on start: query registry     |
|     for full roster              |        |     for full roster              |
|   - on friend event: lookup      |        |   - on friend event: lookup      |
| registry-client (carrier msg) ───+──┐  ┌──+ registry-client (carrier msg)    |
+----------------------------------+  │  │  +----------------------------------+
                                      │  │
                                      ▼  ▼
                              +-- decent-registry node --+
                              | registry daemon          |
                              |   - listens on carrier   |
                              |   - allocates IPs        |
                              |   - persists roster.yaml |
                              +--------------------------+
```

The registry node is itself a Carrier peer — it has a userid and is
friended by every node that uses it. There's nothing special about it
infrastructurally; it just happens to run this service.

## See

- [docs/DESIGN.md](docs/DESIGN.md) — protocol, record format, allocation policy.
- Decent AgentNet PRD v0.4 §4.3 ("Decent IPAM, not literal DHCP first").
