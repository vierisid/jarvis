/**
 * Gated integration test: runs a real `bun install` for one catalog entry
 * (gmail) into a temp pieces dir and confirms the published package can be
 * `require()`d. Skipped unless `JARVIS_TEST_PIECES_LIBRARY=1` because it
 * needs outbound network to npm and adds ~5-10s to the test run.
 *
 * Run with:
 *   JARVIS_TEST_PIECES_LIBRARY=1 bun test src/workflows/pieces-library/integration.test.ts
 *
 * Purpose:
 *   - Catches if npm changes the published-package layout for activepieces
 *     (today: `main: ./src/index.js` with `src/` shipped pre-built).
 *   - Catches if a vetted piece silently goes broken on a patch release
 *     within our caret range.
 *   - Catches if Bun's resolver stops handling the semver shape we use.
 *
 * Scope:
 *   - Stops at "the bundle is requireable and exports a piece-shaped object."
 *   - Does NOT exercise the full engine subprocess + metadata extraction --
 *     that's an order of magnitude more setup and is covered indirectly by
 *     the engine-end-to-end suite for Jarvis-native pieces.
 *
 * Coverage gates a single entry by default. Add more pieces to
 * `ENTRIES_UNDER_TEST` if you want a broader smoke -- each adds ~5s to
 * the run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CATALOG } from "./catalog";

const ENABLED = process.env.JARVIS_TEST_PIECES_LIBRARY === "1";

/**
 * Catalog entries to smoke-test. Gmail is the canary -- biggest dep
 * footprint (googleapis), so if anything goes wrong with native bindings
 * or transitive resolution under Bun it surfaces here first.
 */
const ENTRIES_UNDER_TEST = ["gmail"] as const;

let tempDir: string;

beforeEach(() => {
  if (!ENABLED) return;
  tempDir = mkdtempSync(join(tmpdir(), "jarvis-pieces-integration-"));
});

afterEach(() => {
  if (!ENABLED) return;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("pieces-library integration (gated on JARVIS_TEST_PIECES_LIBRARY=1)", () => {
  for (const id of ENTRIES_UNDER_TEST) {
    test.skipIf(!ENABLED)(
      `${id}: bun installs the package and the bundle is requireable`,
      async () => {
        const entry = CATALOG.find((e) => e.id === id);
        if (!entry) throw new Error(`catalog entry "${id}" missing`);

        // 1. Synthesize a minimal package.json + run bun install.
        writeFileSync(
          resolve(tempDir, "package.json"),
          JSON.stringify({
            name: "jarvis-pieces-integration",
            private: true,
            type: "commonjs",
            dependencies: { [entry.npmPackage]: entry.versionRange },
          }) + "\n",
        );
        const installRes = spawnSync("bun", ["install", "--silent"], {
          cwd: tempDir,
          stdio: "pipe",
          encoding: "utf8",
        });
        if (installRes.status !== 0) {
          throw new Error(
            `bun install for ${entry.npmPackage}@${entry.versionRange} failed:\n${installRes.stderr}`,
          );
        }

        // 2. Read back the resolved version + confirm `main` resolves to a real file.
        const pkgJsonPath = resolve(
          tempDir,
          "node_modules",
          entry.npmPackage,
          "package.json",
        );
        expect(existsSync(pkgJsonPath)).toBe(true);
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
          name: string;
          version: string;
          main?: string;
        };
        expect(pkg.name).toBe(entry.npmPackage);
        // Resolved version must satisfy the catalog range. We don't re-run a
        // semver matcher here -- bun already enforced that by resolving. But
        // we DO check the resolved version is within minor of vettedVersion
        // so a runaway upstream release surfaces as a test failure rather
        // than a silent surprise in production.
        const [vMajor, vMinor] = entry.vettedVersion.split(".");
        const [pMajor, pMinor] = pkg.version.split(".");
        expect(pMajor).toBe(vMajor);
        expect(pMinor).toBe(vMinor);

        // 3. Require the bundle from a fresh sub-process. We avoid the
        // current process's require cache + path so any environmental leak
        // (e.g., resolution falling through to a peer node_modules) would
        // surface as an error.
        const requireScript = `
          const path = require("node:path");
          const mainPath = require.resolve(${JSON.stringify(entry.npmPackage)}, {
            paths: [${JSON.stringify(tempDir)}],
          });
          const mod = require(mainPath);
          // The piece is exported by name (e.g., \`gmail\` for piece-gmail).
          // We don't assume the export key -- we just verify SOMETHING in
          // the module looks like a piece (has \`actions\` callable).
          const candidates = Object.values(mod).filter((v) =>
            v && typeof v === "object" && typeof v.actions === "function"
          );
          if (candidates.length === 0) {
            console.error("EXPORT_KEYS=" + JSON.stringify(Object.keys(mod)));
            process.exit(2);
          }
          const piece = candidates[0];
          const actions = piece.actions();
          const triggers = piece.triggers ? piece.triggers() : {};
          process.stdout.write(JSON.stringify({
            actionCount: Object.keys(actions).length,
            triggerCount: Object.keys(triggers).length,
          }));
        `;
        const requireRes = spawnSync("bun", ["-e", requireScript], {
          cwd: tempDir,
          stdio: "pipe",
          encoding: "utf8",
        });
        if (requireRes.status !== 0) {
          throw new Error(
            `bundle require failed for ${entry.npmPackage}:\nstdout: ${requireRes.stdout}\nstderr: ${requireRes.stderr}`,
          );
        }
        const result = JSON.parse(requireRes.stdout) as {
          actionCount: number;
          triggerCount: number;
        };
        // We don't assert exact counts (they drift with piece releases) but
        // every catalog entry should expose at least one action.
        expect(result.actionCount).toBeGreaterThan(0);
      },
      120_000, // 2 min timeout: bun install + first-run resolution.
    );
  }
});
