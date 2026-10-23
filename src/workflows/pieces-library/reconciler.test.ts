/**
 * Reconciler coverage. The reconciler is the startup self-heal pass that
 * runs `bun install` from the manifest when the on-disk `node_modules` is
 * missing or stale (Docker volume restored, manual edit, etc.). We stub
 * `runBunInstall` to materialize what we want and assert the diff
 * reporting (materialized / missing / drifted) is correct.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeManifest, readManifest } from "./installer";
import { reconcilePiecesLibrary } from "./reconciler";
import { catalogById } from "./catalog";

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
    // gmail is a verified piece: a manifest range that differs from the
    // catalog pin would be re-pinned (and the install accepted as the new
    // truth), so use the catalog's own range here to isolate plain drift.
    const gmailRange = catalogById().get("gmail")!.versionRange;
    await writeManifest(
      {
        version: 1,
        pieces: [
          {
            id: "gmail",
            npmPackage: "@activepieces/piece-gmail",
            versionRange: gmailRange,
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

  test("re-pins a verified piece to the catalog version and records the install as the new truth", async () => {
    const gmailRange = catalogById().get("gmail")!.versionRange;
    await writeManifest(
      {
        version: 1,
        pieces: [
          { id: "gmail", npmPackage: "@activepieces/piece-gmail", versionRange: "^0.12.2", resolvedVersion: "0.12.9", installedAt: 1 },
        ],
      },
      base,
    );
    const result = await reconcilePiecesLibrary({
      base,
      runBunInstall: async () => { fakeInstall("@activepieces/piece-gmail", gmailRange); },
      log: () => {},
    });
    expect(result.drifted).toHaveLength(0);
    const manifest = await readManifest(base);
    expect(manifest.pieces[0]?.versionRange).toBe(gmailRange);
    expect(manifest.pieces[0]?.resolvedVersion).toBe(gmailRange);
  });
});

describe("#971: an install that already has an excluded piece", () => {
  test("keeps it installed at boot, unchanged, and says why it is withdrawn", async () => {
    const before = {
      version: 1 as const,
      pieces: [{
        id: "actualbudget",
        npmPackage: "@activepieces/piece-actualbudget",
        versionRange: "^0.1.9",
        resolvedVersion: "0.1.9",
        installedAt: 3,
      }],
    };
    await writeManifest(before, base);
    const lines: string[] = [];
    let installedFrom = "";
    const result = await reconcilePiecesLibrary({
      base,
      runBunInstall: async () => {
        installedFrom = readFileSync(join(base, "package.json"), "utf8");
        fakeInstall("@activepieces/piece-actualbudget", "0.1.9");
      },
      log: (l) => lines.push(l),
    });
    // Not uninstalled, not a boot failure: still declared, still materialized.
    expect(result.ranInstall).toBe(true);
    expect(result.materialized.map((p) => p.id)).toEqual(["actualbudget"]);
    expect(result.missing).toEqual([]);
    expect(result.drifted).toEqual([]);
    // Held at the version it has: ^0.1.9 would float to a later 0.1.x on a
    // fresh container, and nothing offers it an update any more.
    expect(JSON.parse(installedFrom).dependencies).toEqual({ "@activepieces/piece-actualbudget": "0.1.9" });
    expect(await readManifest(base)).toEqual({ ...before, pieces: [{ ...before.pieces[0]!, versionRange: "0.1.9" }] });
    const withdrawn = lines.filter((l) => l.includes("actualbudget stays installed but is withdrawn"));
    expect(withdrawn.length).toBe(1);
    expect(withdrawn[0]).toMatch(/GPL-3\.0-only.*AGPL-3\.0-or-later/s);
  });

  const withdrawnAt = (resolvedVersion: string, versionRange = "^0.1.9") => ({
    version: 1 as const,
    pieces: [{ id: "actualbudget", npmPackage: "@activepieces/piece-actualbudget", versionRange, resolvedVersion, installedAt: 3 }],
  });
  const reconcileLogging = async (onDisk: string | null) => {
    const lines: string[] = [];
    let installedFrom = "";
    await reconcilePiecesLibrary({
      base,
      runBunInstall: async () => {
        installedFrom = readFileSync(join(base, "package.json"), "utf8");
        if (onDisk) fakeInstall("@activepieces/piece-actualbudget", onDisk);
      },
      log: (l) => lines.push(l),
    });
    return { lines, range: JSON.parse(installedFrom).dependencies["@activepieces/piece-actualbudget"] as string };
  };

  test("an install that already floated is held at the version on disk, not moved back", async () => {
    await writeManifest(withdrawnAt("0.1.9"), base);
    fakeInstall("@activepieces/piece-actualbudget", "0.1.12");
    const { range } = await reconcileLogging("0.1.12");
    expect(range).toBe("0.1.12");
    expect((await readManifest(base)).pieces[0]).toMatchObject({ versionRange: "0.1.12", resolvedVersion: "0.1.12" });
  });

  test("a second boot changes nothing and logs no re-pin", async () => {
    await writeManifest(withdrawnAt("0.1.9"), base);
    await reconcileLogging("0.1.9");
    const after = await readManifest(base);
    const { lines } = await reconcileLogging("0.1.9");
    expect(await readManifest(base)).toEqual(after);
    expect(lines.some((l) => l.includes("held ") || l.includes("re-pinned"))).toBe(false);
  });

  test("a prerelease is held exactly; an empty version is left alone and said", async () => {
    await writeManifest(withdrawnAt("1.0.0-beta.1", "^1.0.0-beta.1"), base);
    expect((await reconcileLogging("1.0.0-beta.1")).range).toBe("1.0.0-beta.1");
    rmSync(join(base, "node_modules"), { recursive: true, force: true });
    await writeManifest(withdrawnAt(""), base);
    const { lines, range } = await reconcileLogging(null);
    expect(range).toBe("^0.1.9");
    expect(lines.filter((l) => l.includes("has no exact version to hold it at")).length).toBe(1);
  });

  test("says so for a piece upstream dropped too, with the generic reason", async () => {
    await writeManifest({ version: 1, pieces: [{ id: "yanked-piece", npmPackage: "@activepieces/piece-yanked", versionRange: "^0.1.0", resolvedVersion: "0.1.0", installedAt: 1 }] }, base);
    const lines: string[] = [];
    const result = await reconcilePiecesLibrary({ base, runBunInstall: async () => fakeInstall("@activepieces/piece-yanked", "0.1.0"), log: (l) => lines.push(l) });
    expect(result.materialized.map((p) => p.id)).toEqual(["yanked-piece"]);
    expect(lines.filter((l) => l.includes("yanked-piece stays installed but is withdrawn") && l.includes("no longer in the Jarvis catalog")).length).toBe(1);
  });

  test("says nothing of the kind for a piece the catalog still offers", async () => {
    await writeManifest({ version: 1, pieces: [{ id: "slack", npmPackage: "@activepieces/piece-slack", versionRange: "^0.16.4", resolvedVersion: "0.16.4", installedAt: 1 }] }, base);
    const lines: string[] = [];
    await reconcilePiecesLibrary({ base, runBunInstall: async () => fakeInstall("@activepieces/piece-slack", "0.16.4"), log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes("stays installed but is withdrawn"))).toBe(false);
  });
});
