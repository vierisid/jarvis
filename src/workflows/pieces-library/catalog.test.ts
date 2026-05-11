/**
 * Catalog shape + invariant coverage. These are sanity checks so a stray
 * edit to `catalog.ts` doesn't ship broken entries.
 */

import { describe, expect, test } from "bun:test";
import { CATALOG, catalogById, findCatalogEntry } from "./catalog";

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

  test("vettedAt is an ISO date", () => {
    for (const entry of CATALOG) {
      expect(entry.vettedAt).toMatch(ISO_DATE);
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
