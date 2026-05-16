# Installing `@decentnetwork/dora`

`dora` is a name + IP allocation service for the Decent AgentNet
virtual LAN. It runs as a normal user-space process on any single
machine in the network — there is one `dora` server per
agentnet, and every peer (every node running `@decentnetwork/lan`)
points at its userid. No root, no firewall changes, no public IP.

## Requirements

- **Node.js 20 or newer**. Check with `node --version`.
- Any OS Node runs on (Linux, macOS, Windows, FreeBSD).
- Outbound TCP to the public Carrier bootstrap nodes (33445 + 443).
  Outbound UDP works too if NAT/firewall allows; not required.

## Install

```bash
npm install -g @decentnetwork/dora
```

This installs the `dora` command on `$PATH`. Confirm:

```bash
dora --help
```

(There is also a programmatic API — `import { DoraServer, DoraClient }
from "@decentnetwork/dora"` — used by `@decentnetwork/lan`. Most operators don't
need it; the CLI is the supported surface.)

## Run the server

The server is a foreground daemon. Pick a stable machine (ideally
one that's always on — a NAS, VPS, Mac mini, etc. — but it doesn't
have to be public-IP'd; Carrier handles NAT traversal):

```bash
dora --data-dir ~/.dora-server --verbose
```

On first run dora generates a Carrier keypair in
`~/.dora-server/keypair.json` and prints its identity:

```
registry identity: address=Jt7w1pKkyLT5GVue9h6ZPkjg1EeuuTbD6JVSLycXLsdm6nvBGSUd userid=98rsHv17h8G6AP9RagyrBiT1kmw4cn8MFPEembS6ZVjv
```

The **userid** is what every other peer puts in its config to find
the server. The **address** is what they use to send a one-time
friend-request to it (dora auto-accepts every friend request).

Background-mode launch is up to you — `systemd`, `launchd`, `tmux`,
`pm2`, whatever your environment uses.

## Use from a decentlan client

On every other machine running `@decentnetwork/lan`:

```bash
agentnet friend-request --address <dora's address>     # one-time
agentnet dora enable --userid <dora's userid>          # writes config
agentnet up                                            # start daemon
```

That's it — the client will register with dora, get a virtual IP,
and pull the full roster on every restart.

## Persistent state

The data dir holds three files:

| file | what |
|---|---|
| `keypair.json` | Carrier identity. **Don't lose this** — losing it forces every client to re-friend the new identity. |
| `roster.yaml` | Live IP / name / userid / address mapping. Edit by hand only when the server is stopped. |
| `keypair.json.friends.json` | Carrier-level friends. Auto-managed. |

Back these up if dora's data dir matters to you.

## CLI flags

```
--data-dir <path>      Where to store identity + roster (default: ~/.decent-registry)
--range-start <ip>     First IP in the allocation pool (default: 10.86.1.10)
--range-end <ip>       Last IP in the pool (default: 10.86.254.254)
--verbose              Log every register/lookup/list operation
```

## Upgrading

`npm install -g @decentnetwork/dora@latest`, then restart the process.
The data dir is preserved across upgrades; identity is never
rotated unless you delete `keypair.json`.

## See also

- [`CONFIGURATION.md`](CONFIGURATION.md) — wire format, allocator
  range tuning, multi-dora hot-standby.
- Project page: https://github.com/0xli/dora
