/**
 * Walk an installed `node_modules` tree and decide every package in it under
 * the license policy (#971). Reads only `package.json` and license files: it
 * never loads or runs package code, so it is safe on a tree straight from npm.
 *
 * Every package on disk counts, reachable or not, because everything on disk
 * is what the shared tree ships. Handles bun's hoisted layout, nested
 * `node_modules`, and the isolated layout (`node_modules/.bun/<key>/node_modules`
 * with links into it), and a node_modules a package ships below its root. A
 * link that leaves the tree, or a node_modules that is a link, is itself a
 * problem: the scan cannot vouch for what it points at. Each package's
 * identity comes from where bun put it and from bun.lock, never from its
 * package.json alone.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { evaluatePackage, REVIEWED_LICENSES, type EvaluateOptions, type LicenseVerdict } from "./license-policy";

export interface ScannedPackage {
  name: string;
  version: string;
  /** Directory, relative to the scanned root. */
  path: string;
  verdict: LicenseVerdict;
  /** From the root's dependencies down to this package, as `name@version`. Empty when unreachable. */
  chain: string[];
  /**
   * Every dependency of the root manifest (by name) this package is installed
   * for: the root dependency itself, or one whose dependency tree reaches it.
   * `chain` names one shortest path; this names every root dependency that
   * would ship it, which is what a per-piece decision needs (#971). A bundled
   * copy is reached from whatever reaches its carrier.
   */
  reachedFrom: string[];
}

export interface LicenseScan {
  packages: ScannedPackage[];
  violations: ScannedPackage[];
  /** Problems that are not one package's license (unreadable package.json, links out of the tree). */
  errors: string[];
  /** REVIEWED_LICENSES entries no package in this tree used. */
  unusedReviewed: string[];
  /**
   * Each entry of `errors` that is about one package directory, keyed by the
   * error text, with the root dependencies whose tree reaches that directory
   * (empty: a leftover nothing depends on). An error not listed here is about
   * the tree as a whole (no bun.lock, a hidden directory, a link where a scope
   * belongs). #971: a per-piece decision charges an error to the pieces that
   * reach it.
   */
  errorReachedFrom: Map<string, string[]>;
}

interface Found {
  dir: string;
  name: string;
  version: string;
  /** Only the fields the policy and the chains read, not the whole manifest. */
  pkg: Record<string, unknown>;
  /** Shipped inside another package's tarball, so bun.lock does not know it. */
  bundled: boolean;
  /** Under its own name, but bun.lock does not list it there (`unvouched: "declared"`); see `lockMiss`. */
  unvouched?: "absent" | "version";
}

const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;
/**
 * How deep inside one package the scan looks for a `node_modules` it ships.
 * The deepest directory in the shared tree on 2026-10-21 is 12 levels below
 * its package root (couchbase's vendored PEGTL headers), so this is twice
 * that; past it the scan refuses rather than guess.
 */
export const MAX_PACKAGE_DEPTH = 24;

/**
 * npm package names (legacy upper-case ones included) and semver versions.
 * Anything else in a `package.json` is not an identity the scan will key a
 * policy decision on, or print.
 */
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Hidden entries bun itself writes into a node_modules. */
const BUN_HIDDEN = new Set([".bin", ".cache", ".bun"]);

export interface ScanOptions extends EvaluateOptions {
  /**
   * Check each package against the tree's `bun.lock`: "required" (the shared
   * build, where bun always writes one) makes a missing lock an error;
   * "if-present" checks only when there is one. Default "if-present".
   */
  lockfile?: "required" | "if-present";
  /**
   * What a package bun.lock does not vouch for, found under its own name, is:
   * "error" (default; the hosted shared tree, built fresh) or "declared" (a
   * self-managed pieces dir, #971): judged on the license it declares, with
   * no upstream presumption. bun leaves old nested copies behind that the
   * current lock no longer lists, and they are still ordinary packages.
   */
  unvouched?: "error" | "declared";
}

type LockPackages = Record<string, unknown>;

function readLock(root: string): LockPackages | null {
  const p = join(root, "bun.lock");
  if (!existsSync(p)) return null;
  const parsed = Bun.JSONC.parse(readFileSync(p, "utf8")) as { packages?: unknown };
  const packages = parsed && typeof parsed === "object" ? parsed.packages : undefined;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) throw new Error("bun.lock has no packages table");
  return packages as LockPackages;
}

export function scanInstalledTree(root: string, opts: ScanOptions = {}): LicenseScan {
  const realRoot = realpathSync(root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  const found = new Map<string, Found>();
  const visited = new Set<string>();
  const errors: string[] = [];
  const rel = (p: string) => relative(realRoot, p) || ".";
  /** Package directories the scan refused to decide, with why. */
  const rejected = new Map<string, string>();
  const reject = (dir: string, error: string): void => {
    errors.push(error);
    if (!rejected.has(dir)) rejected.set(dir, error);
  };
  /** Problems found at a path (a hidden or linked directory, the depth limit): charged to the package that holds the path. */
  const pathErrors: Array<[string, string]> = [];
  const atPath = (path: string, error: string): void => {
    errors.push(error);
    pathErrors.push([path, error]);
  };

  let lock: LockPackages | null = null;
  try {
    lock = readLock(realRoot);
    if (lock === null && opts.lockfile === "required") errors.push("bun.lock is missing, so no package can be checked against what bun resolved");
  } catch (e) {
    errors.push(`bun.lock is unreadable: ${(e as Error).message}`);
  }
  const resolutions = new Set<string>();
  if (lock) for (const v of Object.values(lock)) if (Array.isArray(v) && typeof v[0] === "string") resolutions.add(v[0]);

  /**
   * The identity a package has by WHERE bun put it, checked against what its
   * own package.json claims and against bun.lock. A package.json is
   * publisher text: a dependency calling itself `@activepieces/shared` must
   * not inherit that name's upstream MIT. An npm alias (`"string-width-cjs":
   * "npm:string-width@^4"`, which glob>=10 pulls via @isaacs/cliui) sits
   * under the alias but is the package bun.lock resolved that key to; it is
   * accepted only when bun.lock says so, and is judged under its real name.
   */
  const identityProblem = (real: string, name: string, version: string, bundled: boolean): string | null => {
    const marker = `${sep}node_modules${sep}`;
    const at = real.lastIndexOf(marker);
    if (at < 0) return `${rel(real)} is not inside a node_modules directory`;
    const located = real.slice(at + marker.length).split(sep).join("/");
    // A bundled copy came in another package's tarball: bun.lock records the
    // tarball, not what is inside it, so nothing can vouch for an alias there.
    // Without a lock nothing can vouch for one either.
    if (located !== name && (!lock || bundled)) return `${rel(real)} claims to be ${name}, but bun installed it as ${located}`;
    if (!lock || bundled) return null;
    const relPath = rel(real).split(sep).join("/");
    const store = /^node_modules\/\.bun\/([^/]+)\/node_modules\//.exec(relPath);
    const resolved = `${name}@${version}`;
    if (store) {
      // The store keeps each package under its real name; an alias there is
      // only a link, which resolves to it.
      if (located !== name) return `${rel(real)} claims to be ${name}, but bun installed it as ${located}`;
      const key = store[1]!;
      const expected = `${name.replace("/", "+")}@${version}`;
      if (key !== expected && !key.startsWith(expected + "+")) return `${rel(real)} is ${resolved}, but sits in the store entry ${key}`;
      if (!resolutions.has(resolved)) return `${rel(real)} is ${resolved}, which bun.lock does not resolve`;
      return null;
    }
    const key = relPath.replace(/^node_modules\//, "").split("/node_modules/").join("/");
    const entry = Object.hasOwn(lock, key) ? lock[key] : undefined;
    if (!Array.isArray(entry) || entry[0] !== resolved) {
      const what = located === name ? `is ${resolved}` : `claims to be ${resolved} under the name ${located}`;
      return `${rel(real)} ${what}, but bun.lock resolves ${key} to ${Array.isArray(entry) ? String(entry[0]) : "nothing"}`;
    }
    return null;
  };

  /**
   * Why bun.lock does not vouch for a package bun put under its own name:
   * "absent", the lock has no entry at that place (an old copy bun left behind,
   * and nothing else could have put it there under that name), or "version",
   * the lock lists that name there at another version. Null for anything else:
   * the lock names another package there (an alias), or a store entry.
   */
  const lockMiss = (real: string, name: string, version: string): "absent" | "version" | null => {
    const marker = `${sep}node_modules${sep}`;
    const at = real.lastIndexOf(marker);
    if (at < 0 || !lock) return null;
    const located = real.slice(at + marker.length).split(sep).join("/");
    if (located !== name) return null;
    const relPath = rel(real).split(sep).join("/");
    if (/^node_modules\/\.bun\//.test(relPath)) return null;
    const key = relPath.replace(/^node_modules\//, "").split("/node_modules/").join("/");
    const entry = Object.hasOwn(lock, key) ? lock[key] : undefined;
    if (!Array.isArray(entry)) return "absent";
    return typeof entry[0] === "string" && entry[0].startsWith(`${name}@`) && entry[0] !== `${name}@${version}` ? "version" : null;
  };

  const visitPackage = (dir: string, bundled: boolean): void => {
    let real: string;
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) {
        real = realpathSync(dir);
        if (!inside(real)) {
          reject(dir, `${rel(dir)} links outside the tree, to ${real}`);
          return;
        }
        if (!statSync(real).isDirectory()) return;
      } else if (st.isDirectory()) {
        real = dir;
      } else {
        return;
      }
    } catch (e) {
      reject(dir, `${rel(dir)}: ${(e as Error).message}`);
      return;
    }
    // Every directory once, package or not, so a link cycle ends.
    if (visited.has(real)) return;
    visited.add(real);
    const pj = join(real, "package.json");
    if (!existsSync(pj)) {
      // A directory in node_modules with no package.json is not a package
      // (bun leaves none of these); its node_modules is still walked.
      walkNodeModules(join(real, "node_modules"), bundled);
      return;
    }
    let pkg: Record<string, unknown>;
    try {
      const st = lstatSync(pj);
      if (!st.isFile() || st.size > MAX_PACKAGE_JSON_BYTES) throw new Error("not a regular file of sane size");
      const parsed: unknown = JSON.parse(readFileSync(pj, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      pkg = parsed as Record<string, unknown>;
    } catch (e) {
      reject(real, `${rel(real)}/package.json is unreadable: ${(e as Error).message}`);
      return;
    }
    const name = pkg["name"];
    const version = pkg["version"];
    if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME.test(name) || typeof version !== "string" || !SEMVER.test(version)) {
      reject(real, `${rel(real)}/package.json has no valid npm name and semver version`);
      return;
    }
    const wrong = identityProblem(real, name, version, bundled);
    // Under its own name but not in bun.lock: in a self-managed dir, judged on what it declares.
    const miss = wrong !== null && opts.unvouched === "declared" ? lockMiss(real, name, version) : null;
    const unvouched = miss !== null;
    if (wrong && !unvouched) {
      reject(real, wrong);
      return;
    }
    const kept: Record<string, unknown> = {};
    for (const k of ["license", "licenses", "dependencies", "optionalDependencies", "peerDependencies"]) {
      if (Object.hasOwn(pkg, k)) kept[k] = pkg[k];
    }
    found.set(real, { dir: real, name, version, pkg: kept, bundled, ...(miss ? { unvouched: miss } : {}) });
    // npm bundleDependencies ship inside this tarball, so bun.lock does not
    // list them: they are bundled copies, like a node_modules below the root.
    const listed = pkg["bundleDependencies"] ?? pkg["bundledDependencies"];
    const bundles = new Set(Array.isArray(listed) ? listed.filter((x): x is string => typeof x === "string") : []);
    walkNodeModules(join(real, "node_modules"), bundled, bundles);
    findShippedNodeModules(real, 0);
  };

  /**
   * A package can ship a node_modules below its root (`lib/node_modules/x`),
   * which Node resolves from files beside it. Walk the package's own
   * directories, never through a link, and scan every one found.
   */
  const findShippedNodeModules = (dir: string, depth: number): void => {
    if (depth > MAX_PACKAGE_DEPTH) {
      atPath(dir,
        `${rel(dir)} is more than ${MAX_PACKAGE_DEPTH} directories below its package root, so the scan did not look ` +
          `inside it for a node_modules the package ships and cannot vouch for what is there. Check that package by ` +
          `hand; if it is fine, raise MAX_PACKAGE_DEPTH in license-scan.ts, otherwise leave its piece out with ` +
          `SHARED_BUILD_EXCLUDED`,
      );
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink() && e.name === "node_modules") {
        atPath(join(dir, e.name), `${rel(join(dir, e.name))} is a link; the scan does not follow a node_modules elsewhere`);
        continue;
      }
      if (!e.isDirectory()) continue;
      // The package root's own node_modules is walked by visitPackage.
      if (e.name === "node_modules") {
        if (depth > 0) walkNodeModules(join(dir, e.name), true);
        continue;
      }
      findShippedNodeModules(join(dir, e.name), depth + 1);
    }
  };

  const walkNodeModules = (nm: string, bundled: boolean, bundles: ReadonlySet<string> = new Set()): void => {
    let names: string[];
    try {
      const st = lstatSync(nm);
      if (st.isSymbolicLink()) {
        atPath(nm, `${rel(nm)} is a link; the scan does not follow a node_modules elsewhere`);
        return;
      }
      if (!st.isDirectory()) return;
      names = readdirSync(nm);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const p = join(nm, n);
      if (n === ".bun") {
        // bun's isolated store: one directory per resolved package, each
        // holding its own node_modules with the package and its links.
        let keys: string[] = [];
        try {
          if (!lstatSync(p).isDirectory()) {
            atPath(p, `${rel(p)} is not a directory`);
            continue;
          }
          keys = readdirSync(p);
        } catch {}
        for (const k of keys.sort()) walkNodeModules(join(p, k, "node_modules"), bundled);
        continue;
      }
      if (n.startsWith(".")) {
        // .bin and .cache are bun's; any other hidden directory could hold
        // packages Node still loads by path.
        if (!BUN_HIDDEN.has(n)) {
          try {
            if (lstatSync(p).isDirectory()) atPath(p, `${rel(p)} is a hidden directory bun does not write; not scanned`);
          } catch {}
        }
        continue;
      }
      if (n.startsWith("@")) {
        let scoped: string[] = [];
        try {
          if (lstatSync(p).isSymbolicLink()) {
            atPath(p, `${rel(p)} is a link, where a scope directory belongs`);
            continue;
          }
          scoped = readdirSync(p);
        } catch {}
        for (const s of scoped.sort()) visitPackage(join(p, s), bundled || bundles.has(`${n}/${s}`));
        continue;
      }
      visitPackage(p, bundled || bundles.has(n));
    }
  };

  walkNodeModules(join(realRoot, "node_modules"), false);

  // Dependency edges, resolved the way Node does from each package's real
  // directory: its own node_modules, then each parent's, up to the root.
  const byDir = found;
  const resolveDep = (fromDir: string, dep: string): Found | null => {
    let d = fromDir;
    for (;;) {
      const candidate = join(d, "node_modules", dep);
      if (existsSync(candidate)) {
        try {
          const real = realpathSync(candidate);
          const hit = byDir.get(real);
          if (hit) return hit;
        } catch {}
      }
      if (d === realRoot || !inside(d)) return null;
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
  };
  /** The refused package directory a dependency resolves to, if that is what it finds first. */
  const resolveRejected = (fromDir: string, dep: string): string | null => {
    let d = fromDir;
    for (;;) {
      const candidate = join(d, "node_modules", dep);
      if (existsSync(candidate) || rejected.has(candidate)) {
        if (rejected.has(candidate)) return candidate;
        try {
          const real = realpathSync(candidate);
          if (byDir.has(real)) return null;
          if (rejected.has(real)) return real;
        } catch {}
      }
      if (d === realRoot || !inside(d)) return null;
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
  };
  const depNames = (pkg: Record<string, unknown>): string[] => {
    const out = new Set<string>();
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const v = pkg[field];
      if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) out.add(k);
    }
    return [...out].sort();
  };

  // Breadth-first from the root manifest, so each chain is a shortest one.
  const chains = new Map<string, string[]>();
  let rootPkg: Record<string, unknown> = {};
  try {
    rootPkg = JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {}
  const queue: Array<{ f: Found; chain: string[] }> = [];
  for (const dep of depNames(rootPkg)) {
    const f = resolveDep(realRoot, dep);
    if (f && !chains.has(f.dir)) {
      const chain = [`${f.name}@${f.version}`];
      chains.set(f.dir, chain);
      queue.push({ f, chain });
    }
  }
  while (queue.length > 0) {
    const { f, chain } = queue.shift()!;
    for (const dep of depNames(f.pkg)) {
      const g = resolveDep(f.dir, dep);
      if (g && !chains.has(g.dir)) {
        const next = [...chain, `${g.name}@${g.version}`];
        chains.set(g.dir, next);
        queue.push({ f: g, chain: next });
      }
    }
  }

  // Which root dependencies reach each package: a walk per root dependency
  // over the same edges, each package's edges resolved once.
  const edges = new Map<string, Found[]>();
  const edgesOf = (f: Found): Found[] => {
    let out = edges.get(f.dir);
    if (!out) {
      out = depNames(f.pkg).map((dep) => resolveDep(f.dir, dep)).filter((g): g is Found => g !== null);
      edges.set(f.dir, out);
    }
    return out;
  };
  const reachedFrom = new Map<string, Set<string>>();
  const rejectedFrom = new Map<string, Set<string>>();
  const markRejected = (dir: string | null, dep: string): void => {
    if (dir === null) return;
    let set = rejectedFrom.get(dir);
    if (!set) rejectedFrom.set(dir, (set = new Set()));
    set.add(dep);
  };
  for (const dep of depNames(rootPkg)) {
    const start = resolveDep(realRoot, dep);
    if (!start) { markRejected(resolveRejected(realRoot, dep), dep); continue; }
    const seen = new Set<string>([start.dir]);
    const stack = [start];
    while (stack.length > 0) {
      const f = stack.pop()!;
      let set = reachedFrom.get(f.dir);
      if (!set) reachedFrom.set(f.dir, (set = new Set()));
      set.add(dep);
      for (const g of edgesOf(f)) if (!seen.has(g.dir)) { seen.add(g.dir); stack.push(g); }
      // A dependency that lands on a package the scan refused, and anything
      // refused inside this package's own tree, is this root's problem too.
      for (const name of depNames(f.pkg)) if (!resolveDep(f.dir, name)) markRejected(resolveRejected(f.dir, name), dep);
      for (const dir of rejected.keys()) if (dir.startsWith(f.dir + sep)) markRejected(dir, dep);
    }
  }

  // A bundled copy has no edge in any manifest: its chain is the chain of the
  // package whose tarball carried it.
  const owners = [...found.values()].filter((f) => !f.bundled).sort((a, b) => b.dir.length - a.dir.length);
  const ownerOf = (f: Found) => owners.find((o) => f.dir.startsWith(o.dir + sep));
  for (const f of found.values()) {
    if (!f.bundled || chains.has(f.dir)) continue;
    const owner = ownerOf(f);
    const base = owner ? (chains.get(owner.dir) ?? [`${owner.name}@${owner.version}`]) : [];
    chains.set(f.dir, [...base, `${f.name}@${f.version} (bundled)`]);
  }

  const reviewedKeys = Object.keys(opts.reviewed ?? REVIEWED_LICENSES);
  const usedReviewed = new Set<string>();
  const packages: ScannedPackage[] = [...found.values()]
    .map((f) => {
      // A bundled copy names itself; nothing ties that name to Activepieces
      // or to the catalog, so it gets no upstream presumption.
      // A reviewed entry for a bundled copy names where it was reviewed (the
      // carrying release, checked against bun.lock, and the path inside it),
      // so another tarball cannot borrow the review by claiming the name.
      const owner = f.bundled ? ownerOf(f) : undefined;
      const bundledAt = f.bundled
        ? owner
          ? `${owner.name}@${owner.version}:${relative(owner.dir, f.dir).split(sep).join("/")}`
          : `(no carrier):${rel(f.dir)}`
        : undefined;
      const verdict = evaluatePackage(
        f.name,
        f.version,
        f.pkg,
        f.bundled ? { ...opts, catalogPackages: new Set(), upstream: false, bundledAt }
          // A copy the lock has no entry for keeps the upstream presumption: under
          // its own name, it came from the registry under that name (an old
          // nested SDK copy bun left). One the lock lists at another version does not.
          : f.unvouched === "version" ? { ...opts, catalogPackages: new Set(), upstream: false } : opts,
      );
      if (verdict.allowed && verdict.basis === "reviewed") usedReviewed.add(`${f.name}@${f.version}`);
      const carrier = f.bundled ? owner : undefined;
      const roots = reachedFrom.get(f.dir) ?? (carrier ? reachedFrom.get(carrier.dir) : undefined);
      return { name: f.name, version: f.version, path: rel(f.dir), verdict, chain: chains.get(f.dir) ?? [],
        reachedFrom: roots ? [...roots].sort() : [] };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    packages,
    violations: packages.filter((p) => !p.verdict.allowed),
    errors,
    unusedReviewed: reviewedKeys.filter((k) => !usedReviewed.has(k)).sort(),
    errorReachedFrom: new Map([
      ...[...rejected].map(([dir, error]) => [error, [...(rejectedFrom.get(dir) ?? [])].sort()] as [string, string[]]),
      ...pathErrors.flatMap(([path, error]) => {
        // The deepest package that holds the path; none (the root node_modules itself) is a tree problem.
        const owner = [...found.values()].filter((f) => path.startsWith(f.dir + sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
        return owner ? [[error, [...(reachedFrom.get(owner.dir) ?? [])].sort()] as [string, string[]]] : [];
      }),
    ]),
  };
}

/** One line per violation and error, for a build log or a CI annotation. */
export function describeViolations(scan: LicenseScan): string[] {
  const lines = scan.violations.map((p) => {
    const why = p.verdict.allowed ? "" : `${p.verdict.license}: ${p.verdict.reason}`;
    const via = p.chain.length > 0 ? p.chain.join(" > ") : `${p.name}@${p.version} (no dependency path from the root)`;
    return `${p.name}@${p.version} at ${p.path} -- ${why} -- via ${via}`;
  });
  return [...lines, ...scan.errors];
}

const LICENSE_FILE = /^(?:(?:mit|bsd|apache)[-_.])?(?:licen[cs]e|copying|notice|unlicense)(?:[-._][\w.-]*)?$/i;
const MAX_LICENSE_FILE_BYTES = 256 * 1024;
/** Per package, and for the whole file: a crafted package cannot inflate it without bound. */
const MAX_LICENSE_FILES_PER_PACKAGE = 8;
export const MAX_NOTICES_BYTES = 64 * 1024 * 1024;

function licenseTexts(root: string, pkgPath: string): Array<{ file: string; text: string }> {
  const dir = join(root, pkgPath);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; text: string }> = [];
  const matching = names.filter((n) => LICENSE_FILE.test(n)).sort();
  for (const n of matching.slice(MAX_LICENSE_FILES_PER_PACKAGE)) out.push({ file: n, text: "(not reproduced: more than " + MAX_LICENSE_FILES_PER_PACKAGE + " license files in this package)" });
  for (const n of matching.slice(0, MAX_LICENSE_FILES_PER_PACKAGE)) {
    const p = join(dir, n);
    try {
      const st = lstatSync(p);
      // Regular files only: a link could point anywhere on the build host.
      if (!st.isFile()) continue;
      if (st.size > MAX_LICENSE_FILE_BYTES) {
        out.push({ file: n, text: `(not reproduced: ${st.size} bytes, over ${MAX_LICENSE_FILE_BYTES})` });
        continue;
      }
      out.push({ file: n, text: readFileSync(p, "utf8").replace(/\r\n/g, "\n").trimEnd() });
    } catch {}
  }
  return out;
}

/**
 * The notices file for a scanned tree: every package with its license, the
 * weak-copyleft ones listed first and on their own, then each package's
 * license and notice files verbatim. Deterministic for a given tree.
 */
export function renderNotices(
  root: string,
  scan: LicenseScan,
  title: string,
  opts: { activepiecesLicense?: string } = {},
): string {
  const realRoot = realpathSync(root);
  const allowed = scan.packages.filter((p) => p.verdict.allowed);
  const weak = [...new Map(
    allowed
      .filter((p) => p.verdict.allowed && p.verdict.category === "weak-copyleft")
      .map((p) => [`${p.name}@${p.version}`, p] as const),
  ).values()];
  const out: string[] = [];
  const p = (s = "") => out.push(s);
  const fence = (text: string) => {
    // A fence longer than any backtick run in the text, so it cannot close early.
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    return "`".repeat(longest + 1);
  };
  p(`# ${title}`);
  p();
  p("Generated by the license scan (#971) from the installed tree. Each package is distributed under its own license, reproduced below where the package ships one.");
  p();
  p("## Weak-copyleft packages (LGPL / MPL), used unmodified");
  p();
  if (weak.length === 0) p("None.");
  for (const w of weak) p(`- ${w.name}@${w.version} -- ${w.verdict.allowed ? w.verdict.license : ""} -- https://www.npmjs.com/package/${w.name}/v/${w.version}`);
  p();
  p("## All packages");
  p();
  // A hoisted tree can hold the same release in several places; list it once.
  const seen = new Set<string>();
  const unique = allowed.filter((a) => {
    const k = `${a.name}@${a.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const a of unique) {
    const v = a.verdict;
    if (!v.allowed) continue;
    const basis = v.basis === "declared" ? "" : v.basis === "reviewed" ? " (reviewed: " + (v.note ?? "") + ")" : " (" + (v.note ?? "") + ")";
    p(`- ${a.name}@${a.version} -- ${v.license}${basis}`);
  }
  // Catalog pieces and the Activepieces SDK packages ship no LICENSE file of
  // their own; the monorepo license they take is reproduced once.
  const upstream = unique.filter((a) => a.verdict.allowed && a.verdict.basis === "activepieces-upstream");
  if (upstream.length > 0 && opts.activepiecesLicense) {
    p();
    p("## Activepieces monorepo license");
    p();
    p(`Applies to the ${upstream.length} package(s) above marked as from the Activepieces monorepo, all outside its /ee/ directories:`);
    p();
    const f = fence(opts.activepiecesLicense);
    p(f);
    p(opts.activepiecesLicense.trimEnd());
    p(f);
  }
  p();
  p("## License texts");
  for (const a of unique) {
    const texts = licenseTexts(realRoot, a.path);
    if (texts.length === 0) continue;
    p();
    p(`### ${a.name}@${a.version}`);
    for (const t of texts) {
      p();
      p(`${t.file}:`);
      p();
      const f = fence(t.text);
      p(f);
      p(t.text);
      p(f);
    }
  }
  const text = out.join("\n") + "\n";
  // Measured on the shared tree (2026-10-21): 833 KB. Far past that is
  // a package stuffing the file, and the build should say so, not ship it.
  if (Buffer.byteLength(text) > MAX_NOTICES_BYTES) throw new Error(`the notices would be ${Buffer.byteLength(text)} bytes, over ${MAX_NOTICES_BYTES}`);
  return text;
}
