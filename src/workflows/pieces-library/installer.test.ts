/**
 * Installer + manifest coverage. `bun install` is stubbed via `runBunInstall`
 * so tests don't hit npm. We assert:
 *   - manifest read/write round-trips
 *   - synthesized package.json shape (deps map + private flag)
 *   - install resolves a placeholder, records version after bun + node_modules read
 *   - reinstall is idempotent (no duplicate manifest entries)
 *   - uninstall removes the entry; uninstalling missing id is a no-op
 *   - unknown catalog id throws
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installPiece,
  readManifest,
  synthesizePackageJson,
  uninstallPiece,
  writeManifest,
} from "./installer";
import { findCatalogEntry } from "./catalog";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jarvis-pieces-installer-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * Build the node_modules layout `installPiece` reads after bun completes:
 * `<base>/node_modules/<pkg>/package.json` with the resolved version. Tests
 * call this from inside their `runBunInstall` stub.
 */
function fakeInstall(pkg: string, resolvedVersion: string): void {
  const pkgDir = resolve(base, "node_modules", pkg);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    resolve(pkgDir, "package.json"),
    JSON.stringify({ name: pkg, version: resolvedVersion }) + "\n",
  );
}

describe("manifest read/write", () => {
  test("returns empty manifest when file is missing", async () => {
    const m = await readManifest(base);
    expect(m).toEqual({ version: 1, pieces: [] });
  });

  test("writes and reads back a manifest", async () => {
    await writeManifest(
      {
        version: 1,
        pieces: [
          {
            id: "gmail",
            npmPackage: "@activepieces/piece-gmail",
            versionRange: "^0.12.2",
            resolvedVersion: "0.12.3",
            installedAt: 1000,
          },
        ],
      },
      base,
    );
    const read = await readManifest(base);
    expect(read.pieces).toHaveLength(1);
    expect(read.pieces[0]?.id).toBe("gmail");
    expect(read.pieces[0]?.resolvedVersion).toBe("0.12.3");
  });

  test("throws on unreadable manifest JSON", async () => {
    writeFileSync(resolve(base, "installed.json"), "not valid json", "utf8");
    await expect(readManifest(base)).rejects.toThrow(/unreadable/);
  });

  test("filters out malformed entries on read", async () => {
    // Hand-edit shape with one good entry + one bogus. Reader should keep
    // only the good one rather than throwing -- a half-corrupt manifest is
    // recoverable, a fully-corrupt one isn't.
    writeFileSync(
      resolve(base, "installed.json"),
      JSON.stringify({
        version: 1,
        pieces: [
          {
            id: "gmail",
            npmPackage: "@activepieces/piece-gmail",
            versionRange: "^0.12.2",
            resolvedVersion: "0.12.3",
            installedAt: 1,
          },
          { id: "bad" }, // missing required fields
        ],
      }),
    );
    const m = await readManifest(base);
    expect(m.pieces).toHaveLength(1);
    expect(m.pieces[0]?.id).toBe("gmail");
  });
});

describe("synthesizePackageJson", () => {
  test("emits a private package with one dep per installed piece (range, not resolved)", () => {
    const json = synthesizePackageJson({
      version: 1,
      pieces: [
        {
          id: "gmail",
          npmPackage: "@activepieces/piece-gmail",
          versionRange: "^0.12.2",
          resolvedVersion: "0.12.3",
          installedAt: 0,
        },
        {
          id: "slack",
          npmPackage: "@activepieces/piece-slack",
          versionRange: "~0.16.4",
          resolvedVersion: "0.16.5",
          installedAt: 0,
        },
      ],
    });
    const parsed = JSON.parse(json) as {
      private: boolean;
      dependencies: Record<string, string>;
    };
    expect(parsed.private).toBe(true);
    // Critical: bun resolves against the range, not the previously-resolved
    // version, so updates within range float on each `bun install`.
    expect(parsed.dependencies["@activepieces/piece-gmail"]).toBe("^0.12.2");
    expect(parsed.dependencies["@activepieces/piece-slack"]).toBe("~0.16.4");
  });
});

describe("installPiece", () => {
  test("unknown catalog id throws", async () => {
    await expect(installPiece("not-a-real-piece", { base })).rejects.toThrow(/not in the catalog/);
  });

  test("adds to manifest + records resolved version after install", async () => {
    // Read the catalog's current versionRange dynamically instead of hard-
    // coding -- the range floats with `latestVersion` from the generator
    // every time the sync action runs, and we don't want this test to break
    // every refresh. We just verify that *whatever* the catalog says,
    // that's what the installer records on the manifest + synthesized
    // package.json.
    const catalogEntry = findCatalogEntry("gmail")!;
    const range = catalogEntry.versionRange;
    const result = await installPiece("gmail", {
      base,
      runBunInstall: async () => {
        fakeInstall("@activepieces/piece-gmail", "0.12.3");
      },
    });
    expect(result.piece.id).toBe("gmail");
    expect(result.piece.resolvedVersion).toBe("0.12.3");
    expect(result.piece.versionRange).toBe(range);
    // Manifest on disk reflects the same.
    const m = await readManifest(base);
    expect(m.pieces.map((p) => p.id)).toEqual(["gmail"]);
    expect(m.pieces[0]?.resolvedVersion).toBe("0.12.3");
    // package.json got synthesized.
    const pkg = JSON.parse(readFileSync(resolve(base, "package.json"), "utf8"));
    expect(pkg.dependencies["@activepieces/piece-gmail"]).toBe(range);
  });

  test("reinstalling the same piece doesn't duplicate the entry", async () => {
    await installPiece("gmail", {
      base,
      runBunInstall: async () => {
        fakeInstall("@activepieces/piece-gmail", "0.12.3");
      },
    });
    const second = await installPiece("gmail", {
      base,
      runBunInstall: async () => {
        fakeInstall("@activepieces/piece-gmail", "0.12.5"); // patch update via re-resolve
      },
    });
    const m = await readManifest(base);
    expect(m.pieces).toHaveLength(1);
    // Resolved version got bumped to the newer one.
    expect(second.piece.resolvedVersion).toBe("0.12.5");
  });

  test("reinstall preserves the original installedAt timestamp", async () => {
    // Simulates a user who installed gmail months ago, then re-runs install
    // to pick up a patch. The "first installed" date is more useful for
    // diagnostics than "last touched" (which is captured by the on-disk
    // node_modules mtime if anyone needs it).
    const first = await installPiece("gmail", {
      base,
      runBunInstall: async () => fakeInstall("@activepieces/piece-gmail", "0.12.3"),
    });
    const originalInstalledAt = first.piece.installedAt;
    // Move the clock forward enough that Date.now() will definitely differ.
    await new Promise((r) => setTimeout(r, 5));
    const second = await installPiece("gmail", {
      base,
      runBunInstall: async () => fakeInstall("@activepieces/piece-gmail", "0.12.5"),
    });
    expect(second.piece.installedAt).toBe(originalInstalledAt);
  });

  test("throws when bun install completes but the package isn't materialized", async () => {
    await expect(
      installPiece("gmail", {
        base,
        runBunInstall: async () => {
          /* don't write node_modules at all */
        },
      }),
    ).rejects.toThrow(/missing from node_modules/);
  });
});

describe("uninstallPiece", () => {
  test("removes the entry from manifest + re-syncs package.json", async () => {
    await installPiece("gmail", {
      base,
      runBunInstall: async () => fakeInstall("@activepieces/piece-gmail", "0.12.3"),
    });
    await uninstallPiece("gmail", {
      base,
      runBunInstall: async () => {
        // bun install with empty deps -- node_modules can be left as-is for
        // the test; reconciler would clean it next boot anyway.
      },
    });
    const m = await readManifest(base);
    expect(m.pieces).toEqual([]);
    const pkg = JSON.parse(readFileSync(resolve(base, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({});
  });

  test("uninstalling a piece that isn't installed is a no-op", async () => {
    const m = await uninstallPiece("gmail", {
      base,
      runBunInstall: async () => {
        throw new Error("should not have been called -- nothing to install");
      },
    });
    expect(m.pieces).toEqual([]);
    // package.json should not have been touched.
    expect(existsSync(resolve(base, "package.json"))).toBe(false);
  });
});
