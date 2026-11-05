/**
 * #971: the engine's staging install is license-checked like the hosted pieces
 * tree. Every third-party module the engine bundle and the vendored pieces'
 * bundles compile in comes from it (`engine-staging.lock`), and those bundles
 * ship in the Docker image and the hosted shared runtime, so what it holds is
 * what we distribute. The same policy applies (`license-policy.ts`): permissive,
 * or LGPL/MPL used unmodified, or a reviewed entry for a package with no usable
 * declaration.
 *
 * Needs the staging install, which `bun install`s from the registry: runs with
 * `JARVIS_TEST_ENGINE_BUILD=1`, like the other engine-build suites.
 */
import { describe, expect, test } from 'bun:test';
import { ENGINE_BUILD_PATHS, buildStagingPackageJson, ensureStagingInstalled } from './build';
import { describeViolations, scanInstalledTree } from '../../pieces-library/license-scan';

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';

describe.skipIf(!buildOptIn)('#971: the engine staging install', () => {
  test('every installed package passes the license policy, and the scan saw every declared dependency', async () => {
    await ensureStagingInstalled();
    const scan = scanInstalledTree(ENGINE_BUILD_PATHS.STAGING_DIR, { lockfile: 'required' });
    expect(describeViolations(scan)).toEqual([]);
    // Completeness: a layout the scan cannot read would otherwise pass as clean.
    const declared = Object.keys((JSON.parse(buildStagingPackageJson()) as { dependencies: Record<string, string> }).dependencies).sort();
    const top = new Set(scan.packages.filter((p) => p.chain.length === 1).map((p) => p.name));
    expect(declared.filter((name) => !top.has(name))).toEqual([]);
    expect(scan.packages.length).toBeGreaterThan(declared.length);
  }, 300_000);
});
