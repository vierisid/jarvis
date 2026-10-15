import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBuildJobsProvider } from './index';
import manifest from './manifest.json';

test('isolated module builds with no runtime host or sibling providers imported', async () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-B-08', kind: 'provider', entry: './index.ts',
    provides: ['build-job.v1'], requires: ['activation-intent.v1', 'compose-draft.v1'] });
  const directory = mkdtempSync(join(tmpdir(), 'on-b08-boundary-'));
  try {
    for (const present of [false, true, false]) {
      const path = join(directory, 'entry.ts');
      writeFileSync(path, present ? `export { createBuildJobsProvider } from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};` : 'export const providers = {};');
      expect((await Bun.build({ entrypoints: [path], target: 'bun' })).success).toBe(true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
const runtimePath = '../runtime/runtime.ts', fixturePath = '../runtime/test-fixture.ts';
test.skipIf(!existsSync(join(import.meta.dir, runtimePath)))('B11 binds the three public operations and refuses missing/removed dependencies', async () => {
  const { createOnboardingRuntime } = await import(runtimePath), { fixtureOptions, request, omit } = await import(fixturePath);
  const options = fixtureOptions();
  options.modules = options.modules.map((e: any) => e.manifest.id === manifest.id ? { manifest, load: async () => ({ createBuildJobsProvider }) } : e);
  options.bindings['build-job.v1'] = (module: any) => {
    const provider = module.createBuildJobsProvider({ enabled: true, authorize: (c: any) => c.scope, servicesFor: () => null });
    return { probe: () => ({ ready: true, reason: 'ready' }), operations: {
      'build.submit': (value: unknown, c: any) => provider.submit(c, value),
      'build.read': (value: unknown, c: any) => provider.read(c, value),
      'build.cancel': (value: unknown, c: any) => provider.cancel(c, value),
    } };
  };
  const runtime = createOnboardingRuntime(options);
  expect((await runtime.status(request())).capabilities['build-job.v1'].ready).toBe(true);
  expect(await runtime.execute(request(), 'build.read', { schemaVersion: 1, jobId: 'one' })).toMatchObject({ reason: 'binding_missing' });
  await expect(runtime.execute(request(), 'build.run', {})).rejects.toThrow();
  for (const missing of ['build-job.v1', 'activation-intent.v1', 'compose-draft.v1']) {
    expect((await createOnboardingRuntime(omit(options, missing)).status(request())).capabilities['build-job.v1'].ready).toBe(false);
  }
});
