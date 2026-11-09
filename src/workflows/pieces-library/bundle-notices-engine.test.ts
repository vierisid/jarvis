/**
 * #1166: THIRD_PARTY_NOTICES-engine.md is exactly what the installed engine
 * staging tree renders, license texts included. The fast suite holds its
 * package list to engine-staging.lock (bundle-notices.test.ts); this holds the
 * texts, which need the install.
 *
 * Needs the staging install, which `bun install`s from the registry: runs with
 * `JARVIS_TEST_ENGINE_BUILD=1`, like the other engine-build suites.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENGINE_BUILD_PATHS, ensureStagingInstalled } from "../runner/engine-runtime/build";
import { ENGINE_NOTICES_FILE, engineBundleNotices } from "./bundle-notices";

const gate = process.env.JARVIS_TEST_ENGINE_BUILD === "1";

test.skipIf(!gate)("#1166: the engine bundle notices, regenerated from the installed staging tree, are the committed file", async () => {
  await ensureStagingInstalled();
  const fresh = engineBundleNotices(ENGINE_BUILD_PATHS.STAGING_DIR);
  expect(fresh.problems).toEqual([]);
  expect(fresh.packages.map((p) => p.name)).toContain("openpgp");
  expect(fresh.text).toBe(readFileSync(resolve(ENGINE_BUILD_PATHS.REPO_ROOT, ENGINE_NOTICES_FILE), "utf8"));
}, 300_000);
