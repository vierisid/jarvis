/**
 * The license policy for installed pieces trees (#971). Each owner rule has a
 * case here that fails without it:
 *   - LGPL and MPL are allowed, as weak copyleft (listed apart in the notices);
 *   - no license is denied unless reviewed, and the reviewed license must pass;
 *   - a known denied license cannot be reviewed into an allowed one.
 */

import { describe, expect, test } from "bun:test";
import {
  ACTIVEPIECES_UPSTREAM_MIT,
  declaredLicense,
  evaluateLicenseExpression,
  readDeclaration,
  evaluatePackage,
  parseSpdxExpression,
  REVIEWED_LICENSES,
} from "./license-policy";

const lic = (license: unknown) => ({ name: "x", version: "1.0.0", license });

describe("declared license", () => {
  test("reads the license string, the legacy object, and the legacy array as alternatives", () => {
    expect(declaredLicense(lic("MIT"))).toBe("MIT");
    expect(declaredLicense(lic({ type: "ISC", url: "u" }))).toBe("ISC");
    expect(declaredLicense({ licenses: [{ type: "MIT", url: "u" }] })).toBe("MIT");
    expect(declaredLicense({ licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] })).toBe("(MIT) OR (GPL-2.0)");
  });

  test("absent is only no field, null or an empty string", () => {
    for (const pkg of [{}, lic(""), lic("  "), lic(null), { licenses: null }]) {
      expect(readDeclaration(pkg)).toEqual({ kind: "absent" });
    }
  });

  test("a field in an undocumented shape is unreadable, not absent", () => {
    for (const pkg of [
      lic(["GPL-3.0"]),
      lic({ name: "GPL-3.0" }),
      lic(3),
      { licenses: [{ type: "MIT" }, { url: "u" }] },
      { licenses: [{ type: "AGPL-3.0" }, { url: "u" }] },
      { licenses: [] },
      { licenses: "MIT" },
    ]) {
      expect(readDeclaration(pkg).kind).toBe("unreadable");
      expect(declaredLicense(pkg)).toBeNull();
    }
  });
});

describe("SPDX expressions", () => {
  test("parses ids, OR, AND, parentheses and WITH; rejects free text", () => {
    expect(parseSpdxExpression("MIT")).not.toBeNull();
    expect(parseSpdxExpression("(MIT OR Apache-2.0)")).not.toBeNull();
    expect(parseSpdxExpression("(BSD-2-Clause OR MIT OR Apache-2.0)")).not.toBeNull();
    expect(parseSpdxExpression("GPL-2.0 WITH Classpath-exception-2.0")).not.toBeNull();
    for (const bad of ["SEE LICENSE IN LICENSE.md", "MIT License", "Apache 2.0", "(MIT", "MIT OR", "AND MIT", ""]) {
      expect(parseSpdxExpression(bad)).toBeNull();
    }
  });

  test("permissive ids are allowed, case-insensitively", () => {
    for (const id of ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Zlib", "mit"]) {
      expect(evaluateLicenseExpression(id)).toEqual({ valid: true, category: "permissive" });
    }
  });

  test("LGPL and MPL are allowed as weak copyleft, in current and deprecated forms (owner decision)", () => {
    for (const id of ["LGPL-2.1-only", "LGPL-3.0-or-later", "LGPL-3.0+", "LGPL-3.0", "LGPL-2.1", "MPL-2.0", "MPL-1.1"]) {
      expect(evaluateLicenseExpression(id)).toEqual({ valid: true, category: "weak-copyleft" });
    }
  });

  test("strong copyleft, source-available and unknown ids are denied", () => {
    for (const id of ["GPL-3.0-only", "GPL-2.0", "AGPL-3.0-or-later", "SSPL-1.0", "BUSL-1.1", "Elastic-2.0", "EPL-2.0", "CC-BY-NC-4.0", "WTFPL", "BSD"]) {
      expect(evaluateLicenseExpression(id).category).toBeNull();
    }
  });

  test("OR takes an allowed branch; AND needs every operand; WITH is never allowed", () => {
    expect(evaluateLicenseExpression("(MIT OR GPL-3.0-only)").category).toBe("permissive");
    expect(evaluateLicenseExpression("(GPL-3.0-only OR LGPL-3.0-only)").category).toBe("weak-copyleft");
    expect(evaluateLicenseExpression("(MIT OR WTFPL)").category).toBe("permissive");
    expect(evaluateLicenseExpression("(MIT AND Zlib)").category).toBe("permissive");
    expect(evaluateLicenseExpression("MIT AND LGPL-3.0-only").category).toBe("weak-copyleft");
    expect(evaluateLicenseExpression("(MIT AND GPL-3.0-only)").category).toBeNull();
    // AND binds tighter than OR: GPL OR (MIT AND AGPL) is denied on both sides.
    expect(evaluateLicenseExpression("GPL-3.0-only OR MIT AND AGPL-3.0-only").category).toBeNull();
    // Null if OR bound tighter: (MIT OR GPL) AND AGPL.
    expect(evaluateLicenseExpression("MIT OR GPL-3.0-only AND AGPL-3.0-only").category).toBe("permissive");
    // OR takes the most permissive allowed branch, in either order.
    expect(evaluateLicenseExpression("(MIT OR LGPL-3.0-only)").category).toBe("permissive");
    expect(evaluateLicenseExpression("(LGPL-3.0-only OR MIT)").category).toBe("permissive");
    expect(evaluateLicenseExpression("Apache-2.0 WITH LLVM-exception").category).toBeNull();
  });
});

describe("evaluatePackage", () => {
  const none = {};

  test("a declared allowed license is allowed on its own", () => {
    const v = evaluatePackage("a", "1.0.0", lic("MIT"), { reviewed: {} });
    expect(v).toMatchObject({ allowed: true, basis: "declared", category: "permissive" });
  });

  test("LGPL is allowed and marked weak copyleft (owner decision)", () => {
    const v = evaluatePackage("openpgp", "6.3.0", lic("LGPL-3.0+"), { reviewed: {} });
    expect(v).toMatchObject({ allowed: true, category: "weak-copyleft", license: "LGPL-3.0+" });
  });

  test("a package with no license is denied (owner decision)", () => {
    const v = evaluatePackage("absurd-sql", "0.0.54", none, { reviewed: {} });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/no license declared/);
  });

  test("...unless that exact release is on the reviewed list, as the license recorded there", () => {
    const reviewed = { "absurd-sql@0.0.54": { declared: null, license: "MIT", reason: "ships the MIT text in LICENSE" } };
    expect(evaluatePackage("absurd-sql", "0.0.54", none, { reviewed })).toMatchObject({
      allowed: true,
      basis: "reviewed",
      license: "MIT",
    });
    // Another release is another review.
    expect(evaluatePackage("absurd-sql", "0.0.55", none, { reviewed }).allowed).toBe(false);
  });

  test("a reviewed entry whose recorded license is itself denied does not allow the package", () => {
    const reviewed = { "x@1.0.0": { declared: null, license: "GPL-3.0-only", reason: "r" } };
    expect(evaluatePackage("x", "1.0.0", none, { reviewed }).allowed).toBe(false);
  });

  test("SEE LICENSE IN, free text and unknown ids are denied, and can be reviewed", () => {
    const reviewed = {
      "a@1.0.0": { declared: "SEE LICENSE IN LICENSE", license: "MIT", reason: "r" },
      "b@1.0.0": { declared: "MIT License", license: "MIT", reason: "r" },
      "c@1.0.0": { declared: "BSD", license: "BSD-3-Clause", reason: "r" },
      "d@1.0.0": { declared: "LGPLv3", license: "LGPL-3.0-only", reason: "r" },
      "e@1.0.0": { declared: "Apache-2.0 WITH LLVM-exception", license: "Apache-2.0", reason: "r" },
    };
    for (const [n, text] of [
      ["a", "SEE LICENSE IN LICENSE"],
      ["b", "MIT License"],
      ["c", "BSD"],
      // An LGPL spelling the parser does not know is the owner-allowed family: reviewable.
      ["d", "LGPLv3"],
      // An exception on an allowed base is read by a person, not hard-denied.
      ["e", "Apache-2.0 WITH LLVM-exception"],
    ] as const) {
      expect(evaluatePackage(n, "1.0.0", lic(text), { reviewed: {} }).allowed).toBe(false);
      expect(evaluatePackage(n, "1.0.0", lic(text), { reviewed })).toMatchObject({ allowed: true, basis: "reviewed" });
    }
  });

  test("a known denied license cannot be reviewed into an allowed one, parsed or free text", () => {
    const cases: Array<[string, string]> = [
      ["hyperformula", "GPL-3.0-only"],
      ["ua-parser-js", "AGPL-3.0-or-later"],
      ["w", "GPL-2.0 WITH Classpath-exception-2.0"],
      ["f1", "GPL-3.0 and MIT"],
      ["f2", "GPL-3.0 with Classpath-exception-2.0"],
      ["f3", "GNU GPL v3"],
      ["f4", "AGPL-3.0, MIT"],
      ["f5", "GPL-3.0/MIT"],
      ["f6", "SSPL-1.0 or MIT"],
      // An exception that takes rights away is as denied as a base license.
      ["x1", "Apache-2.0 WITH Commons-Clause"],
      // Spelled out in words.
      ["p1", "MIT + Commons Clause"],
      ["p2", "GNU General Public License v3"],
      ["p3", "Server Side Public License"],
      ["p4", "Business Source License 1.1"],
      ["p5", "GNU Affero"],
    ];
    for (const [n, text] of cases) {
      const reviewed = { [`${n}@1.0.0`]: { declared: text, license: "MIT", reason: "wishful" } };
      expect({ text, allowed: evaluatePackage(n, "1.0.0", lic(text), { reviewed }).allowed }).toEqual({ text, allowed: false });
    }
  });

  test("an unreadable field naming a denied license cannot be reviewed into an allowed one", () => {
    for (const pkg of [lic(["GPL-3.0"]), lic({ name: "AGPL-3.0" })]) {
      const raw = JSON.stringify({ license: pkg.license, licenses: null });
      const reviewed = { "x@1.0.0": { declared: raw, license: "MIT", reason: "wishful" } };
      expect(evaluatePackage("x", "1.0.0", pkg, { reviewed }).allowed).toBe(false);
    }
    // ...while one naming nothing denied can be.
    const ok = lic({ name: "MIT" });
    const reviewed = { "x@1.0.0": { declared: JSON.stringify({ license: ok.license, licenses: null }), license: "MIT", reason: "r" } };
    expect(evaluatePackage("x", "1.0.0", ok, { reviewed }).allowed).toBe(true);
  });

  test("LGPL spelled out in words is not mistaken for GPL", () => {
    const reviewed = { "l@1.0.0": { declared: "GNU Lesser General Public License v3", license: "LGPL-3.0-only", reason: "r" } };
    expect(evaluatePackage("l", "1.0.0", lic("GNU Lesser General Public License v3"), { reviewed }).allowed).toBe(true);
  });

  test("a reviewed entry for a bundled copy holds only where it was reviewed", () => {
    const at = "carrier@1.0.0:cli/node_modules/b";
    const reviewed = { "b@1.0.0": { declared: null, license: "MIT", reason: "r", bundledAt: at } };
    expect(evaluatePackage("b", "1.0.0", {}, { reviewed, upstream: false, bundledAt: at }).allowed).toBe(true);
    // The same name and version carried by another tarball.
    expect(evaluatePackage("b", "1.0.0", {}, { reviewed, upstream: false, bundledAt: "evil@1.0.0:lib/node_modules/b" }).allowed).toBe(false);
    // Or installed by bun from the registry, where the entry did not look.
    expect(evaluatePackage("b", "1.0.0", {}, { reviewed }).allowed).toBe(false);
    // And an entry for the registry copy does not clear a bundled one.
    const plain = { "b@1.0.0": { declared: null, license: "MIT", reason: "r" } };
    expect(evaluatePackage("b", "1.0.0", {}, { reviewed: plain, upstream: false, bundledAt: at }).allowed).toBe(false);
  });

  test("a reviewed entry holds only while the release declares what the reviewer saw", () => {
    const reviewed = { "p@1.0.0": { declared: "SEE LICENSE IN LICENSE", license: "MIT", reason: "r" } };
    expect(evaluatePackage("p", "1.0.0", lic("SEE LICENSE IN LICENSE"), { reviewed }).allowed).toBe(true);
    expect(evaluatePackage("p", "1.0.0", lic("SEE LICENSE IN EULA"), { reviewed }).allowed).toBe(false);
    expect(evaluatePackage("p", "1.0.0", {}, { reviewed }).allowed).toBe(false);
  });

  test("UNLICENSED is denied, reviewed or not", () => {
    const reviewed = { "p@1.0.0": { declared: "UNLICENSED", license: "MIT", reason: "r" } };
    expect(evaluatePackage("p", "1.0.0", lic("UNLICENSED"), { reviewed }).allowed).toBe(false);
  });

  test("Activepieces upstream packages with no license field take upstream MIT; a stranger does not", () => {
    for (const name of Object.keys(ACTIVEPIECES_UPSTREAM_MIT)) {
      expect(evaluatePackage(name, "9.9.9", none, { reviewed: {} })).toMatchObject({
        allowed: true,
        basis: "activepieces-upstream",
      });
    }
    expect(evaluatePackage("@activepieces/ee-thing", "1.0.0", none, { reviewed: {} }).allowed).toBe(false);
    // Own keys only: a name that is an Object.prototype property is a stranger.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(evaluatePackage(name, "1.0.0", none, { reviewed: {} }).allowed).toBe(false);
    }
  });

  test("a catalog piece with no license field takes upstream MIT; a piece outside the catalog does not", () => {
    const catalogPackages = new Set(["@activepieces/piece-gmail"]);
    expect(evaluatePackage("@activepieces/piece-gmail", "1.0.0", none, { catalogPackages, reviewed: {} }).allowed).toBe(true);
    expect(evaluatePackage("@activepieces/piece-other", "1.0.0", none, { catalogPackages, reviewed: {} }).allowed).toBe(false);
  });

  test("a catalog piece that DECLARES a denied license is denied: upstream MIT is only for a missing field", () => {
    const catalogPackages = new Set(["@activepieces/piece-gmail"]);
    expect(evaluatePackage("@activepieces/piece-gmail", "1.0.0", lic("AGPL-3.0-only"), { catalogPackages, reviewed: {} }).allowed).toBe(false);
    expect(evaluatePackage("@activepieces/shared", "1.0.0", lic("SSPL-1.0"), { reviewed: {} }).allowed).toBe(false);
  });

  test("a catalog piece whose declaration is there but unreadable gets no upstream MIT", () => {
    const catalogPackages = new Set(["@activepieces/piece-gmail"]);
    for (const pkg of [lic(["GPL-3.0"]), lic({ name: "GPL-3.0" }), lic(3), lic("SEE LICENSE IN EULA"), { licenses: [{ type: "AGPL-3.0" }, { url: "u" }] }]) {
      expect(evaluatePackage("@activepieces/piece-gmail", "1.0.0", pkg, { catalogPackages, reviewed: {} }).allowed).toBe(false);
      expect(evaluatePackage("@activepieces/shared", "1.0.0", pkg, { reviewed: {} }).allowed).toBe(false);
    }
  });
});

describe("the reviewed list as committed", () => {
  test("every entry is an exact name@version with a reason and a license the policy allows", () => {
    for (const [key, entry] of Object.entries(REVIEWED_LICENSES)) {
      expect(key).toMatch(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      expect(entry.declared === null || typeof entry.declared === "string").toBe(true);
      expect(evaluateLicenseExpression(entry.license).category).not.toBeNull();
    }
  });

  test("browser-request@0.3.3 (no license field, Apache-2.0 LICENSE) passes as the copy bun installs, and only that copy", () => {
    const pkg = { name: "browser-request", version: "0.3.3" };
    expect(evaluatePackage("browser-request", "0.3.3", pkg)).toMatchObject({
      allowed: true,
      license: "Apache-2.0",
      category: "permissive",
      basis: "reviewed",
    });
    expect(evaluatePackage("browser-request", "0.3.4", { ...pkg, version: "0.3.4" }).allowed).toBe(false);
    expect(evaluatePackage("browser-request", "0.3.3", { ...pkg, license: "GPL-3.0-only" }).allowed).toBe(false);
    expect(evaluatePackage("browser-request", "0.3.3", pkg, { bundledAt: "x@1.0.0:node_modules/browser-request" }).allowed).toBe(false);
  });
});
