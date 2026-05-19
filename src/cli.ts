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
import { Peer } from "@decentnetwork/peer";
import { RegistryStore } from "./store.js";
import { IpAllocator } from "./allocator.js";
import { RegistryServer } from "./server.js";

/**
 * Acquire a pidfile-based single-instance lock for the given data-dir.
 *
 * Two dora servers sharing a data-dir share the keypair, so they
 * both register the same Carrier userid. The Carrier network
 * routes friend-traffic to whichever of them connected last —
 * the symptoms on the client side are dora flapping
 * online/offline and roster fetches randomly timing out. Detecting
 * the duplicate at startup and refusing to launch is cleaner than
 * letting the operator discover it via failed pings.
 *
 * Stale-pidfile handling: if the pidfile exists but the recorded
 * PID isn't running, the lock is treated as released (the previous
 * server died without cleanup). We don't try to use flock/fcntl
 * locks here because the cross-platform story for those is messy
 * — the pidfile + liveness check covers the realistic mistake
 * (operator double-clicks the launcher) without dragging in extra
 * dependencies.
 */
function acquireLock(dataDir: string): { release: () => void } {
  const lockFile = resolve(dataDir, "dora.pid");
  if (existsSync(lockFile)) {
    const raw = readFileSync(lockFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0); // probe; throws if dead
        console.error(
          `dora: another instance is already running for ${dataDir} (pid ${pid}).`
        );
        console.error(
          `If you're certain it's dead, remove ${lockFile} and retry.`
        );
        process.exit(1);
      } catch {
        // Process not alive — stale pidfile, take over.
        console.warn(
          `dora: stale lock from pid ${pid}, taking over.`
        );
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

async function main(): Promise<void> {
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
  const DEFAULT_BOOTSTRAPS = [
    { host: "47.100.103.201", port: 33445, pk: "CX1XH419p4xJ5SV4KvDxBeKYSRdMJW9QpdWJY8owUxHd" },
    { host: "154.64.235.176", port: 33445, pk: "GdNtV2N74fZnLjhH7NhQ18nGdxb1k8jRM9dQaK7WnxmL" },
    { host: "13.58.208.50", port: 33445, pk: "89vny8MrKdDKs7Uta9RdVmspPjnRMdwMmaiEW27pZ7gh" },
    { host: "18.216.102.47", port: 33445, pk: "G5z8MqiNDFTadFUPfMdYsYtkUDbX5mNCMVHMZtsCnFeb" },
    { host: "54.193.141.205", port: 33445, pk: "7TfZWZNV8vnBxxWzJXuvKgX2QyKkLpg2oXx3LQ5tg8LW" },
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
