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
  withLibraryLock,
  readManifest,
  synthesizePackageJson,
  uninstallPiece,
  writeManifest,
} from "./installer";
import { excludedReason, findCatalogEntry, PieceExcludedError } from "./catalog";

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

describe("#971: installPiece refuses an excluded piece, with its reason", () => {
  test("a fresh install of actualbudget is refused before the manifest or bun is touched", async () => {
    const calls: string[] = [];
    const err = await installPiece("actualbudget", { base, runBunInstall: async () => { calls.push("bun"); } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PieceExcludedError);
    expect((err as PieceExcludedError).code).toBe("PIECE_EXCLUDED");
    expect((err as PieceExcludedError).pieceId).toBe("actualbudget");
    expect((err as PieceExcludedError).reason).toBe(excludedReason("actualbudget")!);
    expect((err as Error).message).toMatch(/cannot be installed: .*GPL-3\.0-only.*AGPL-3\.0-or-later/s);
    expect(calls).toEqual([]);
    expect(existsSync(join(base, "installed.json"))).toBe(false);
    expect(existsSync(join(base, "package.json"))).toBe(false);
  });

  test("an update of one installed before the exclusion is refused too, and leaves the install as it was", async () => {
    const before = {
      version: 1 as const,
      pieces: [{
        id: "actualbudget",
        npmPackage: "@activepieces/piece-actualbudget",
        versionRange: "^0.1.9",
        resolvedVersion: "0.1.9",
        installedAt: 7,
      }],
    };
    await writeManifest(before, base);
    const calls: string[] = [];
    await expect(installPiece("actualbudget", { base, runBunInstall: async () => { calls.push("bun"); } })).rejects.toBeInstanceOf(PieceExcludedError);
    expect(calls).toEqual([]);
    expect(await readManifest(base)).toEqual(before);
  });
});

test("Library writers serialize and a failed install does not poison the queue", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a = withLibraryLock(async () => { order.push("install started"); await gate; throw new Error("install failed"); });
  const failure = a.catch(e => e.message);
  const b = withLibraryLock(async () => { order.push("next writer"); });
  await Promise.resolve();
  expect(order).toEqual(["install started"]);
  release();
  expect(await failure).toBe("install failed");
  await b;
  expect(order).toEqual(["install started", "next writer"]);
});
