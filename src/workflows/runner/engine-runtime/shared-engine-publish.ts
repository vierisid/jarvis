/**
 * The shared engine artifact that `scripts/build-shared-runtime.ts` builds for
 * multi-tenant hosting, and the order its digest is written in (#862).
 *
 * The builder runs every catalog piece (metadata extraction) at the same uid
 * that owns `<out>/engine/<hash>/`. Before #862 it wrote `main.js.sha256`
 * BEFORE extraction, digesting the copy on disk, so a piece could rewrite
 * `main.js` AND its manifest and every tenant's pin would agree with the
 * tampered bytes.
 *
 * Now:
 *   - only the files `buildEngineBundle` just wrote are copied, each checked
 *     against the sha256 the build computed IN MEMORY from the bytes it wrote
 *     (#761). A stale or planted file in the build's directory is not copied;
 *   - `onPinned` hands the digest out BEFORE any piece runs (the builder's
 *     `--digest-fd`), the one moment no third-party code can interfere with
 *     the channel;
 *   - pieces run (`extract`);
 *   - every file is hashed again and must be byte-identical, with nothing added
 *     or removed (a planted `main.js.sha256` included), or the build fails;
 *   - only then is `main.js.sha256` created, exclusively, from the in-memory
 *     digest, which the builder also returns for its summary.
 *
 * What this does NOT close, by construction: anything a piece process that
 * outlives `extract` (a detached grandchild) writes AFTER the final check,
 * including the summary file and the builder's stdout. The builder cannot stop
 * that at the same uid; the host must take the digest from `--digest-fd` and
 * verify a root-owned copy of `main.js` against it. The in-memory value itself
 * is out of reach: pieces run in child processes, and a Yama ptrace scope of 1
 * or more stops a child attaching to its parent. See
 * docs/shared-runtime-integrity.md.
 */

import { createHash } from "node:crypto";
import { closeSync, copyFileSync, lstatSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";

export const ENGINE_MANIFEST_NAME = "main.js.sha256";

/** What `publishSharedEngine` needs from `buildEngineBundle`'s result. */
export interface BuiltEngine {
  bundleDir: string;
  /** sha256 of main.js as BUILT, in memory. `null` (nothing verified it) is refused. */
  digest: string | null;
  /** Every file the build wrote, name -> in-memory sha256. Absent (not a build) is refused. */
  builtFiles?: Readonly<Record<string, string>>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Every regular file under `dir`, relative path -> sha256. Anything else refuses. */
function hashTree(dir: string): Map<string, string> {
  const top = lstatSync(dir);
  if (!top.isDirectory()) throw new Error(`shared engine dir ${dir} is not a directory`);
  const out = new Map<string, string>();
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur).sort()) {
      const path = join(cur, name);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.set(relative(dir, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
      else throw new Error(`shared engine artifact holds ${relative(dir, path)}, which is not a regular file or directory`);
    }
  };
  walk(dir);
  return out;
}

/** Every way `after` differs from `before`, as readable lines. */
function treeChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, sha] of before) {
    const now = after.get(path);
    if (now === undefined) changes.push(`${path} removed`);
    else if (now !== sha) changes.push(`${path} changed`);
  }
  for (const path of after.keys()) if (!before.has(path)) changes.push(`${path} added`);
  return changes;
}

/**
 * Create `<engineOutDir>/main.js.sha256` naming `digest`. "wx": created here or
 * not at all, so a name that appeared after the final check (a file, or a
 * symlink to somewhere else) fails the build instead of being written through.
 */
export function writeEngineManifest(engineOutDir: string, digest: string): void {
  writeFileSync(join(engineOutDir, ENGINE_MANIFEST_NAME), digest + "\n", { flag: "wx" });
}

/**
 * The builder's `--digest-fd` hand-out: write `<digest>\n` to `fd`, then CLOSE
 * it. The close is the point: once this process no longer holds the caller's
 * pipe, no process can reach it through this one's /proc/<pid>/fd. Bun does not
 * pass extra fds to the children it spawns (pinned in the test), so nothing
 * spawned before this is a second holder.
 */
export function handOutDigestToFd(fd: number, digest: string): void {
  try {
    writeSync(fd, digest + "\n");
  } finally {
    closeSync(fd);
  }
}

/**
 * Copy the built bundle to `engineOutDir` (which must be empty), hand its
 * digest to `onPinned`, run `extract` (the step that runs pieces), then verify
 * the copy is untouched and write its manifest from the build's in-memory
 * digest. Returns `extract`'s result and that digest. Throws, leaving no
 * manifest, when anything in the copy changed.
 */
export async function publishSharedEngine<T>(
  bundle: BuiltEngine,
  engineOutDir: string,
  extract: () => Promise<T>,
  onPinned: (engineDigest: string) => void = () => {},
): Promise<{ result: T; engineDigest: string }> {
  const engineDigest = bundle.digest;
  if (engineDigest === null || !SHA256_HEX.test(engineDigest)) {
    throw new Error("shared engine: the build returned no digest, so there is nothing to pin the copy to");
  }
  const built = bundle.builtFiles;
  if (!built || built["main.js"] !== engineDigest || Object.values(built).some((sha) => !SHA256_HEX.test(sha))) {
    throw new Error("shared engine: the build did not say which files it wrote, so a copy of its directory cannot be checked");
  }
  if (ENGINE_MANIFEST_NAME in built) {
    throw new Error(`shared engine: ${ENGINE_MANIFEST_NAME} came with the build; only this step may write it`);
  }
  if (readdirSync(engineOutDir).length > 0) {
    throw new Error(`shared engine: ${engineOutDir} is not empty`);
  }
  // Exactly what the build wrote, by name: nothing else in its directory, stale
  // or planted, ships. A name with a separator would be a file the build did
  // not write beside main.js, which it never does.
  for (const name of Object.keys(built)) {
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`shared engine: the build reported an output outside its directory: ${name}`);
    }
    copyFileSync(join(bundle.bundleDir, name), join(engineOutDir, name));
  }
  const before = hashTree(engineOutDir);
  // The copy must be the bytes that were built (#761), every file of it.
  // Digesting the destination alone would make a truncated or swapped copy
  // agree with itself.
  const mismatched = Object.entries(built).filter(([name, sha]) => before.get(name) !== sha).map(([name]) => name);
  if (mismatched.length > 0 || before.size !== Object.keys(built).length) {
    throw new Error(
      `engine bundle copy does not match the build (built main.js ${engineDigest}, copied ${before.get("main.js") ?? "nothing"}; ` +
        `differs: ${mismatched.join(", ") || "file set"})`,
    );
  }

  onPinned(engineDigest);
  const result = await extract();

  const changes = treeChanges(before, hashTree(engineOutDir));
  if (changes.length > 0) {
    throw new Error(
      `shared engine REFUSED: the engine artifact changed while pieces ran (${changes.join(", ")}). ` +
        `Something the metadata extraction ran wrote to it; nothing from this build may be published (#862).`,
    );
  }
  writeEngineManifest(engineOutDir, engineDigest);
  return { result, engineDigest };
}
