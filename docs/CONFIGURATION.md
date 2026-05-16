# Configuring `@decent/dora`

The dora server is small on purpose — the only persistent choices
are the **data directory**, the **IP allocation range**, and the
**Carrier bootstrap nodes**. Everything else is decided at
runtime by the protocol.

See [`INSTALL.md`](INSTALL.md) for first-time setup.

## Command-line flags

| flag | default | what it does |
|---|---|---|
| `--data-dir <path>` | `~/.decent-registry` | Holds the Carrier keypair, the friend store, and `roster.yaml`. **The identity in this dir IS the dora server's public name** — keep it stable. |
| `--range-start <ip>` | `10.86.1.10` | First IP the allocator hands out to a fresh peer. |
| `--range-end <ip>` | `10.86.254.254` | Last IP. Must be in the same /16 as `--range-start`. |
| `--verbose` | off | Log every operation. Useful while bringing a network up; noisy in steady state. |

## Reserved range

By convention the first `/24` of the subnet (`10.86.0.0/24`) is
**not** auto-allocated — leave it for infrastructure (the dora
server itself if you choose to assign it one, manual VIPs for
gateways, etc.). The default `--range-start 10.86.1.10` honors
this; if you change the start, pick something at `.1.x` or higher.

## Roster file format

`roster.yaml` is human-readable. Edit it only when the dora server
is stopped; runtime changes are overwritten.

```yaml
records:
  - userid: 9eu3s3ZMqGtdgdiSrM8EjremNc2NdDMFDQ6pB2P45LJB
    name: lan-snoopy
    virtualIp: 10.86.1.10
    address: L299KaEf3p9oCgNnNuwHC61PFxMnydHF2fLrsaDohKBZN3QZM7DA
    registeredAt: '2026-05-15T08:09:32.856Z'
    lastSeenAt: '2026-05-16T05:36:06.790Z'
```

- `userid` is the primary key — Carrier-derived from the peer's
  public key. Stable across restarts of that peer.
- `name` is whatever the peer registered with (typically its
  hostname). Unique per dora.
- `virtualIp` is what the peer's TUN binds to. Unique per dora.
- `address` is the full Carrier address (with nospam token); other
  peers need it to send friend-requests via auto-friend.
- `registeredAt` is set on first register. `lastSeenAt` updates
  on every re-register / heartbeat.

## Wire protocol (for SDK consumers)

Dora messages ride on the Carrier text channel with a `DORA:`
prefix:

```
DORA:{"op":"register","userid":"...","name":"snoopy","address":"...","requestedIp":"10.86.1.13","replace":true}
```

Ops:

| op | direction | purpose |
|---|---|---|
| `register` | client → server | "I'm here, allocate or reaffirm my IP." |
| `lookup` | client → server | "By name / userid / virtual IP, who is this?" |
| `list` | client → server | "Give me the whole roster." |
| `register-ok` / `register-err` | server → client | response |
| `lookup-ok` / `lookup-err` | server → client | response |
| `list-ok` / `list-err` | server → client | response |

Decentlan's `DoraIntegration` calls `register` once on daemon
startup (with `replace: true`) and `list` every 60 seconds for
roster refresh. See `dist/types.d.ts` for full schemas.

## Multi-dora (hot-standby)

A peer's config may list multiple dora userids; the client tries
them in order and the first responder wins. Roster state is **not
replicated** between servers — they're independent. Useful when
you want a backup dora that can take over if the primary's host
goes down; rosters drift apart unless you periodically copy
`roster.yaml` between them.

## Tuning

- **Carrier bootstrap nodes**: dora ships with the same default
  list as decentlan. If you run a private bootstrap network, edit
  the source `dist/cli.js` and replace `DEFAULT_BOOTSTRAPS`. There
  is no CLI flag yet.
- **Express relay**: dora pulls friend-requests from
  `lens.beagle.chat:443` (Carrier's offline-message relay). Without
  it, a client whose friend-request arrives while dora is offline
  is lost. To disable, edit `DEFAULT_EXPRESSES` in `dist/cli.js`
  before launch.

## See also

- [`INSTALL.md`](INSTALL.md) — first-time install and basic operation
- [`@decentnetwork/peer`](https://www.npmjs.com/package/@decentnetwork/peer) —
  the underlying Carrier SDK; flags like `DECENT_DEBUG=1` apply
  to dora's process too.
- [decent-agentnet](https://www.npmjs.com/package/decent-agentnet) —
  the client side that consumes dora's roster.
