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
dora --data-dir ~/.dora --verbose
```

On first run dora generates a Carrier keypair in
`~/.dora/keypair.json` and prints its identity:

```
registry identity: address=Jt7w1pKkyLT5GVue9h6ZPkjg1EeuuTbD6JVSLycXLsdm6nvBGSUd userid=98rsHv17h8G6AP9RagyrBiT1kmw4cn8MFPEembS6ZVjv
```

The **userid** is what every other peer puts in its config to find
the server. The **address** is what they use to send a one-time
friend-request to it (dora auto-accepts every friend request).

## Run as a service (recommended)

The one-liner for persistence + auto-restart:

### Linux (systemd)

```bash
sudo tee /etc/systemd/system/dora.service > /dev/null <<EOF
[Unit]
Description=Decent AgentNet dora registry
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
ExecStart=$(which dora) --data-dir $HOME/.dora --verbose
Restart=on-failure
RestartSec=5
StandardOutput=append:$HOME/.dora/dora.log
StandardError=append:$HOME/.dora/dora.log

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now dora
journalctl -u dora -f
```

dora runs as your user (no sudo needed at runtime — it's not a network
appliance, just a Carrier peer).

### macOS (launchd, user agent)

```bash
mkdir -p ~/Library/LaunchAgents
tee ~/Library/LaunchAgents/com.decentnetwork.dora.plist > /dev/null <<EOF
<?xml version="1.0"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.decentnetwork.dora</string>
  <key>ProgramArguments</key><array>
    <string>$(which dora)</string>
    <string>--data-dir</string>
    <string>$HOME/.dora</string>
    <string>--verbose</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.dora/dora.log</string>
  <key>StandardErrorPath</key><string>$HOME/.dora/dora.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.decentnetwork.dora.plist
tail -f ~/.dora/dora.log
```

To stop later: `launchctl unload ~/Library/LaunchAgents/com.decentnetwork.dora.plist`.

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
--data-dir <path>      Where to store identity + roster (default: ~/.dora (or legacy ~/.decent-registry if present))
--range-start <ip>     First IP in the allocation pool (default: 10.86.1.10)
--range-end <ip>       Last IP in the pool (default: 10.86.254.254)
--verbose              Log every register/lookup/list operation
```

## Pre-friending a peer when the friend-request can't reach you

The Carrier friend-request from a fresh client travels via either an
onion route through the DHT or, as fallback, the public express relay
(`lens.beagle.chat`). Both can fail transiently — express has been
seen returning HTTP 500 for hours at a time, and a freshly-restarted
dora's announce may not have propagated to the bootstrap nodes a
particular client is querying. The symptom: client `agentnet diag`
shows the dora friend stuck on `status: requested` forever, IPAM stays
empty.

When this happens, the dora operator can **bypass the friend-request
path** and add the peer directly to dora's friend store:

```bash
# get the peer's userid (they run this on their box):
agentnet identity show
# → userid: 2wErj1XreXt1UchE3FGhuvkZ4GoBpo8JGMn8X49nm2ec

# on the dora server, stop dora, pre-friend, restart:
sudo systemctl stop dora       # or 'launchctl unload …' on macOS
dora friend-add 2wErj1XreXt1UchE3FGhuvkZ4GoBpo8JGMn8X49nm2ec power
sudo systemctl start dora
```

The peer's next register call (within ~60s) lands instantly — no
friend-request handshake needed because dora already has them in the
friend store. Idempotent: re-running `friend-add` for the same userid
is a no-op.

This is also the easy way to **invite-only your dora**: disable
`autoFriend` on the dora side (TODO — currently dora auto-accepts) and
pre-friend each peer manually.

## Upgrading

`npm install -g @decentnetwork/dora@latest`, then restart the process.
The data dir is preserved across upgrades; identity is never
rotated unless you delete `keypair.json`.

## See also

- [`CONFIGURATION.md`](CONFIGURATION.md) — wire format, allocator
  range tuning, multi-dora hot-standby.
- Project page: https://github.com/0xli/dora
