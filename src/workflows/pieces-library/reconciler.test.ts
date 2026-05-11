/**
 * Reconciler coverage. The reconciler is the startup self-heal pass that
 * runs `bun install` from the manifest when the on-disk `node_modules` is
 * missing or stale (Docker volume restored, manual edit, etc.). We stub
 * `runBunInstall` to materialize what we want and assert the diff
 * reporting (materialized / missing / drifted) is correct.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeManifest } from "./installer";
import { reconcilePiecesLibrary } from "./reconciler";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jarvis-pieces-reconciler-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function fakeInstall(pkg: string, version: string): void {
  const dir = resolve(base, "node_modules", pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify({ name: pkg, version }) + "\n",
  );
}

describe("reconcilePiecesLibrary", () => {
  test("empty manifest -> no-op (no install run, empty result)", async () => {
    const calls: string[] = [];
    const result = await reconcilePiecesLibrary({
      base,
      runBunInstall: async () => {
        calls.push("install");
      },
      log: () => {},
    });
    expect(result.ranInstall).toBe(false);
    expect(result.declared).toBe(0);
    expect(calls).toEqual([]);
  });

  test("runs install and materializes every manifest entry", async () => {
    await writeManifest(
      {
        version: 1,
        pieces: [
          {
            id: "gmail",
            npmPackage: "@activepieces/piece-gmail",
            versionRange: "^0.12.2",
            resolvedVersion: "0.12.3",
            installedAt: 1,
          },
          {
            id: "slack",
            npmPackage: "@activepieces/piece-slack",
            versionRange: "^0.16.4",
            resolvedVersion: "0.16.4",
            installedAt: 2,
          },
        ],
      },
      base,
    );
    const result = await reconcilePiecesLibrary({
      base,
      runBunInstall: async () => {
        fakeInstall("@activepieces/piece-gmail", "0.12.3");
        fakeInstall("@activepieces/piece-slack", "0.16.4");
      },
      log: () => {},
    });
    expect(result.ranInstall).toBe(true);
    expect(result.declared).toBe(2);
    expect(result.materialized).toHaveLength(2);
    expect(result.missing).toEqual([]);
    expect(result.drifted).toEqual([]);
  });

  test("reports missing pieces when bun install leaves the tree incomplete", async () => {
    await writeManifest(
      {
        version: 1,
        pieces: [
          {
            id: "gmail",
            npmPackage: "@activepieces/piece-gmail",
            versionRange: "^0.12.2",
            resolvedVersion: "0.12.3",
            installedAt: 1,
          },
        ],
      },
      base,
    );
    const result = await reconcilePiecesLibrary({
      base,
      runBunInstall: async () => {
        // Don't materialize anything. Simulates a network failure mid-install.
      },
      log: () => {},
    });
    expect(result.materialized).toEqual([]);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.id).toBe("gmail");
  });

  test("reports drifted pieces when on-disk version differs from manifest", async () => {
    await writeManifest(
      {
        version: 1,
        pieces: [
          {
            id: "gmail",
            npmPackage: "@activepieces/piece-gmail",
            versionRange: "^0.12.2",
            resolvedVersion: "0.12.3",
            installedAt: 1,
          },
        ],
      },
      base,
    );
    const result = await reconcilePiecesLibrary({
      base,
      runBunInstall: async () => {
        // Materialize a newer patch -- bun re-resolved during install.
        fakeInstall("@activepieces/piece-gmail", "0.12.5");
      },
      log: () => {},
    });
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0]?.onDiskVersion).toBe("0.12.5");
    expect(result.drifted[0]?.piece.resolvedVersion).toBe("0.12.3");
  });
});
