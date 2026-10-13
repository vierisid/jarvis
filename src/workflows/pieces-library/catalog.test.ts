/**
 * Catalog shape + invariant coverage. These are sanity checks so a stray
 * edit to `catalog.ts`, `catalog-generated.ts`, or `catalog-overrides.ts`
 * doesn't ship broken entries.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CATALOG, catalogById, findCatalogEntry } from "./catalog";
import { GENERATED, GENERATED_FROM_SHA, type GeneratedCatalogEntry } from "./catalog-generated";
import { EXCLUDED, VERIFIED, VERIFIED_METADATA } from "./catalog-overrides";
import { UPSTREAM_PIN_SHA } from "../activepieces/upstream-pin";
import { EE_SEGMENT } from "../../../scripts/lib/ee-path";

const SEMVER_RANGE = /^[\^~]?\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NPM_PACKAGE = /^@?[a-z0-9][a-z0-9._/-]*$/;

describe("CATALOG invariants", () => {
  test("every entry has a stable id (lowercase, hyphenated)", () => {
    for (const entry of CATALOG) {
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  test("ids are unique (the manifest keys off them)", () => {
    const seen = new Set<string>();
    for (const entry of CATALOG) {
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
    }
  });

  test("versionRange parses as a caret/tilde/exact semver", () => {
    for (const entry of CATALOG) {
      expect(entry.versionRange).toMatch(SEMVER_RANGE);
    }
  });

  test("verified entries install exactly the vetted version unless hand-pinned", () => {
    for (const entry of CATALOG) {
      if (entry.tier !== "verified") continue;
      // A hand pin (VERSION_PIN) may widen or narrow; otherwise the range IS
      // the vetted version, so a later minor cannot land unreviewed.
      if (entry.versionRange === entry.vettedVersion) continue;
      expect(entry.versionRange.startsWith("^") || entry.versionRange.startsWith("~")).toBe(true);
    }
    // At least one verified entry is pinned exactly (the common case).
    const exact = CATALOG.filter((e) => e.tier === "verified" && e.versionRange === e.vettedVersion);
    expect(exact.length).toBeGreaterThan(0);
  });

  test("vettedVersion is an exact semver (no operator)", () => {
    for (const entry of CATALOG) {
      expect(entry.vettedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("vettedAt on verified entries is an ISO date", () => {
    for (const entry of CATALOG) {
      if (entry.tier === "verified") {
        expect(entry.vettedAt).toBeDefined();
        expect(entry.vettedAt!).toMatch(ISO_DATE);
      }
    }
  });

  test("npmPackage looks like a real npm name", () => {
    for (const entry of CATALOG) {
      expect(entry.npmPackage).toMatch(NPM_PACKAGE);
    }
  });

  test("sourceUrl is an https URL", () => {
    for (const entry of CATALOG) {
      expect(entry.sourceUrl.startsWith("https://")).toBe(true);
    }
  });

  test("tier is verified or community", () => {
    for (const entry of CATALOG) {
      expect(["verified", "community"]).toContain(entry.tier);
    }
  });

  test("excluded ids are absent from the final catalog", () => {
    const ids = new Set(CATALOG.map((e) => e.id));
    for (const id of EXCLUDED) {
      expect(ids.has(id)).toBe(false);
    }
  });
});

describe("override consistency", () => {
  test("every VERIFIED id has a VERIFIED_METADATA entry", () => {
    for (const id of VERIFIED) {
      expect(VERIFIED_METADATA[id]).toBeDefined();
    }
  });

  test("every VERIFIED_METADATA key is in VERIFIED (no orphan metadata)", () => {
    for (const id of Object.keys(VERIFIED_METADATA)) {
      expect(VERIFIED.has(id)).toBe(true);
    }
  });

  test("every VERIFIED id materializes as a verified-tier entry", () => {
    // A VERIFIED id that doesn't appear in the generated catalog (typo,
    // upstream removal) would silently end up untyped -- guard against
    // that by checking the merge actually produced verified entries for
    // every promotion.
    const verifiedInCatalog = new Set(
      CATALOG.filter((e) => e.tier === "verified").map((e) => e.id),
    );
    for (const id of VERIFIED) {
      expect(verifiedInCatalog.has(id)).toBe(true);
    }
  });
});

describe("findCatalogEntry", () => {
  test("returns the entry for a known id", () => {
    const e = findCatalogEntry(CATALOG[0]!.id);
    expect(e).not.toBeNull();
    expect(e?.id).toBe(CATALOG[0]!.id);
  });

  test("returns null for an unknown id", () => {
    expect(findCatalogEntry("definitely-not-a-real-piece")).toBeNull();
  });
});

describe("catalogById", () => {
  test("returns a map covering every entry", () => {
    const map = catalogById();
    expect(map.size).toBe(CATALOG.length);
    for (const entry of CATALOG) {
      expect(map.get(entry.id)?.npmPackage).toBe(entry.npmPackage);
    }
  });
});

describe("CATALOG ordering", () => {
  test("verified entries come before community entries", () => {
    let sawCommunity = false;
    for (const entry of CATALOG) {
      if (entry.tier === "community") sawCommunity = true;
      else expect(sawCommunity).toBe(false); // verified must precede any community
    }
  });
});

/**
 * License. Activepieces is dual-licensed: everything outside `packages/ee/` and
 * `packages/server/api/src/app/ee` is MIT, those two are the Enterprise License,
 * which forbids redistribution. We only offer MIT pieces.
 *
 * Upstream pieces declare no `license` in their package.json, so `licenseSpdx`
 * is empty for every generated entry and an allow-list on it alone proves
 * nothing. What actually makes a piece MIT is WHERE it lives upstream, so the
 * load-bearing checks are on `sourceUrl`: no `/ee/` segment, the pinned SHA,
 * the community tree. The license field is still checked, so a piece that ever
 * declares something other than MIT has to be excluded (or this test changed
 * on purpose) before it can ship.
 */
const ALLOWED_LICENSES: ReadonlySet<string> = new Set(["", "MIT"]);
const COMMUNITY_TREE = `https://github.com/activepieces/activepieces/tree/${GENERATED_FROM_SHA}/packages/pieces/community/`;

/** Why `g` may not ship, or null. Excluded ids never reach CATALOG, so they are skipped. */
function licenseViolation(g: GeneratedCatalogEntry, excluded: ReadonlySet<string>): string | null {
  if (excluded.has(g.id)) return null;
  if (!ALLOWED_LICENSES.has(g.licenseSpdx)) return `${g.id}: license "${g.licenseSpdx}" is not MIT`;
  // Before the tree check, so an Enterprise source is named as one rather
  // than as merely being somewhere unexpected.
  if (EE_SEGMENT.test(new URL(g.sourceUrl).pathname)) return `${g.id}: source ${g.sourceUrl} is under an /ee/ path`;
  if (!g.sourceUrl.startsWith(COMMUNITY_TREE)) return `${g.id}: source ${g.sourceUrl} is outside the pinned community tree`;
  if (g.sourceUrl.slice(COMMUNITY_TREE.length) !== g.id) return `${g.id}: source ${g.sourceUrl} is not the piece's own folder`;
  if (!g.npmPackage.startsWith("@activepieces/piece-")) return `${g.id}: ${g.npmPackage} is not an upstream piece package`;
  return null;
}

/** The carve-outs upstream's LICENSE lists before granting MIT, one per `* ` bullet. */
const UPSTREAM_LICENSE_BULLETS = [
  `All content that resides under the "packages/ee/" and "packages/server/api/src/app/ee" directory of this repository, if that directory exists, is licensed under the license defined in packages/ee/LICENSE`,
  `All third party components incorporated into the Activepieces Inc Software are licensed under the original license provided by the owner of the applicable component.`,
  `Content outside of the above mentioned directories or restrictions above is available under the "MIT Expat" license as defined below.`,
];

describe("CATALOG license", () => {
  test("every generated piece is MIT by license field and by upstream location, or excluded", () => {
    const violations = GENERATED.map((g) => licenseViolation(g, EXCLUDED)).filter((v) => v !== null);
    expect(violations).toEqual([]);
  });

  test("every catalog entry comes from the generated list, so the check above covers it", () => {
    const generated = new Map(GENERATED.map((g) => [g.id, g]));
    for (const entry of CATALOG) {
      const g = generated.get(entry.id);
      expect(g).toBeDefined();
      expect(entry.licenseSpdx).toBe(g!.licenseSpdx);
      expect(entry.sourceUrl).toBe(g!.sourceUrl);
      expect(entry.npmPackage).toBe(g!.npmPackage);
    }
  });

  test("the catalog is generated from the same upstream commit that was vendored", () => {
    // The LICENSE read below is the vendored copy. It only speaks for the
    // catalog when both describe the same commit, which the sync script asks
    // for in a comment on its PINNED_SHA and this makes binding.
    expect(GENERATED_FROM_SHA).toBe(UPSTREAM_PIN_SHA);
  });

  test("the vendored upstream LICENSE carves out only ee and grants MIT for the rest", () => {
    // Exactly these bullets: a new carve-out (say, a stricter license for some
    // pieces) adds one and fails here on the next vendor sync, while prose
    // elsewhere in the file can change without a false alarm.
    const text = readFileSync(new URL("../activepieces/LICENSE.activepieces", import.meta.url), "utf8");
    const bullets = text.split("\n").filter((line) => line.startsWith("* ")).map((line) => line.slice(2).trim());
    expect(bullets).toEqual(UPSTREAM_LICENSE_BULLETS);
  });

  describe("the check is not vacuous", () => {
    const ok: GeneratedCatalogEntry = {
      id: "acme", npmPackage: "@activepieces/piece-acme", versionRange: "^1.0.0", latestVersion: "1.0.0",
      displayName: "Acme", description: "", sourceUrl: `${COMMUNITY_TREE}acme`, licenseSpdx: "",
    };
    const none = new Set<string>();
    const tree = "https://github.com/activepieces/activepieces/tree/";

    test("an empty or MIT license in the community tree passes", () => {
      expect(licenseViolation(ok, none)).toBeNull();
      expect(licenseViolation({ ...ok, licenseSpdx: "MIT" }, none)).toBeNull();
    });

    test.each(["GPL-3.0", "AGPL-3.0", "Apache-2.0", "SEE LICENSE IN LICENSE", "Commercial"])("license %s fails", (license) => {
      expect(licenseViolation({ ...ok, licenseSpdx: license }, none)).toContain("is not MIT");
    });

    test("a non-MIT piece passes once it is excluded", () => {
      expect(licenseViolation({ ...ok, licenseSpdx: "GPL-3.0" }, new Set(["acme"]))).toBeNull();
    });

    test.each([
      `${tree}${GENERATED_FROM_SHA}/packages/ee/pieces/acme`,
      `${tree}${GENERATED_FROM_SHA}/packages/server/api/src/app/ee/pieces/acme`,
    ])("an Enterprise source fails as one: %s", (sourceUrl) => {
      expect(licenseViolation({ ...ok, sourceUrl }, none)).toContain("under an /ee/ path");
    });

    test.each([
      `${tree}${GENERATED_FROM_SHA}/packages/pieces/custom/acme`,
      `${tree}0000000000000000000000000000000000000000/packages/pieces/community/acme`,
      `https://github.com/someone/fork/tree/${GENERATED_FROM_SHA}/packages/pieces/community/acme`,
    ])("a source outside the pinned community tree fails: %s", (sourceUrl) => {
      expect(licenseViolation({ ...ok, sourceUrl }, none)).toContain("outside the pinned community tree");
    });

    test("a source that is not the piece's own folder fails", () => {
      expect(licenseViolation({ ...ok, sourceUrl: `${COMMUNITY_TREE}other` }, none)).toContain("own folder");
    });

    test("a package outside @activepieces/piece-* fails", () => {
      expect(licenseViolation({ ...ok, npmPackage: "@someone/piece-acme" }, none)).toContain("not an upstream piece package");
    });
  });
});
