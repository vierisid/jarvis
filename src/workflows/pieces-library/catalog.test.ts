/**
 * Catalog shape + invariant coverage. These are sanity checks so a stray
 * edit to `catalog.ts`, `catalog-generated.ts`, or `catalog-overrides.ts`
 * doesn't ship broken entries.
 */

import { describe, expect, test } from "bun:test";
import { CATALOG, catalogById, findCatalogEntry } from "./catalog";
import { EXCLUDED, VERIFIED, VERIFIED_METADATA } from "./catalog-overrides";

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
