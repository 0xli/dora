# Dora segment allocation — the register of record

The virtual network is `10.86.0.0/16`. Every address in it is handed out by
exactly one registry, and **which registry owns which band is the invariant
the whole federation rests on**: two registries allocating from the same band
eventually give two machines the same address, and everything routing to it
reaches the wrong one about half the time. That failure looks like packet
loss, not like a configuration error, which is why it went unnoticed for so
long.

This file is the authoritative record of that split. Changing a band means
changing this file **and** the `--range-start/--range-end` the registry runs
with; the two must never disagree.

Status: **allocation frozen — no new registries for now.**

## The split

| Registry | userid | Band | Capacity | Host |
|---|---|---|---|---|
| dora-mac | `98rsHv17…` | `10.86.1.10 – 10.86.63.254` | 16,117 | `linuxuser@gojipower.xyz` |
| dora-beagle | `AxKFEZFL…` | `10.86.64.10 – 10.86.127.254` | 16,373 | `beagle@10.0.0.115` |
| dora-sh | `GMEMLmCW…` | `10.86.128.10 – 10.86.191.254` | 16,373 | `root@sh.callt.net` |
| dora-tokyo | `AB6BZfbr…` | `10.86.192.10 – 10.86.254.254` | 16,117 | `linuxuser@tokyo.fi.chat` |
| | | **total allocatable** | **64,980** | |

## Deploying a registry

Install from npm — **never hand-copy a `dist/`**. A copied `dist/` has no
`node_modules` (`ERR_MODULE_NOT_FOUND`), pm2 reports the process "online"
while it is actually failing on every start, and the host ends up on a build
no package manager can account for.

```sh
npm install -g @decentnetwork/dora@<version>

# pm2 must spawn it, not require() it: the CLI is an ES module and
# `pm2 start <bin>` fails with ERR_REQUIRE_ESM.
pm2 start "$(npm root -g)/@decentnetwork/dora/dist/cli.js" \
  --interpreter "$(which node)" --name dora-<name> -- \
  --data-dir ~/.dora-<name> \
  --range-start <band start> --range-end <band end> --verbose \
  --peers <userid>=<address>#<name>,...
pm2 save
```

Confirm the new build is really running by looking for the startup lines in
`~/.pm2/logs/dora-<name>-out.log` — `registry replication: …` and
`replication: enabled for N sibling(s)` — rather than trusting `pm2 list`.

The /16 holds 65,536 addresses; the 556 outside the bands are `10.86.0.x`,
each band's first nine hosts, and `10.86.255.x` — reserved, never allocated.

Bands are contiguous and non-overlapping, verified by
`findDoraSegmentOverlaps` in decentlan's `config/loader.ts` (a unit test fails
if the shipped set ever overlaps) and re-checked at runtime: every `list-ok`
carries the sender's band as `seg`, and a replicating sibling logs
`SEGMENT OVERLAP` every round while two bands intersect.

## Occupancy (2026-07-20)

| Registry | In-band | Out-of-band (legacy) | Replicas held | Used of capacity |
|---|---|---|---|---|
| dora-mac | 9 | 7 | 4 | 0.06% |
| dora-beagle | 5 | 1 | 0 | 0.03% |
| dora-sh | unknown — unreachable | | | |
| dora-tokyo | unknown — unreachable | | | |

Utilisation is negligible; exhaustion is not a concern at any plausible size.
The registry prints this line every 10 minutes:

```
[registry] segment 10.86.1.10-10.86.63.254 — 9/16117 used (0.06%), 4 replicated
```

### Out-of-band records

Eight records sit outside their holder's band, left from when the allocator
**defaulted to the whole /16** and a registry started without range flags
silently claimed everything:

- dora-mac holds 7 in beagle/sh/tokyo's bands — `mac-dev 10.86.245.105`,
  `snoopy 10.86.156.164`, `GFAX 10.86.134.139`, `power 10.86.166.16`,
  `15-MacBook-Pro.local 10.86.205.11`, `node-6320 10.86.86.138`,
  `node-91 10.86.68.90`
- dora-beagle holds 1 in dora-mac's band — `node-3835 10.86.42.79`

They are **neutralised, not removed**: a registry flags anything outside its
band `rep` in `list` replies, so it can no longer offer them to siblings as
its own or beat the true band owner to being their origin. They still answer
lookups, which is deliberate — several of those nodes list only one registry,
so deleting the record would force a re-registration into a different band
and change their address. The order that avoids that: give those nodes the
other registries, let them re-register with their true band owner, then
delete.

## Uniqueness, and what happens when it breaks anyway

1. **Declared, not defaulted.** `--range-start` and `--range-end` are
   required; a registry with no band refuses to start rather than claim the
   /16. This is the fix for the root cause above.
2. **Authority is the band.** A registry only vouches for records inside its
   own range. Anything else it holds is marked second-hand.
3. **Overlap is detectable.** Bands are compared both offline (shipped config
   check) and online (`seg` exchanged on every sync).
4. **Duplicates are refused, never applied.** If a replica claims an address
   another identity already holds, the incoming record is dropped and a
   `CONFLICT` line names both claimants. The live mapping is never
   overwritten — a wrong answer is worse than a missing one.
5. **The whole roster is swept.** Duplicates that pre-date these guards are
   reported every sync round by `findIpConflicts()`, so a latent conflict
   surfaces instead of waiting for someone to debug mysterious loss.

## Availability as a fitness test

A registry that is usually unreachable is worse than absent: it still owns a
band nobody else can allocate from, so its downtime is the network's
downtime. Reachability is therefore recorded, not assumed.

Every sync round votes on each sibling; results go to
`<data-dir>/sibling-availability.yaml` and survive restarts:

- `up` — current state, and `lastUpAt`, the moment it last actually answered
- `upMs` / `downMs` — wall-clock in each state, so a long outage outweighs a
  brief one instead of counting as one bad probe
- `outages` — up→down transitions, because a registry that flaps is as
  unusable as one that is simply down, and a bare uptime ratio hides that
- `probes` / `failures`

Transitions are logged as they happen and summarised every 10 minutes:

```
[registry] sibling beagle    up    uptime= 99.2% probes=412 failures=3 outages=1 lastUp=…
[registry] sibling sh        DOWN  uptime=  0.0% probes=412 failures=412 outages=0 lastUp=never
```

**A registry that cannot hold a good record should not keep a band.** The
numbers above are the input to that judgement; retiring one means moving its
band to a registry that can, and updating this file.

### Current standing

- **dora-mac** — serving; replicating from beagle.
- **dora-beagle** — serving; friendship with dora-mac established, replication
  had not yet completed a round at time of writing.
- **dora-sh**, **dora-tokyo** — **never accepted the sibling friend request**
  (`status=requested`), so neither can be replicated from and neither
  replicates. Their bands (128–191, 192–254) are single points of failure
  today: if either is down, nothing else can resolve its addresses. Host
  unconfirmed — locating and updating them is the outstanding work.
