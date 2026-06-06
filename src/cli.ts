#!/usr/bin/env node

/**
 * dora CLI — boots the dora server (name + IP allocation
 * registry for a Decent Network virtual LAN).
 *
 * Usage:
 *   dora [--data-dir ~/.dora] [--range-start 10.86.1.10] [--verbose]
 */

import { resolve } from "path";
import { homedir } from "os";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { execSync } from "child_process";
import { Peer } from "@decentnetwork/peer";
import { RegistryStore } from "./store.js";
import { IpAllocator } from "./allocator.js";
import { RegistryServer } from "./server.js";

/**
 * Scan the OS process table for ANY other node process whose argv
 * mentions the same data-dir. This catches the case the pidfile
 * alone can't: a pre-lock-aware dora binary (anything <0.1.1) is
 * still running and silently competing for the Carrier identity.
 * It doesn't create the pidfile, so the pidfile check looks clean,
 * but two processes are running.
 *
 * Returns an array of PIDs found (excluding our own). Empty list
 * means we're clear to launch.
 *
 * Implementation note: shells out to `ps -ewwo pid,args` (BSD/macOS)
 * or `ps -eo pid,args` (Linux). Both flags work on both systems —
 * `-ww` widens output so we don't truncate the long --data-dir path.
 * If the scan fails for any reason (unusual /proc, missing ps), we
 * skip the check rather than blocking startup; the pidfile path
 * still provides the common-case guarantee.
 */
function findCompetingDoraProcesses(dataDir: string): number[] {
  let out = "";
  try {
    out = execSync("ps -e -o pid=,args= -ww", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return []; // ps failed — skip, fall through to pidfile-only check
  }
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const args = m[2];
    if (pid === process.pid) continue;
    // Match dora process by argv: must contain "dora" somewhere
    // (binary path or "cli.js") AND the same data-dir literal.
    // Heuristic but effective — we ship a single CLI script named
    // cli.js / dora; an operator's unrelated script that happens to
    // contain `~/.dora-server-local` in its argv would also match
    // but is exceedingly unlikely.
    if (!/\b(dora|cli\.js)\b/i.test(args)) continue;
    if (!args.includes(dataDir)) continue;
    pids.push(pid);
  }
  return pids;
}

/**
 * Acquire a single-instance lock for the given data-dir. Two layers:
 *
 *   1. argv scan via `ps`. Catches duplicates even when one of them
 *      is running a pre-lock-aware binary (0.1.0 or earlier).
 *   2. pidfile. Standard liveness probe with stale-cleanup; cheaper
 *      than the scan and the layer that defends against same-binary
 *      duplicate launches.
 *
 * Two dora servers sharing a data-dir share the keypair, so they
 * both register the same Carrier userid. The Carrier network routes
 * friend-traffic to whichever connected last — symptoms on the
 * client side are dora flapping online/offline and roster fetches
 * randomly timing out.
 */
function acquireLock(dataDir: string): { release: () => void } {
  const competing = findCompetingDoraProcesses(dataDir);
  if (competing.length > 0) {
    console.error(
      `dora: another dora process is already running for ${dataDir} (pid ${competing.join(", ")}).`
    );
    console.error(
      `Stop it first (e.g. 'kill ${competing[0]}') or pick a different --data-dir.`
    );
    process.exit(1);
  }

  const lockFile = resolve(dataDir, "dora.pid");
  if (existsSync(lockFile)) {
    const raw = readFileSync(lockFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0); // probe; throws if dead
        // We'd reach this branch only if argv scan missed the
        // process (e.g. its argv was rewritten or ps was unavailable).
        // Be conservative: refuse rather than racing.
        console.error(
          `dora: pidfile still owned by live pid ${pid} for ${dataDir}.`
        );
        process.exit(1);
      } catch {
        // Process not alive — stale pidfile, take over.
        console.warn(`dora: stale lock from pid ${pid}, taking over.`);
      }
    }
  }
  writeFileSync(lockFile, String(process.pid));
  // Best-effort touch so a `chmod`-restricted lockFile doesn't
  // wedge subsequent startups silently.
  closeSync(openSync(lockFile, "r"));
  const release = (): void => {
    try {
      const raw = readFileSync(lockFile, "utf-8").trim();
      if (Number.parseInt(raw, 10) === process.pid) unlinkSync(lockFile);
    } catch {
      // already gone; no-op
    }
  };
  return { release };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Pick the default data dir. Prefers ~/.dora (matches the package
 * name), but falls through to ~/.decent-registry if the legacy
 * path exists and ~/.dora doesn't — the project was originally
 * called "decent-registry" before being renamed, and we don't want
 * an upgrade to silently abandon an operator's identity / roster.
 */
function defaultDataDir(): string {
  const modern = resolve(homedir(), ".dora");
  const legacy = resolve(homedir(), ".decent-registry");
  if (!existsSync(modern) && existsSync(legacy)) return legacy;
  return modern;
}

/**
 * One-shot subcommand: pre-friend a userid by directly writing to the
 * dora data dir's friend store, then exit. Used to onboard a peer
 * whose friend-request can't reach dora over Carrier (e.g. the public
 * express relay is returning 500s and DHT onion discovery missed the
 * dora announce — a common failure mode in the wild). After the edit,
 * restart the server and the pre-friended peer's next register call
 * lands instantly.
 *
 * Usage: dora friend-add <userid> [name] [address] [--data-dir <dir>]
 * Idempotent — re-running is a no-op if the userid is already in the
 * store.
 */
function cmdFriendAdd(dataDir: string, positionals: string[]): void {
  const [userid, name, address] = positionals;
  if (!userid) {
    console.error(
      "dora friend-add: missing <userid> (run with --help for usage)"
    );
    process.exit(1);
  }
  // Validate userid shape: base58 of a 32-byte pubkey is ~44 chars.
  // Loose check to catch obvious typos without dragging in a base58
  // decode dep.
  if (userid.length < 40 || userid.length > 50) {
    console.error(
      `dora friend-add: '${userid}' doesn't look like a Carrier userid (expected ~44 base58 chars). Refusing.`
    );
    process.exit(1);
  }
  const friendsFile = resolve(dataDir, "keypair.json.friends.json");
  let friends: Record<string, unknown>[] = [];
  if (existsSync(friendsFile)) {
    try {
      friends = JSON.parse(readFileSync(friendsFile, "utf-8"));
    } catch (err) {
      console.error(
        `dora friend-add: ${friendsFile} is corrupt: ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }
  }
  if (friends.some((f) => f.pubkey === userid || f.userid === userid)) {
    console.log(`dora friend-add: ${userid} already in friend store — no change.`);
    return;
  }
  friends.push({
    pubkey: userid,
    userid,
    address: address ?? undefined,
    name: name ?? "@decentnetwork/peer",
    status: "offline",
    // Marking acceptedAt makes the SDK treat this record as an accepted
    // friend on next start (vs. a pending outbound request).
    acceptedAt: 1_700_000_000_000,
  });
  writeFileSync(friendsFile, JSON.stringify(friends, null, 2));
  console.log(
    `dora friend-add: added ${userid}${name ? ` (${name})` : ""} to ${friendsFile}.`
  );
  console.log(
    `Restart the dora server so the SDK loads the updated friend store.`
  );
}

async function main(): Promise<void> {
  // Subcommand dispatch: `dora friend-add ...` is a one-shot that
  // edits the friend store and exits without starting the server.
  // Everything else falls through to the server-startup path below.
  const subcommand = process.argv[2];
  if (subcommand === "friend-add") {
    const positionals = process.argv
      .slice(3)
      .filter((a) => !a.startsWith("--") && process.argv[process.argv.indexOf(a) - 1] !== "--data-dir");
    const dataDir = resolve(arg("data-dir", defaultDataDir())!);
    mkdirSync(dataDir, { recursive: true });
    cmdFriendAdd(dataDir, positionals);
    return;
  }

  // Default data-dir is ~/.dora (matches the package name). For
  // backward compat: if ~/.dora doesn't exist but the legacy
  // ~/.decent-registry does (we were called "decent-registry"
  // before being renamed to dora), use the legacy path so an
  // upgrading operator keeps their identity, roster, and friend
  // store without manual migration.
  const dataDir = resolve(arg("data-dir", defaultDataDir())!);
  mkdirSync(dataDir, { recursive: true });
  const lock = acquireLock(dataDir);
  const rosterFile = resolve(dataDir, "roster.yaml");
  const keyFile = resolve(dataDir, "keypair.json");

  const store = new RegistryStore(rosterFile);
  const allocator = new IpAllocator(store, {
    rangeStart: arg("range-start"),
    rangeEnd: arg("range-end"),
  });

  // Bootstrap nodes — same default set as decentlan. Operators who want
  // a private registry can edit this list or pass --bootstrap (not
  // wired up yet in v0.1).
  // Ordered with US relays first — must match decentlan's
  // DEFAULT_BOOTSTRAP_NODES order so dora and its clients land on
  // the same TCP relay set. Without this, dora here on a US Mac
  // ended up connected only to 47.100.x (Alibaba Shanghai) and
  // every US client connected to AWS US-East — no shared relay,
  // no path for net_crypto handshake, dora always offline from
  // clients' perspective. Clients in CN/SG can still reach dora
  // via the fallback nodes later in the list.
  const DEFAULT_BOOTSTRAPS = [
    { host: "13.58.208.50", port: 33445, pk: "89vny8MrKdDKs7Uta9RdVmspPjnRMdwMmaiEW27pZ7gh" },
    { host: "18.216.102.47", port: 33445, pk: "G5z8MqiNDFTadFUPfMdYsYtkUDbX5mNCMVHMZtsCnFeb" },
    { host: "54.193.141.205", port: 33445, pk: "7TfZWZNV8vnBxxWzJXuvKgX2QyKkLpg2oXx3LQ5tg8LW" },
    { host: "154.64.235.176", port: 33445, pk: "GdNtV2N74fZnLjhH7NhQ18nGdxb1k8jRM9dQaK7WnxmL" },
    { host: "47.100.103.201", port: 33445, pk: "CX1XH419p4xJ5SV4KvDxBeKYSRdMJW9QpdWJY8owUxHd" },
  ];

  // Express nodes deliver friend-requests for a recipient that is
  // offline at the moment the request is sent. The dora server also
  // needs to fetch pending requests from express on startup — without
  // these, a decentlan client's `agentnet friend-request` flow
  // appears to succeed but the dora-side onFriendRequest handler
  // never fires.
  const DEFAULT_EXPRESSES = [
    { host: "lens.beagle.chat", port: 443, pk: "ECbs4GxwGzxGerNkmqDJFibEmevu8jAXqAZtikccvD95" },
  ];

  const peer = await Peer.create({
    keyFile,
    compatibilityMode: "legacy",
    bootstrapNodes: DEFAULT_BOOTSTRAPS,
    expressNodes: DEFAULT_EXPRESSES,
  });
  await peer.start();
  console.log(`registry identity: address=${peer.address()} userid=${peer.userid()}`);
  console.log(`registry roster file: ${rosterFile}`);
  console.log(`registry pool start: ${arg("range-start") ?? "10.86.1.10"} end: ${arg("range-end") ?? "10.86.254.254"}`);

  await peer.joinNetwork();
  await peer.announceSelf(15000).catch((err) => {
    console.warn(`self-announce warning: ${(err as Error).message}`);
  });

  const server = new RegistryServer({
    peer,
    store,
    allocator,
    verbose: flag("verbose"),
  });
  server.start();

  console.log("registry ready — clients should configure registry.userid in decentlan's config.yaml");

  // Graceful shutdown.
  const stop = async (): Promise<void> => {
    console.log("\nshutting down registry");
    try {
      await peer.stop();
    } finally {
      lock.release();
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Best-effort cleanup on unhandled exit paths (uncaught exception,
  // process.exit elsewhere). The lock-acquire stale check covers
  // crashes that don't reach this handler, so this is just polish.
  process.on("exit", () => lock.release());

  // Hold the process open.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error("registry failed:", err);
  process.exit(1);
});
