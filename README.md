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

The registry **is a Carrier peer**, addressed by its userid — exactly
the same way Carrier itself addresses bootstrap nodes (just with `host
+ port + pk` swapped for `userid`).

```
+-------- decentlan node A --------+        +-------- decentlan node B --------+
| agentnet daemon                  |        | agentnet daemon                  |
|   config.yaml:                   |        |   config.yaml:                   |
|     registry.userids: [...]      |        |     registry.userids: [...]      |
|                                  |        |                                  |
| registry-client (carrier msg) ───+──┐  ┌──+ registry-client (carrier msg)    |
+----------------------------------+  │  │  +----------------------------------+
                                      │  │
                                      ▼  ▼
                              +-- decent-registry node --+
                              | registry daemon          |
                              |   - userid: 4G5utn...    |
                              |   - listens on carrier   |
                              |   - allocates IPs        |
                              |   - persists roster.yaml |
                              +--------------------------+
```

A decentlan node:

1. Tries each userid in `registry.userids` in order. First answer wins.
2. If none answer within the timeout, **falls back to self-assigning
   a random IP** in `fallbackSubnet` (default `10.86.0.0/16`). The
   daemon keeps working; it just doesn't have a canonical roster of
   peer names until the registry comes back. Same mental model as
   APIPA / `169.254.0.0/16` when DHCP is offline.

Multiple registries are allowed — the operator can run a hot standby
or a regional pair without re-deploying client config when one dies.

## See

- [docs/DESIGN.md](docs/DESIGN.md) — protocol, record format, allocation policy.
- Decent AgentNet PRD v0.4 §4.3 ("Decent IPAM, not literal DHCP first").
