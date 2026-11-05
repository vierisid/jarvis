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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installPiece,
  removePackageDir,
  runPiecesBunInstall,
  withLibraryLock,
  readManifest,
  synthesizePackageJson,
  uninstallPiece,
  writeManifest,
} from "./installer";
import { excludedReason, findCatalogEntry, PieceExcludedError } from "./catalog";
import { PieceLicenseError } from "./install-licenses";

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
function fakeInstall(pkg: string, resolvedVersion: string, extra: Record<string, unknown> = {}): void {
  const pkgDir = resolve(base, "node_modules", pkg);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    resolve(pkgDir, "package.json"),
    JSON.stringify({ name: pkg, version: resolvedVersion, ...extra }) + "\n",
  );
  // bun writes bun.lock with every package it resolved; the license check
  // (#971) reads identities from it, as it does on a real install.
  const lockPath = resolve(base, "bun.lock");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) as { lockfileVersion: number; packages: Record<string, unknown> } : { lockfileVersion: 1, packages: {} };
  lock.packages[pkg] = [`${pkg}@${resolvedVersion}`, "", {}, "sha512-x"];
  writeFileSync(lockPath, JSON.stringify(lock));
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
  test("an abort stops the install: the bun install step gets the signal and the call rejects with its reason", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined, entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const pending = installPiece("gmail", { base, signal: controller.signal, runBunInstall: (_cwd, signal) => {
      received = signal; entered();
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    } });
    await started;
    controller.abort(new Error("fixture timeout"));
    await expect(pending).rejects.toThrow("fixture timeout");
    expect(received).toBe(controller.signal);
    await expect(installPiece("gmail", { base, signal: controller.signal, runBunInstall: async () => { throw new Error("must not run"); } }))
      .rejects.toThrow("fixture timeout");
  });

  test("the real bun install child is killed on abort, and never started when already aborted", async () => {
    writeFileSync(join(base, "package.json"), "{}");
    const controller = new AbortController();
    const running = runPiecesBunInstall(base, "fixture", controller.signal);
    controller.abort(new Error("fixture stop"));
    await expect(running).rejects.toThrow("fixture stop");
    await expect(runPiecesBunInstall(base, "fixture", controller.signal)).rejects.toThrow("fixture stop");
  });

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


describe("installPiece license check (#971)", () => {
  /** gmail at `version`, depending on `dep`, which is installed with `license`. */
  const installWithDep = (version: string, dep: string, license: string | null) => () => {
    fakeInstall("@activepieces/piece-gmail", version, { dependencies: { [dep]: "1.0.0" } });
    fakeInstall(dep, "1.0.0", license === null ? {} : { license });
  };
  const state = () => ({
    manifest: readFileSync(resolve(base, "installed.json"), "utf8"),
    pkg: existsSync(resolve(base, "package.json")) ? readFileSync(resolve(base, "package.json"), "utf8") : null,
    lock: existsSync(resolve(base, "bun.lock")) ? readFileSync(resolve(base, "bun.lock"), "utf8") : null,
  });
  const gmailDir = () => resolve(base, "node_modules/@activepieces/piece-gmail");

  test("a permissive dependency tree installs", async () => {
    const result = await installPiece("gmail", { base, runBunInstall: async () => installWithDep("0.12.3", "left-pad", "MIT")() });
    expect(result.piece.resolvedVersion).toBe("0.12.3");
  });

  test("a fresh install pulling a GPL package is refused and rolled back, and the piece is off disk though bun does not prune", async () => {
    const calls: string[] = [];
    const err = await installPiece("gmail", { base, runBunInstall: async () => {
      calls.push(readFileSync(resolve(base, "package.json"), "utf8"));
      // Like real bun: the rollback install leaves the dropped piece where it is.
      if (calls.length === 1) installWithDep("0.12.3", "copyleft-lib", "GPL-3.0-only")();
    } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PieceLicenseError);
    expect((err as PieceLicenseError).problems.join("\n")).toMatch(/copyleft-lib@1\.0\.0 .*GPL-3\.0-only.*via @activepieces\/piece-gmail@0\.12\.3 > copyleft-lib@1\.0\.0/);
    expect((err as Error).message).toMatch(/piece "gmail" was not installed: the license policy denies/);
    // bun ran a second time, against the package.json from before the install: no pieces.
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!).dependencies).toEqual({});
    expect((await readManifest(base)).pieces).toEqual([]);
    expect(existsSync(gmailDir())).toBe(false);
  });

  test("an update to a release with a denied dependency puts the previous install back, lockfile included", async () => {
    await installPiece("gmail", { base, runBunInstall: async () => installWithDep("0.12.3", "left-pad", "MIT")() });
    const before = state();
    let n = 0;
    let rollbackLock = null as string | null;
    const err = await installPiece("gmail", { base, runBunInstall: async () => {
      if (++n === 1) { installWithDep("0.12.9", "no-license-lib", null)(); return; }
      // The rollback install sees the lockfile from before, which pins 0.12.3; bun puts that version back.
      rollbackLock = state().lock;
      fakeInstall("@activepieces/piece-gmail", "0.12.3", { dependencies: { "left-pad": "1.0.0" } });
    } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PieceLicenseError);
    expect((err as PieceLicenseError).problems.join("\n")).toMatch(/no-license-lib@1\.0\.0 .*no license declared/);
    expect(rollbackLock).toBe(before.lock);
    expect(JSON.parse(readFileSync(resolve(gmailDir(), "package.json"), "utf8")).version).toBe("0.12.3");
    expect(state().manifest).toBe(before.manifest);
    expect(state().pkg).toBe(before.pkg);
  });

  test("a denied package another piece also reaches is still this piece's problem, though its chain runs through the other", async () => {
    // airtable sorts first, so the shortest chain to the shared package runs through it.
    await writeManifest({ version: 1, pieces: [{ id: "airtable", npmPackage: "@activepieces/piece-airtable", versionRange: "1.0.0", resolvedVersion: "1.0.0", installedAt: 1 }] }, base);
    const err = await installPiece("gmail", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-airtable", "1.0.0", { dependencies: { "agpl-lib": "1.0.0" } });
      fakeInstall("@activepieces/piece-gmail", "0.12.3", { dependencies: { "agpl-lib": "1.0.0" } });
      fakeInstall("agpl-lib", "1.0.0", { license: "AGPL-3.0-or-later" });
    } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PieceLicenseError);
    expect((err as PieceLicenseError).problems.join("\n")).toMatch(/agpl-lib@1\.0\.0 .*via @activepieces\/piece-airtable@1\.0\.0 > agpl-lib@1\.0\.0 \(reached from @activepieces\/piece-gmail\)/);
  });

  test("a leftover an uninstall left behind does not refuse an install; a refused package the piece reaches does", async () => {
    // What bun leaves after an uninstall: a package on disk that bun.lock no longer lists.
    mkdirSync(resolve(base, "node_modules/kind-of"), { recursive: true });
    writeFileSync(resolve(base, "node_modules/kind-of/package.json"), JSON.stringify({ name: "kind-of", version: "6.0.3", license: "MIT" }));
    const ok = await installPiece("gmail", { base, runBunInstall: async () => installWithDep("0.12.3", "left-pad", "MIT")() });
    expect(ok.piece.resolvedVersion).toBe("0.12.3");
    // A problem the scan finds inside a package the piece reaches refuses it.
    const err = await installPiece("slack", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-slack", "0.16.4", { dependencies: { "kind-of": "6.0.3" } });
      mkdirSync(resolve(base, "node_modules/kind-of/node_modules/.weird"), { recursive: true });
    } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PieceLicenseError);
    expect((err as PieceLicenseError).problems.join("\n")).toMatch(/node_modules\/kind-of\/node_modules\/\.weird is a hidden directory bun does not write/);
  });

  test("old nested copies bun leaves behind are judged on their license, not refused for the lock (measured on a real install)", async () => {
    // As on a real ~/.jarvis/pieces: axios/node_modules/form-data at an older version, which bun.lock no longer lists.
    const result = await installPiece("gmail", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-gmail", "0.12.3", { dependencies: { axios: "1.0.0" } });
      fakeInstall("axios", "1.0.0", { license: "MIT", dependencies: { "form-data": "4" } });
      const nested = resolve(base, "node_modules/axios/node_modules/form-data");
      mkdirSync(nested, { recursive: true });
      writeFileSync(resolve(nested, "package.json"), JSON.stringify({ name: "form-data", version: "4.0.5", license: "MIT" }));
    } });
    expect(result.piece.resolvedVersion).toBe("0.12.3");
    // The same unlisted copy with no license is still a problem: no presumption without the lock.
    const err = await installPiece("slack", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-slack", "0.16.4", { dependencies: { "old-dep": "1" } });
      mkdirSync(resolve(base, "node_modules/old-dep"), { recursive: true });
      writeFileSync(resolve(base, "node_modules/old-dep/package.json"), JSON.stringify({ name: "old-dep", version: "1.0.0" }));
    } }).then(() => null, (e: unknown) => e);
    expect((err as PieceLicenseError).problems.join("\n")).toMatch(/old-dep@1\.0\.0 .*no license declared/);
  });

  test("an old nested Activepieces SDK copy bun left keeps upstream's MIT, as the listed copy does", async () => {
    const result = await installPiece("gmail", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-gmail", "0.12.3", { dependencies: { "@activepieces/shared": "0.57.2" } });
      fakeInstall("@activepieces/shared", "0.60.0");
      const nested = resolve(gmailDir(), "node_modules/@activepieces/shared");
      mkdirSync(nested, { recursive: true });
      writeFileSync(resolve(nested, "package.json"), JSON.stringify({ name: "@activepieces/shared", version: "0.57.2" }));
    } });
    expect(result.piece.resolvedVersion).toBe("0.12.3");
  });

  test("a problem inside a leftover nothing uses fails nothing", async () => {
    const stray = resolve(base, "node_modules/stray");
    mkdirSync(resolve(stray, "node_modules/.weird"), { recursive: true });
    writeFileSync(resolve(stray, "package.json"), JSON.stringify({ name: "stray", version: "1.0.0", license: "MIT" }));
    const result = await installPiece("gmail", { base, runBunInstall: async () => installWithDep("0.12.3", "left-pad", "MIT")() });
    expect(result.piece.resolvedVersion).toBe("0.12.3");
  });

  test("a piece another installed piece depends on is not removed as a stray", async () => {
    await installPiece("gmail", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-gmail", "0.12.3", { dependencies: { "@activepieces/piece-helper": "1.0.0" } });
      fakeInstall("@activepieces/piece-helper", "1.0.0", { license: "MIT" });
    } });
    expect(existsSync(resolve(base, "node_modules/@activepieces/piece-helper"))).toBe(true);
  });

  test("a piece directory only a held piece depends on goes too, so its denied tree is not left loadable", async () => {
    const err = await installPiece("gmail", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-gmail", "0.12.3", { dependencies: { "@activepieces/piece-helper": "1.0.0" } });
      fakeInstall("@activepieces/piece-helper", "1.0.0", { license: "MIT", dependencies: { "gpl-lib": "1.0.0" } });
      fakeInstall("gpl-lib", "1.0.0", { license: "GPL-3.0-only" });
    } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PieceLicenseError);
    expect(existsSync(resolve(base, "node_modules/@activepieces/piece-helper"))).toBe(false);
    expect(existsSync(gmailDir())).toBe(false);
  });

  test("an install that brings back a piece held at boot takes it off again, and says so", async () => {
    await writeManifest({ version: 1, pieces: [{ id: "airtable", npmPackage: "@activepieces/piece-airtable", versionRange: "1.0.0", resolvedVersion: "1.0.0", installedAt: 1 }] }, base);
    await installPiece("gmail", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-airtable", "1.0.0", { dependencies: { "gpl-lib": "1.0.0" } });
      fakeInstall("gpl-lib", "1.0.0", { license: "GPL-2.0-only" });
      installWithDep("0.12.3", "left-pad", "MIT")();
    } });
    expect(existsSync(resolve(base, "node_modules/@activepieces/piece-airtable"))).toBe(false);
    expect(existsSync(gmailDir())).toBe(true);
  });

  test("the install result names the other pieces it took off disk", async () => {
    await writeManifest({ version: 1, pieces: [{ id: "airtable", npmPackage: "@activepieces/piece-airtable", versionRange: "1.0.0", resolvedVersion: "1.0.0", installedAt: 1 }] }, base);
    const result = await installPiece("gmail", { base, runBunInstall: async () => {
      fakeInstall("@activepieces/piece-airtable", "1.0.0", { dependencies: { "gpl-lib": "1.0.0" } });
      fakeInstall("gpl-lib", "1.0.0", { license: "GPL-2.0-only" });
      installWithDep("0.12.3", "left-pad", "MIT")();
    } });
    expect(result.alsoHeld.map((h) => h.npmPackage)).toEqual(["@activepieces/piece-airtable"]);
  });

  test("an uninstall takes the piece off disk though bun does not prune it", async () => {
    await installPiece("gmail", { base, runBunInstall: async () => installWithDep("0.12.3", "left-pad", "MIT")() });
    await uninstallPiece("gmail", { base, runBunInstall: async () => {} });
    expect(existsSync(gmailDir())).toBe(false);
  });

  test("a failed install is still checked: a denied release it left on disk is removed", async () => {
    const err = await installPiece("gmail", { base, runBunInstall: async () => {
      installWithDep("0.12.3", "copyleft-lib", "GPL-3.0-only")();
      throw new Error("bun install exited with code 1");
    } }).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe("bun install exited with code 1");
    expect(existsSync(gmailDir())).toBe(false);
  });

  test("a rollback bun cannot finish still takes the refused piece off disk", async () => {
    let n = 0;
    const err = await installPiece("gmail", { base, runBunInstall: async () => {
      if (++n === 1) installWithDep("0.12.3", "copyleft-lib", "GPL-3.0-only")();
      else throw new Error("registry unreachable");
    } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PieceLicenseError);
    expect((err as PieceLicenseError).rollbackError).toBe("registry unreachable");
    expect(existsSync(gmailDir())).toBe(false);
    expect((await readManifest(base)).pieces).toEqual([]);
  });

  test("a license check that throws refuses the install rather than letting it through", async () => {
    const err = await installPiece("gmail", { base, runBunInstall: async () => installWithDep("0.12.3", "left-pad", "MIT")(),
      checkLicenses: () => { throw new Error("boom"); } }).then(() => null, (e: unknown) => e);
    expect((err as PieceLicenseError).problems).toEqual(["the license check failed: boom"]);
  });

  test("removePackageDir reports a removal the filesystem refuses instead of throwing", () => {
    if (process.getuid?.() === 0) return; // root ignores the permission this relies on
    fakeInstall("@activepieces/piece-gmail", "1.0.0");
    const scope = resolve(base, "node_modules/@activepieces");
    chmodSync(scope, 0o555);
    try {
      expect(removePackageDir(base, "@activepieces/piece-gmail")).toBe(false);
    } finally { chmodSync(scope, 0o755); }
    expect(existsSync(gmailDir())).toBe(true);
  });

  test("removePackageDir removes only a plain package name under a real node_modules", () => {
    fakeInstall("@activepieces/piece-gmail", "1.0.0");
    for (const bad of ["../x", "@activepieces/../../x", "/etc", "node_modules", "", "Upper"]) expect(`${bad}: ${removePackageDir(base, bad)}`).toBe(`${bad}: false`);
    expect(removePackageDir(base, "@activepieces/piece-gmail")).toBe(true);
    expect(removePackageDir(base, "@activepieces/piece-gmail")).toBe(false);
    // A scope directory that is a link is never removed through.
    const outside = mkdtempSync(join(tmpdir(), "jarvis-pieces-outside-"));
    try {
      mkdirSync(join(outside, "piece-x"), { recursive: true });
      symlinkSync(outside, resolve(base, "node_modules/@evil"));
      expect(removePackageDir(base, "@evil/piece-x")).toBe(false);
      expect(existsSync(join(outside, "piece-x"))).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
