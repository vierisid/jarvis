/**
 * License policy for what bun actually installs from the pieces catalog (#971).
 *
 * The catalog test (#970) checks what we LIST: each piece's source at the
 * pinned upstream SHA. This file decides what may be in an installed tree,
 * package by package, from the `package.json` bun wrote to disk: the piece
 * release a caret range resolved to, and every dependency it pulled in.
 *
 * The rules (owner decision on #971):
 *   - Permissive licenses are allowed.
 *   - LGPL and MPL (weak copyleft) are allowed, as unmodified npm packages,
 *     and are listed on their own in the generated notices.
 *   - A package with no usable license declaration (no field, an empty one,
 *     a field in a shape npm does not document, `SEE LICENSE IN ...`, text that
 *     is not an SPDX expression, or an id this policy does not know, such as
 *     `BSD`) is denied
 *     unless it is on REVIEWED_LICENSES, where a person recorded the license
 *     they found and why. That recorded license must itself pass this policy.
 *   - Everything else is denied: GPL, AGPL, SSPL, BUSL, Elastic, Commons
 *     Clause, `UNLICENSED`, an exception (`X WITH y`), any id not listed here.
 *     A license this policy knows and denies cannot be allow-listed, whether
 *     the declaration parses or only names it in free text (`GPL-3.0/MIT`):
 *     the allow-list answers "what license is this really", never "ship it
 *     anyway". An entry records the exact declaration it overrides.
 *
 * Enforced where we distribute: scripts/build-shared-runtime.ts refuses to
 * build the hosted shared tree on any violation, and the weekly catalog sync
 * runs the same scan first (scripts/check-piece-licenses.ts).
 */

/** Permissive licenses, by canonical SPDX id. */
export const PERMISSIVE_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-1-Clause",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  // pako@2.2.0 in the shared tree declares "(MIT AND Zlib)" (measured on the
  // full catalog install, 2026-10-21). Zlib is a permissive, non-copyleft license.
  "Zlib",
]);

/**
 * Weak copyleft, allowed as unmodified npm dependencies and listed apart in
 * the notices. Canonical ids; the deprecated forms npm still sees
 * (`LGPL-3.0`, `LGPL-3.0+`) are mapped onto these by `canonicalId`.
 */
export const WEAK_COPYLEFT_LICENSES: ReadonlySet<string> = new Set([
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MPL-1.1",
  "MPL-2.0",
  "MPL-2.0-no-copyleft-exception",
]);

export type LicenseCategory = "permissive" | "weak-copyleft";

/**
 * Packages whose source is in the Activepieces monorepo outside every `/ee/`
 * path, published without a `license` field. The monorepo LICENSE puts
 * everything outside `ee` under MIT, which is what #970 asserts for each
 * listed piece. Keyed by name, not version: these three are released from
 * the same monorepo paths with every upstream release, and a tree holds
 * several versions of each at once (measured: shared 0.53.2, 0.57.2, 0.60.0).
 * Catalog pieces (`@activepieces/piece-*`) get the same treatment from the
 * catalog's own package list, passed to `evaluatePackage` by the caller.
 */
export const ACTIVEPIECES_UPSTREAM_MIT: Readonly<Record<string, string>> = {
  "@activepieces/pieces-framework": "packages/pieces/framework in the Activepieces monorepo, outside /ee/",
  "@activepieces/pieces-common": "packages/pieces/common in the Activepieces monorepo, outside /ee/",
  "@activepieces/shared": "packages/shared in the Activepieces monorepo, outside /ee/",
};

export interface ReviewedLicense {
  /**
   * What the release declares, exactly as `declarationText` renders it: null
   * for no declaration at all. The entry applies only while that still holds,
   * so the diff that adds it shows the text being overridden, and a release
   * that changes its declaration needs a new review.
   */
  declared: string | null;
  /** The SPDX expression a person found for this exact release. Must pass the policy. */
  license: string;
  /** What was checked, so the next reviewer can tell whether it still holds. */
  reason: string;
  /**
   * For a copy bundled inside another package's tarball (bun.lock does not
   * list it, so its name is only its own claim): `carrier@version:path`, as
   * the scan reports it. Required for a bundled copy, absent otherwise.
   */
  bundledAt?: string;
}

/**
 * Reviewed packages whose declaration the policy cannot read, keyed by exact
 * `name@version`. A new release is a new review: the weekly sync scan names it.
 */
export const REVIEWED_LICENSES: Readonly<Record<string, ReviewedLicense>> = {
  "taffydb@2.6.2": {
    declared: null,
    bundledAt: "protobufjs@6.11.6:cli/node_modules/taffydb",
    license: "BSD-1-Clause",
    reason:
      "package.json has no license field and there is no LICENSE file; taffy.js opens with " +
      "\"Software License Agreement (BSD License)\", one condition (retain the copyright notice) and " +
      "the BSD disclaimer, which is BSD-1-Clause. Bundled inside protobufjs@6.11.6 at cli/node_modules " +
      "(reviewed 2026-10-21).",
  },
  // absurd-sql@0.0.54 would need one too, as MIT (no license field, ships
  // the MIT text in LICENSE), but only @actual-app/core pulls it and
  // actualbudget is SHARED_BUILD_EXCLUDED, so it is not in the shared tree.
};

/** How a package's license was decided. */
export type LicenseVerdict =
  | {
      allowed: true;
      /** The expression the decision rests on (declared, upstream or reviewed). */
      license: string;
      category: LicenseCategory;
      basis: "declared" | "activepieces-upstream" | "reviewed";
      note?: string;
    }
  | { allowed: false; license: string; reason: string };

/** Canonical SPDX ids for case-insensitive matching, plus deprecated forms. */
const CANONICAL = new Map<string, string>();
for (const id of [...PERMISSIVE_LICENSES, ...WEAK_COPYLEFT_LICENSES]) CANONICAL.set(id.toLowerCase(), id);
for (const [alias, id] of [
  ["LGPL-2.0", "LGPL-2.0-only"],
  ["LGPL-2.0+", "LGPL-2.0-or-later"],
  ["LGPL-2.1", "LGPL-2.1-only"],
  ["LGPL-2.1+", "LGPL-2.1-or-later"],
  ["LGPL-3.0", "LGPL-3.0-only"],
  ["LGPL-3.0+", "LGPL-3.0-or-later"],
] as const) {
  CANONICAL.set(alias.toLowerCase(), id);
}

function canonicalId(id: string): string | null {
  return CANONICAL.get(id.toLowerCase()) ?? null;
}

type Expr =
  | { kind: "id"; id: string }
  | { kind: "with"; id: string; exception: string }
  | { kind: "and" | "or"; left: Expr; right: Expr };

/** SPDX license-expression ids: letters, digits, `.`, `-`, and a trailing `+`. */
const ID_TOKEN = /^[A-Za-z0-9.-]+\+?$/;

/**
 * Parse an SPDX license expression (`MIT`, `(MIT OR Apache-2.0)`,
 * `MIT AND Zlib`, `GPL-2.0 WITH Classpath-exception-2.0`). AND binds tighter
 * than OR. Operators are upper-case, as SPDX writes them. Returns null for
 * anything that is not an expression, so free text is never read as one.
 */
export function parseSpdxExpression(text: string): Expr | null {
  const tokens = text.replace(/[()]/g, (p) => ` ${p} `).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  let i = 0;
  const peek = () => tokens[i];
  const operand = (): Expr | null => {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t === "(") {
      const inner = or();
      if (!inner || tokens[i++] !== ")") return null;
      return inner;
    }
    if (t === ")" || t === "AND" || t === "OR" || t === "WITH" || !ID_TOKEN.test(t)) return null;
    if (peek() === "WITH") {
      i++;
      const exception = tokens[i++];
      if (exception === undefined || !ID_TOKEN.test(exception)) return null;
      return { kind: "with", id: t, exception };
    }
    return { kind: "id", id: t };
  };
  const and = (): Expr | null => {
    let left = operand();
    while (left && peek() === "AND") {
      i++;
      const right = operand();
      if (!right) return null;
      left = { kind: "and", left, right };
    }
    return left;
  };
  const or = (): Expr | null => {
    let left = and();
    while (left && peek() === "OR") {
      i++;
      const right = and();
      if (!right) return null;
      left = { kind: "or", left, right };
    }
    return left;
  };
  const expr = or();
  return expr && i === tokens.length ? expr : null;
}

const RANK: Record<LicenseCategory, number> = { permissive: 0, "weak-copyleft": 1 };

/**
 * The category of the terms we take, or null when the expression is denied.
 * OR: the most permissive allowed branch. AND: every operand must be allowed,
 * and the result is the most restrictive of them.
 */
function evaluateExpr(e: Expr): LicenseCategory | null {
  switch (e.kind) {
    case "id": {
      const id = canonicalId(e.id);
      if (id === null) return null;
      return PERMISSIVE_LICENSES.has(id) ? "permissive" : "weak-copyleft";
    }
    case "with":
      // An exception changes the terms; no exception has been reviewed.
      return null;
    case "or": {
      const l = evaluateExpr(e.left);
      const r = evaluateExpr(e.right);
      if (l === null) return r;
      if (r === null) return l;
      return RANK[l] <= RANK[r] ? l : r;
    }
    case "and": {
      const l = evaluateExpr(e.left);
      const r = evaluateExpr(e.right);
      if (l === null || r === null) return null;
      return RANK[l] >= RANK[r] ? l : r;
    }
  }
}

/**
 * SPDX ids this policy knows and denies: strong copyleft, source-available and
 * non-commercial licenses, and the weak-copyleft families the owner did not
 * allow (EPL, CDDL, EUPL, ...). Matched by prefix so every version is covered.
 */
// LGPL is not here: the owner allowed it, so an LGPL spelling the parser does
// not know (`LGPL`, `LGPLv3`) goes to review rather than to a hard deny.
const KNOWN_DENIED = /^(?:A?GPL|SSPL|BUSL|Elastic|EUPL|EPL|CDDL|CPAL|CPL|OSL|RPL|RPSL|QPL|Sleepycat|Watcom|CC-BY-NC|CC-BY-ND|CC-BY-SA|CECILL|MS-RL|APSL|Commons-Clause|PolyForm)/i;

/** True when any leaf names a known denied license (an exception's base included). */
function namesKnownDenied(e: Expr): boolean {
  switch (e.kind) {
    case "id":
      return canonicalId(e.id) === null && KNOWN_DENIED.test(e.id);
    case "with":
      // The exception may only add permissions (LLVM-exception); a person
      // reads it. A denied base stays denied whatever the exception says, and
      // an exception that takes rights away (Commons-Clause) is caught by
      // the word check evaluatePackage runs on every declaration.
      return canonicalId(e.id) === null && KNOWN_DENIED.test(e.id);
    case "and":
    case "or":
      return namesKnownDenied(e.left) || namesKnownDenied(e.right);
  }
}

/**
 * For text that is not an SPDX expression: does any word in it name a known
 * denied license (`GPL-3.0/MIT`, `GNU GPL v3`, `AGPL-3.0, MIT`)? Such text is
 * denied outright, as a parsed expression would be.
 */
function textNamesKnownDenied(text: string): boolean {
  return (
    text.split(/[^A-Za-z0-9.+-]+/).some((w) => w !== "" && canonicalId(w) === null && KNOWN_DENIED.test(w)) ||
    KNOWN_DENIED_PHRASES.test(text)
  );
}

/** The same licenses spelled out in words. "Lesser General Public" is LGPL, which is allowed. */
const KNOWN_DENIED_PHRASES = /affero|server[\s_-]*side[\s_-]*public|business[\s_-]*source|commons[\s_-]*clause|elastic[\s_-]*license|(?<!lesser[\s_-]*)general[\s_-]*public[\s_-]*licen[cs]e/i;

/** Evaluate an SPDX expression on its own. */
export function evaluateLicenseExpression(text: string): { valid: boolean; category: LicenseCategory | null } {
  const expr = parseSpdxExpression(text);
  if (!expr) return { valid: false, category: null };
  return { valid: true, category: evaluateExpr(expr) };
}

/**
 * What a `package.json` declares about its license:
 *   - absent: no `license` and no `licenses` key, or an empty string. Only
 *     this case lets a catalog or Activepieces package take upstream MIT.
 *   - text: one expression string, from the `license` string or the legacy
 *     forms npm still installs (`license: { type }`, `licenses: [{ type }]`;
 *     several legacy entries are alternatives, as npm documents them).
 *   - unreadable: something is there but it is none of those shapes
 *     (`license: ["GPL-3.0"]`, `license: { name }`, a number). Never
 *     presumed MIT; a person has to read it.
 */
export type Declaration = { kind: "absent" } | { kind: "text"; text: string } | { kind: "unreadable"; raw: string };

export function readDeclaration(pkg: Record<string, unknown>): Declaration {
  const typeOf = (v: unknown): string | null => {
    if (typeof v === "string") return v.trim() || null;
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string") {
      return ((v as { type: string }).type).trim() || null;
    }
    return null;
  };
  const license = pkg["license"];
  const list = pkg["licenses"];
  const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  if (blank(license) && blank(list)) return { kind: "absent" };
  const raw = () => ({ kind: "unreadable" as const, raw: JSON.stringify({ license: license ?? null, licenses: list ?? null }) });
  if (!blank(license)) {
    const t = typeOf(license);
    // A usable `license` wins; an unusable one is unreadable, whatever `licenses` says.
    return t !== null ? { kind: "text", text: t } : raw();
  }
  if (Array.isArray(list)) {
    const types = list.map(typeOf);
    if (types.length > 0 && types.every((t): t is string => t !== null)) {
      return { kind: "text", text: types.length === 1 ? types[0]! : types.map((t) => `(${t})`).join(" OR ") };
    }
  }
  return raw();
}

/** The declaration as one string (null when absent), as a reviewed entry records it. */
export function declarationText(d: Declaration): string | null {
  return d.kind === "absent" ? null : d.kind === "text" ? d.text : d.raw;
}

/** The declared expression, or null when there is none usable. */
export function declaredLicense(pkg: Record<string, unknown>): string | null {
  const d = readDeclaration(pkg);
  return d.kind === "text" ? d.text : null;
}

export interface EvaluateOptions {
  /**
   * npm names of catalog pieces in this tree. A piece published without a
   * license field takes upstream MIT, as #970 checks it at the pinned SHA.
   */
  catalogPackages?: ReadonlySet<string>;
  /**
   * False when the name is only the package's own claim (a copy bundled in
   * another tarball): no upstream MIT presumption then. Default true.
   */
  upstream?: boolean;
  /** Where a bundled copy sits (`carrier@version:path`); a reviewed entry must name it. */
  bundledAt?: string;
  /** Overrides REVIEWED_LICENSES; tests only. */
  reviewed?: Readonly<Record<string, ReviewedLicense>>;
}

/** Decide one installed package. */
export function evaluatePackage(
  name: string,
  version: string,
  pkg: Record<string, unknown>,
  opts: EvaluateOptions = {},
): LicenseVerdict {
  const decl = readDeclaration(pkg);
  const declared = decl.kind === "text" ? decl.text : null;

  if (declared !== null) {
    if (/^UNLICENSED$/i.test(declared)) {
      return { allowed: false, license: declared, reason: "UNLICENSED: the author reserves all rights" };
    }
    const expr = parseSpdxExpression(declared);
    if (expr) {
      const category = evaluateExpr(expr);
      if (category !== null) return { allowed: true, license: declared, category, basis: "declared" };
    }
    // A license we know and deny is decided on what it says, parsed or not:
    // the reviewed list cannot turn it into an allowed one. Only text naming
    // nothing this policy knows (`BSD`, `LicenseRef-...`, `MIT License`) is
    // left for a person to read.
    if (expr ? namesKnownDenied(expr) || textNamesKnownDenied(declared) : textNamesKnownDenied(declared)) {
      return {
        allowed: false,
        license: declared,
        reason: "not an allowed license (permissive, LGPL or MPL only)",
      };
    }
  }

  // The same for a field in an undocumented shape (`license: ["GPL-3.0"]`).
  if (decl.kind === "unreadable" && textNamesKnownDenied(decl.raw)) {
    return { allowed: false, license: decl.raw, reason: "not an allowed license (permissive, LGPL or MPL only)" };
  }

  if (decl.kind === "absent" && opts.upstream !== false) {
    // Own keys only: a package named `constructor` must not find Object's.
    const upstream = Object.hasOwn(ACTIVEPIECES_UPSTREAM_MIT, name) ? ACTIVEPIECES_UPSTREAM_MIT[name] : undefined;
    if (upstream !== undefined) {
      return { allowed: true, license: "MIT", category: "permissive", basis: "activepieces-upstream", note: upstream };
    }
    if (opts.catalogPackages?.has(name)) {
      return {
        allowed: true,
        license: "MIT",
        category: "permissive",
        basis: "activepieces-upstream",
        note: "catalog piece from packages/pieces/community in the Activepieces monorepo (#970)",
      };
    }
  }

  const shown = declarationText(decl);
  const table = opts.reviewed ?? REVIEWED_LICENSES;
  const key = `${name}@${version}`;
  const reviewed = Object.hasOwn(table, key) ? table[key] : undefined;
  if (reviewed) {
    if (reviewed.bundledAt !== opts.bundledAt) {
      return {
        allowed: false,
        license: shown ?? "(none)",
        reason: `on the reviewed list for ${reviewed.bundledAt ? `the copy at ${reviewed.bundledAt}` : "the copy bun installs"}, but this one is ${opts.bundledAt ? `bundled at ${opts.bundledAt}` : "installed by bun"}`,
      };
    }
    if (reviewed.declared !== shown) {
      return {
        allowed: false,
        license: shown ?? "(none)",
        reason: `on the reviewed list for a declaration of ${JSON.stringify(reviewed.declared)}, but this release declares ${JSON.stringify(shown)}`,
      };
    }
    const { category } = evaluateLicenseExpression(reviewed.license);
    if (category !== null) {
      return { allowed: true, license: reviewed.license, category, basis: "reviewed", note: reviewed.reason };
    }
    return {
      allowed: false,
      license: reviewed.license,
      reason: "on the reviewed list, but the license recorded there is not allowed",
    };
  }

  return {
    allowed: false,
    license: shown ?? "(none)",
    reason:
      decl.kind === "absent"
        ? "no license declared, and not on the reviewed list"
        : decl.kind === "unreadable"
          ? "the license field is not in a form npm documents, and the package is not on the reviewed list"
          : "the license is not an SPDX expression this policy can read, and the package is not on the reviewed list",
  };
}
