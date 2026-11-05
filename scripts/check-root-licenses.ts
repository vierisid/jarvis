#!/usr/bin/env bun
/**
 * License-check the brain's own install (#1166).
 *
 * The hosted pieces tree (#971), self-managed piece installs and the engine
 * staging install (which also holds the vendored core pieces' dependencies,
 * #961) are already held to the policy in
 * src/workflows/pieces-library/license-policy.ts. This applies the same
 * policy to every package `bun install --frozen-lockfile` puts in the
 * repository's own node_modules. Dev dependencies count too: the Docker image
 * copies that whole node_modules (Dockerfile, deps stage), so it ships them.
 *
 * It vouches for the versions bun.lock pins, which CI and the Docker image
 * install. The published npm package carries no bun.lock, so an install from
 * npm resolves the semver ranges afresh and can get newer releases.
 *
 * A violation listed in KNOWN_ROOT_VIOLATIONS is reported but does not fail,
 * so the check can run before the owner has decided what to do with it. Each
 * entry is an exact name@version with the exact license it declares, and an
 * entry that no longer matches anything fails the check, so the list cannot
 * outlive what it describes. It is not a review: the policy still denies the
 * package, and the notices say so.
 *
 *   bun run scripts/check-root-licenses.ts [--dir <repo root>]
 *
 * Exit 0 when every installed package is allowed (or a known violation),
 * 1 on any other problem.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CATALOG } from "../src/workflows/pieces-library/catalog";
import { describeViolations, scanInstalledTree, type LicenseScan } from "../src/workflows/pieces-library/license-scan";

export interface KnownViolation {
  /** The license the release declares, exactly as the scan reports it. */
  license: string;
  /** Why it is still here, and where the decision is tracked. */
  reason: string;
}

/** Denied installed packages awaiting an owner decision, by exact `name@version`. */
export const KNOWN_ROOT_VIOLATIONS: Readonly<Record<string, KnownViolation>> = {
  "edge-tts-universal@1.4.0": {
    license: "AGPL-3.0",
    reason:
      "Edge TTS client used by src/comms/voice.ts. AGPL-3.0 is not allowed by the policy; replacing, " +
      "isolating or accepting it is an open owner decision in #1166. Its dependency xml-escape@1.1.0 has a " +
      "REVIEWED_LICENSES entry added for this tree: remove both together.",
  },
};

export interface RootLicenseCheck {
  ok: boolean;
  /** One line per problem that fails the check. */
  problems: string[];
  /** Known violations still present, one line each. */
  known: string[];
  /** Packages decided, the known violations included. */
  packages: number;
}

/**
 * Decide every package in an installed tree, and check the tree is installed
 * at all: each dependency the root manifest or an installed package requires
 * (optional and peer dependencies aside, which bun may leave out) must be on
 * disk, or a missing tree would pass as clean. `known` overrides
 * KNOWN_ROOT_VIOLATIONS; tests only.
 */
export function checkRootLicenses(
  root: string,
  opts: { known?: Readonly<Record<string, KnownViolation>>; catalogPackages?: ReadonlySet<string> } = {},
): RootLicenseCheck {
  const known = opts.known ?? KNOWN_ROOT_VIOLATIONS;
  // A catalog piece published with no license field takes upstream MIT, as on
  // the hosted tree and self-managed installs (#970).
  const catalogPackages = opts.catalogPackages ?? new Set(CATALOG.map((e) => e.npmPackage));
  const scan: LicenseScan = scanInstalledTree(root, { catalogPackages, lockfile: "required" });
  const problems: string[] = [];
  const knownLines: string[] = [];
  const matched = new Set<string>();
  const lines = describeViolations({ ...scan, errors: [] });
  scan.violations.forEach((v, i) => {
    const key = `${v.name}@${v.version}`;
    const entry = Object.hasOwn(known, key) ? known[key] : undefined;
    if (entry && entry.license === v.verdict.license) {
      matched.add(key);
      knownLines.push(`${lines[i]} -- known: ${entry.reason}`);
    } else {
      problems.push(lines[i]!);
    }
  });
  problems.push(...scan.errors);
  for (const key of Object.keys(known)) {
    if (!matched.has(key)) problems.push(`KNOWN_ROOT_VIOLATIONS lists ${key}, but no installed package matches it any more: remove the entry`);
  }
  problems.push(...missingDependencies(root, scan));
  return { ok: problems.length === 0, problems, known: knownLines, packages: scan.packages.length };
}

/**
 * Required dependencies that no installed package answers to, matched by name
 * anywhere in the tree rather than by Node resolution: enough to stop an empty
 * or partial install passing as clean, since every package on disk is scanned.
 */
function missingDependencies(root: string, scan: LicenseScan): string[] {
  const installed = new Set(scan.packages.map((p) => p.name));
  const required = (pkg: Record<string, unknown>): string[] => {
    const deps = pkg.dependencies;
    return deps && typeof deps === "object" && !Array.isArray(deps) ? Object.keys(deps) : [];
  };
  const out: string[] = [];
  const read = (dir: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>; } catch { return null; }
  };
  const rootPkg = read(root);
  if (rootPkg === null) return ["the root package.json cannot be read"];
  for (const name of [...required(rootPkg), ...required({ dependencies: rootPkg.devDependencies })]) {
    if (!installed.has(name)) out.push(`${name} is a dependency of the root package.json but is not installed`);
  }
  for (const p of scan.packages) {
    const pkg = read(join(root, p.path));
    if (pkg === null) continue;
    for (const name of required(pkg)) {
      if (!installed.has(name)) out.push(`${name} is a dependency of ${p.name}@${p.version} but is not installed`);
    }
  }
  return out;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--dir");
  const dir = resolve(i >= 0 ? (process.argv[i + 1] ?? ".") : resolve(import.meta.dir, ".."));
  const result = checkRootLicenses(dir);
  for (const line of result.known) console.log(`known: ${line}`);
  if (!result.ok) {
    console.error(`The license check found ${result.problems.length} problem(s) in the brain's install (#1166):`);
    for (const line of result.problems) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`licenses: ${result.packages} package(s) decided, ${result.known.length} of them known violations`);
}
