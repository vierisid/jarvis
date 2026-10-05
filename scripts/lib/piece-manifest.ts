/**
 * What a published piece version actually offers: its action names, the
 * upstream `classification` of each, and each action's props. The catalog sync
 * reads this for every verified piece so a version bump can be checked against
 * the governed adapter in `src/workflows/runtime/piece-effects.ts` instead of
 * being merged on trust (#664) or held for a human every week.
 *
 * Getting it means running the piece's code: an action list is built at module
 * load, and there is no static manifest in the tarball. That code is the same
 * code the catalog would install on a user's machine, and it is treated as
 * hostile here:
 *
 *   - It runs ONLY in the workflow's `inspect` job, which has a read-only token
 *     that is never put in an environment, no git credentials on disk, and
 *     nothing it produces is committed except the manifests JSON, which the
 *     writing job validates (`verified-sync.ts`). An explicit child env is not
 *     a boundary on its own: a child can read its parent's environment from
 *     `/proc/<ppid>/environ`, so the only real protection is that no process in
 *     that job holds a secret.
 *   - The child still gets only PATH and a throwaway HOME, runs in the temp
 *     dir rather than the checkout, and runs in its own session: on timeout
 *     the whole process group is SIGKILLed, so neither a SIGTERM trap nor a
 *     detached grandchild outlives it.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface PieceAction {
  name: string;
  /** Upstream READ | SEARCH | WRITE | DESTRUCTIVE, or null when the piece sets none. */
  classification: string | null;
  props: string[];
  /** Only carried at run time, for the review issue. Not committed. */
  displayName?: string;
  description?: string;
}

export interface PieceManifest {
  version: string;
  actions: PieceAction[];
}

export type ManifestResult = { kind: "ok"; manifest: PieceManifest } | { kind: "error"; error: string };

/** A hung or hostile module load must not stall the weekly job. */
const EXTRACT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
/** The largest verified bundle today is ~3 MB; anything near this is not a piece. */
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const EXTRACTOR = resolve(import.meta.dir, "piece-manifest-extract.ts");

/**
 * Download `pkg@version` from npm, check it against the registry's sha512
 * integrity, unpack it and read its actions. Never throws: every failure is an
 * `error` result, which the caller treats as "hold this bump".
 */
export async function fetchPieceManifest(
  pkg: string,
  version: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<ManifestResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const work = mkdtempSync(join(tmpdir(), "piece-manifest-"));
  try {
    const metaRes = await fetchImpl(`https://registry.npmjs.org/${pkg}/${version}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!metaRes.ok) return { kind: "error", error: `registry metadata: HTTP ${metaRes.status}` };
    const meta = (await metaRes.json()) as { dist?: { tarball?: string; integrity?: string } };
    const tarball = meta.dist?.tarball;
    const integrity = meta.dist?.integrity;
    if (!tarball || !integrity?.startsWith("sha512-")) {
      return { kind: "error", error: "registry metadata has no tarball or sha512 integrity" };
    }
    const tarRes = await fetchImpl(tarball, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!tarRes.ok) return { kind: "error", error: `tarball: HTTP ${tarRes.status}` };
    const declared = Number(tarRes.headers.get("content-length") ?? "0");
    if (declared > MAX_TARBALL_BYTES) return { kind: "error", error: `tarball is ${declared} bytes` };
    const bytes = Buffer.from(await tarRes.arrayBuffer());
    if (bytes.length > MAX_TARBALL_BYTES) return { kind: "error", error: `tarball is ${bytes.length} bytes` };
    const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (actual !== integrity) return { kind: "error", error: "tarball does not match the registry's integrity" };

    const tgz = join(work, "piece.tgz");
    writeFileSync(tgz, bytes);
    const untar = spawnSync("tar", ["-xzf", tgz, "-C", work], { encoding: "utf8" });
    if (untar.status !== 0) return { kind: "error", error: `tar: ${(untar.stderr ?? "").trim()}` };

    const pkgDir = join(work, "package");
    const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      main?: string;
      dependencies?: Record<string, string>;
    };
    // Current releases are one self-contained bundle. Older ones (github 0.7.x,
    // telegram-bot 0.5.x) are plain packages that need their dependencies to
    // load. Install scripts never run, and a package manager config shipped in
    // the tarball is removed first so it cannot point the install elsewhere.
    if (Object.keys(pkgJson.dependencies ?? {}).length > 0) {
      for (const f of ["bunfig.toml", ".npmrc", ".yarnrc", ".yarnrc.yml"]) rmSync(join(pkgDir, f), { force: true });
      const install = runIsolated([process.execPath, "install", "--production", "--ignore-scripts", "--no-save"], {
        cwd: pkgDir,
        home: work,
        timeoutMs: EXTRACT_TIMEOUT_MS,
      });
      if (install.status !== 0) {
        return { kind: "error", error: `installing dependencies: ${(install.stderr ?? "").trim().slice(-500)}` };
      }
    }
    const entry = join(pkgDir, pkgJson.main ?? "src/index.js");
    const manifest = extractManifest(entry, work);
    return manifest.kind === "ok" ? { kind: "ok", manifest: { ...manifest.manifest, version } } : manifest;
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Load one piece bundle in an isolated child and read its actions. */
export function extractManifest(entry: string, home: string, opts: { timeoutMs?: number } = {}): ManifestResult {
  const child = runIsolated([process.execPath, EXTRACTOR, entry], {
    cwd: home,
    home,
    timeoutMs: opts.timeoutMs ?? EXTRACT_TIMEOUT_MS,
  });
  if (child.error) return { kind: "error", error: `extractor: ${child.error.message}` };
  if (child.signal) return { kind: "error", error: `extractor killed (${child.signal}) after the time limit` };
  if (child.status !== 0) {
    return { kind: "error", error: `extractor exited ${child.status}: ${(child.stderr ?? "").trim().slice(-500)}` };
  }
  try {
    const lines = child.stdout.trim().split("\n");
    const actions = JSON.parse(lines[lines.length - 1]!) as PieceAction[];
    return { kind: "ok", manifest: { version: "", actions } };
  } catch (e) {
    return { kind: "error", error: `extractor output: ${(e as Error).message}` };
  }
}

/**
 * Run a command in its own session (so its process group is its own), with
 * only PATH and HOME, killed with SIGKILL at the time limit. Afterwards the
 * whole group is SIGKILLed too, which reaps anything it left running in it.
 *
 * A grandchild that starts its own session escapes the group, and nothing at
 * process level can stop code that tries. That is why this only runs in the
 * `inspect` job: whatever survives there finds no secret, cannot touch what
 * gets committed, and is killed by the runner when the job ends.
 */
function runIsolated(argv: string[], opts: { cwd: string; home: string; timeoutMs: number }) {
  const r = spawnSync("setsid", ["--wait", ...argv], {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
    // An explicit env, never `undefined`: undefined means "inherit".
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: opts.home },
  });
  if (r.pid) {
    try {
      process.kill(-r.pid, "SIGKILL");
    } catch {
      // The group is already empty.
    }
  }
  return r;
}

/** Upstream classification as a severity, or null when it says nothing. */
export function classificationRank(c: string | null): number | null {
  switch (c) {
    case null:
      return null;
    case "READ":
    case "SEARCH":
      return 0;
    case "WRITE":
      return 1;
    case "DESTRUCTIVE":
      return 2;
    // A value this code has never seen is treated as worse than any it has:
    // an upstream vocabulary change should land in front of a person.
    default:
      return 3;
  }
}
