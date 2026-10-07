/**
 * Execution-time integrity for a VERIFIED engine bundle (#671).
 *
 * `findSharedBundle` (build.ts) checks the shared root's `main.js` against its
 * manifest once, at engine resolution. The path is then carried on the
 * `EngineRuntime` and spawned many times over the daemon's whole life, and the
 * engine re-reads the file from disk each time -- so without this the window
 * between check and use was the daemon's lifetime. Here the digest the check
 * actually computed is PINNED in memory against the path, and `spawnEngine`
 * re-hashes the file and refuses to start an engine from bytes that differ.
 *
 * Why the pin and not "run the manifest check again": the manifest sits beside
 * the bundle with the same ownership, so whatever can swap `main.js` can swap
 * the manifest too (findSharedBundle's docblock says the same). An in-memory
 * digest is out of reach of anything that can only write the tree.
 *
 * Why a full re-hash per spawn and not a cache keyed on inode+mtime+size:
 * measured, it is not worth skipping. Against a real 1.85 MB bundle a
 * read+sha256 is ~0.8 ms median (1.6 ms p95, n=200), while the spawn it guards
 * costs ~9 ms for a bare `bun -e 0` and ~100 ms for a process that loads this
 * bundle -- about 1% of an engine start at the median and under 2% at p95.
 * That time is on the daemon's event loop, not the child's, which is why it is
 * worth stating; and the engine pool keeps warm engines, so most acquires never
 * spawn at all. A stat-keyed cache would save the 1 ms and add a second
 * mechanism to get right: mtime is set by whoever writes the file, so it would
 * have to key on ctime, which is sound against a non-root writer but is one
 * more assumption than hashing the bytes.
 *
 * WHAT THIS STILL IS NOT. It covers `main.js` and nothing else, which is only
 * enough because the bundle no longer loads anything from beside itself
 * (#759): it used to leave `bufferutil` and `supports-color` to run-time
 * resolution, from `node_modules` above the bundle or by Bun auto-install, so
 * a writer of the bundle tree could run code without touching `main.js`.
 * ENGINE_ABSENT_MODULES and `assertSelfContainedBundle` (build.ts) hold that
 * shut; this pin depends on them staying so. And the check runs
 * microseconds before `spawn()`, after which the engine opens the file itself,
 * so a writer that wins that race is not caught either: for `main.js` the
 * window is narrowed from the daemon's lifetime to the spawn, not closed.
 * Closing both is an immutable mount (or spawning from bytes the daemon holds),
 * which is a deployment change. Finally, what is pinned is a bundle whose
 * bytes this daemon has a reason to trust: a shared bundle that verified
 * against its manifest, and one `buildEngineBundle` has just built itself
 * (#761). A per-user bundle ADOPTED from the cache has no manifest by design,
 * so there is nothing to pin it to, and it spawns as before.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** resolved bundle path -> sha256 hex of the bytes that were verified. */
const pinned = new Map<string, string>();

/**
 * sha256 of a REGULAR file. Anything else throws instead of being read: a FIFO
 * with no writer would block the daemon's event loop forever, and a link to
 * `/dev/zero` would read until memory ran out -- on every spawn, now that this
 * runs per spawn. Stat and read go through one descriptor, so the file checked
 * is the file hashed.
 */
export function sha256OfFile(path: string): string {
  // O_NONBLOCK so that OPENING a FIFO with no writer returns at once; a regular
  // file ignores the flag.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular file`);
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
}

/**
 * Record that `bundlePath` verified with `digest`. A later verification of the
 * same path replaces the pin, so a host that republishes a shared root (with
 * its manifest) is followed on the next resolution rather than refused forever.
 */
export function pinVerifiedBundle(bundlePath: string, digest: string): void {
  pinned.set(resolve(bundlePath), digest);
}

export class BundleIntegrityError extends Error {
  readonly reason: "changed_since_verification" | "unreadable";
  constructor(reason: BundleIntegrityError["reason"], message: string) {
    super(message);
    this.name = "BundleIntegrityError";
    this.reason = reason;
  }
}

/**
 * Throw a `BundleIntegrityError` if `bundlePath` was verified at resolution
 * and its bytes are no longer the ones that verified. A path that was never
 * verified (the per-user cache, a test fixture) passes untouched.
 *
 * The message names the bundle by its cache directory -- the 16-hex build hash
 * the path ends in -- and not by its full path: the root is operator config,
 * forwarded into model-directed children, and this message reaches logs a
 * model reads. The digests are hex. Nothing in it is attacker-chosen text.
 */
export function assertBundleUnchanged(bundlePath: string): void {
  const want = pinned.get(resolve(bundlePath));
  if (want === undefined) return;
  const label = `${safeLabel(basename(dirname(bundlePath)))}/${safeLabel(basename(bundlePath))}`;
  let got: string;
  try {
    got = sha256OfFile(bundlePath);
  } catch (err) {
    // The errno code only (ENOENT, EACCES, ...), never the message: the
    // message embeds the full path this function deliberately leaves out.
    const code = (err as { code?: unknown } | null)?.code;
    const why = typeof code === "string" && /^E[A-Z]+$/u.test(code) ? ` (${code})` : "";
    throw new BundleIntegrityError("unreadable",
      `engine bundle REFUSED reason=unreadable bundle=${label}: it verified at resolution and can no longer be read${why}`);
  }
  if (got !== want) {
    throw new BundleIntegrityError("changed_since_verification",
      `engine bundle REFUSED reason=changed_since_verification bundle=${label}: verified as ${want} at resolution, ` +
        `now hashes to ${got}; restart the daemon to re-verify`);
  }
}

/** A path segment, or a placeholder if it is anything but a plain name. */
function safeLabel(segment: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/u.test(segment) ? segment : "<unprintable>";
}

/** Test-only: forget every pin. */
export function __resetBundlePinsForTest(): void {
  pinned.clear();
}
