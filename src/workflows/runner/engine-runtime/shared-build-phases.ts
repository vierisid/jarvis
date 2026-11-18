/**
 * The phases of `scripts/build-shared-runtime.ts` (#862), and the check the
 * extract phase makes before it runs a single piece.
 *
 * One pass (no phase flag) installs the catalog and then runs every piece in
 * it at the same uid, so a piece can rewrite anything that pass wrote: the
 * other pieces, the license gate's input, the engine before its final check.
 * Split, the host runs:
 *
 *   1. `--install-only` as the build uid: the engine bundle and the catalog
 *      install, no piece code (the install runs with --ignore-scripts).
 *   2. root seals what that wrote: a root-owned, read-only copy, with the
 *      engine checked against the digest from `--digest-fd`.
 *   3. `--extract-only --from <sealed>` as a third uid: the license gate and
 *      the metadata extraction, against the sealed tree, writing only its own
 *      `--out`.
 *
 * `sealViolations` is what makes step 3 refuse an unsealed tree instead of
 * trusting the host to have done step 2: a piece running at this uid must not
 * be able to change the code it, or any other piece, runs as.
 */

import { accessSync, constants as fsConstants, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SharedBuildPhase = "all" | "install" | "extract";

/**
 * The phase `argv` asks for, or why the flags do not fit together. Flags
 * that only mean something in one phase are refused in the others rather
 * than ignored, so a host wrapper that passes the wrong set fails loudly.
 */
export function sharedBuildPhase(argv: readonly string[]): { phase: SharedBuildPhase } | { error: string } {
  const has = (flag: string) => argv.includes(flag);
  const install = has("--install-only");
  const extract = has("--extract-only");
  if (install && extract) return { error: "--install-only and --extract-only are separate runs; pass one" };
  if (extract) {
    if (!has("--from")) return { error: "--extract-only needs --from <dir>, the sealed output of an --install-only run" };
    for (const flag of ["--seed-lock", "--digest-fd"]) {
      if (has(flag)) return { error: `${flag} belongs to the run that builds and installs, not to --extract-only` };
    }
    return { phase: "extract" };
  }
  if (has("--from")) return { error: "--from is only read by --extract-only" };
  return { phase: install ? "install" : "all" };
}

/** The filesystem calls `sealViolations` makes; injectable so its accepting case is testable without root. */
export interface SealProbe {
  lstat(path: string): { uid: number; mode: number; isDirectory(): boolean; isSymbolicLink(): boolean };
  readdir(path: string): string[];
  writable(path: string): boolean;
}

const REAL_PROBE: SealProbe = {
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
  writable: (path) => {
    try {
      accessSync(path, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Why `roots` are not sealed against this process, or `[]` when they are.
 * Sealed means nothing this uid can do changes what is read from them:
 *   - this process is not root (root can write everything);
 *   - every entry under each root, and the root itself, is OWNED BY ROOT and
 *     not writable by this process. "Not this uid" is not enough: another
 *     account owning an entry could still change it. A symlink is judged as
 *     a link (by owner) and not followed: what it points at inside the tree
 *     is judged where it lies, and a link out of the tree is the host's to
 *     drop before it seals;
 *   - every ancestor of each root is root's, and not writable by this process
 *     unless sticky, so no root can be renamed away and replaced.
 * Stops at `limit` findings: one is enough to refuse, a few say what is wrong.
 */
export function sealViolations(
  roots: readonly string[],
  uid: number | undefined = process.getuid?.(),
  probe: SealProbe = REAL_PROBE,
  limit = 5,
): string[] {
  if (uid === undefined) return ["this platform has no uids, so a sealed tree cannot be told apart from a writable one"];
  if (uid === 0) return ["running as root, which can write any tree; run --extract-only as an unprivileged account"];
  const found: string[] = [];
  const note = (path: string, why: string): boolean => {
    found.push(`${path}: ${why}`);
    return found.length >= limit;
  };
  // "stop": the limit is reached. "bad": noted. "dir"/"leaf": sealed so far.
  const judge = (path: string): "stop" | "bad" | "dir" | "leaf" => {
    let st: ReturnType<SealProbe["lstat"]>;
    try {
      st = probe.lstat(path);
    } catch (err) {
      return note(path, `cannot be read (${err instanceof Error ? err.message : String(err)})`) ? "stop" : "bad";
    }
    if (st.uid !== 0) return note(path, `owned by uid ${st.uid}, not root`) ? "stop" : "bad";
    if (!st.isSymbolicLink() && probe.writable(path)) return note(path, "writable by this process") ? "stop" : "bad";
    return st.isDirectory() ? "dir" : "leaf";
  };
  for (const raw of roots) {
    const root = resolve(raw);
    for (let cur = dirname(root); ; cur = dirname(cur)) {
      let why: string | null = null;
      try {
        const st = probe.lstat(cur);
        if (st.uid !== 0) why = `an ancestor of ${root} owned by uid ${st.uid}, not root`;
        else if (probe.writable(cur) && (st.mode & 0o1000) === 0) why = `an ancestor of ${root} this process can write`;
      } catch (err) {
        why = `cannot be read (${err instanceof Error ? err.message : String(err)})`;
      }
      if (why !== null && note(cur, why)) return found;
      if (dirname(cur) === cur) break;
    }
    const top = judge(root);
    if (top === "stop") return found;
    if (top === "leaf" && note(root, "is not a directory")) return found;
    if (top !== "dir") continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let names: string[];
      try {
        names = probe.readdir(dir);
      } catch (err) {
        if (note(dir, `cannot be listed (${err instanceof Error ? err.message : String(err)})`)) return found;
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        const verdict = judge(path);
        if (verdict === "stop") return found;
        if (verdict === "dir") stack.push(path);
      }
    }
  }
  return found;
}
