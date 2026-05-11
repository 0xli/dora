# Decent Registry — design

Status: design + skeleton. Implementation will follow once decentlan
is stable enough that operators want to deploy the registry alongside
it.

## Problem

Each decentlan node needs to know `userid → virtualIp → name` for every
other node it talks to. Per the PRD v0.4 §4.3 this is "Decent IPAM."

The implementations tried so far:

1. **Manual `ipam assign` per peer per node.** Correct but tedious; new
   peer joining = N edits across N peers.
2. **Hash-derived auto-IPAM.** Each peer computes a deterministic IP
   from `sha256(userid)`. Cheap but conflicts with peers' own configured
   self-IPs (`config.network.ip`) — produced ugly addresses like
   `10.86.175.35` that didn't match what the peer actually bound on its
   TUN, breaking the return path.
3. **Peer-broadcast on connect.** Each peer announces its own VIP via a
   text message when a friend comes online. Works, but "hard to maintain"
   per the operator — surprise updates, stale entries on offline peers,
   no single source of truth.

The user's directive: one node holds the registry. Other nodes ask it.
That's this project.

## Record format

Stored in YAML, transmitted as JSON over Carrier text messages.

```yaml
records:
  - userid: EjU8UoufCGS8V5e8hr85sR4AhSHdSSoLaigg1Pk3y9q2
    name: lan-snoopy
    virtualIp: 10.86.1.10
    registeredAt: 2026-05-10T22:00:00Z
    lastSeenAt: 2026-05-11T08:00:00Z

  - userid: 4G5utnVUeigyUgtfRBGU62orNU3NZi7GFARH9755fymC
    name: proxy-macmini
    virtualIp: 10.86.1.20
    registeredAt: 2026-05-10T22:30:00Z
```

`userid` is the primary key. `name` and `virtualIp` are both unique
within a namespace (the registry rejects collisions).

## Protocol

All messages are Carrier text messages prefixed with `DECENT_REGISTRY:`
so they don't collide with decentlan's packet frames (which are base64).
Body is JSON.

### register

Client → registry:
```
DECENT_REGISTRY:{"op":"register","userid":"...","name":"lan-snoopy","requestedIp":"10.86.1.10"}
```

Registry → client:
```
DECENT_REGISTRY:{"op":"register-ok","record":{"userid":"...","name":"lan-snoopy","virtualIp":"10.86.1.10","registeredAt":"..."}}
```

Or, on conflict:
```
DECENT_REGISTRY:{"op":"register-err","reason":"name lan-snoopy is held by EjU8...","suggestion":"lan-snoopy-2"}
```

If `requestedIp` is omitted, registry picks the next free IP in the
subnet (configurable, default `10.86.1.10`-onwards).

If the same userid registers a second time with the same name and ip,
the registry returns the existing record (idempotent). Different
name/ip = treated as a rename request and either accepted or rejected.

### lookup

Client → registry:
```
DECENT_REGISTRY:{"op":"lookup","by":"name","value":"proxy-macmini"}
```
`by` can be `userid`, `name`, or `ip`.

Registry → client:
```
DECENT_REGISTRY:{"op":"lookup-ok","record":{...}}
```
Or:
```
DECENT_REGISTRY:{"op":"lookup-err","reason":"no record for name 'proxy-macmini'"}
```

### list

Client → registry:
```
DECENT_REGISTRY:{"op":"list"}
```

Registry → client:
```
DECENT_REGISTRY:{"op":"list-ok","records":[ {...}, {...}, ... ]}
```

Capped at ~50 records per response (one Carrier message budget). For
larger networks, paginate later.

## Allocation policy

Default subnet `10.86.0.0/16`. Allocator state:

- Skip `10.86.0.0` (network) and `10.86.255.255` (broadcast).
- Walk allocations in `10.86.1.10` order on first run; record next
  available across restarts.
- Honor `requestedIp` if free; if not, return collision error.
- Reserve `10.86.0.0/24` for the registry node itself + future
  infrastructure use.

## Authentication

The registry trusts whoever sends it a message. There's no signed-record
flow in this version. Two implicit gates:

1. **Carrier friend store.** Only friends can send text to the
   registry. The registry operator decides who to friend.
2. **Single-writer per userid.** The registry checks that an update
   message's Carrier-level sender userid matches the `userid` in the
   record being modified — you can't register or rename someone else's
   record by sending a message from your own friend connection.

Signed records (operator-issued certificates of `(userid, name, ip)`)
are a v0.2 addition; out of scope for the skeleton.

## Client cache

Decentlan daemons that use the registry maintain a local cache
(`~/.agentnet/registry-cache.yaml`) refreshed:

- On daemon start (one `list` request).
- On each `friend-connection` event (`lookup by userid` for the new
  peer if not in cache).
- On a periodic timer (every 5 minutes) — picks up renames, new peers.

If the registry node is offline, the cache is the source of truth.
A peer with a stale cache simply won't see new peers until the
registry comes back; it can still reach peers it already knows.

## Configuration on decentlan side

Decentlan's `config.yaml` gets one new field:

```yaml
registry:
  enabled: true
  userid: 4G5utnVUeigyUgtfRBGU62orNU3NZi7GFARH9755fymC  # the registry node
```

Decentlan auto-friends the registry node on first start, runs the
initial `list`, populates its IPAM from the response, and stops
requiring the operator to type `ipam assign` ever again.

`ipam assign` remains as a manual override for the small number of
operators who want stricter control or who don't run a registry node.

## Why one designated node, not consensus

Friend networks are inherently small (dozens to low hundreds of peers).
The registry isn't a global naming system. A single trusted node owned
by the operator running the network is good enough — same trust model
as "the WiFi router in your house issues DHCP."

If the registry node dies, IPs don't change because every peer cached
the roster. A new node can be elected manually or via a future
multi-registry sync protocol; not in v0.1.

## v0.1 scope

- `register`, `lookup`, `list` over Carrier text.
- YAML persistence.
- Auto-allocation in `10.86.0.0/16` (skipping `/24` for infra).
- Single-node registry, no replication.
- Conflict rejection (no rename without explicit `replace=true` flag).

Out of scope: signed records, multi-namespace, blockchain backing,
high availability, paginated list, automated registry-node failover.
Those are v0.2+.
