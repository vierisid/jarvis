import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposeDraftProvider } from './index';
import manifest from './manifest.json';

test('manifest and module build without onboarding siblings; absent/present/removed hosts build', async () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-B-09', kind: 'provider', entry: './index.ts', provides: ['compose-draft.v1'], requires: [] });
  const dir = mkdtempSync(join(tmpdir(), 'on-b09-boundary-'));
  try {
    for (const present of [false, true, false]) {
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, present ? `export { createComposeDraftProvider } from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};` : 'export const registry = {};');
      expect((await Bun.build({ entrypoints: [entry], target: 'bun' })).success).toBe(true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const runtimePath = '../runtime/runtime.ts', fixturePath = '../runtime/test-fixture.ts';
test.skipIf(!existsSync(join(import.meta.dir, runtimePath)))('B11 discovers composition only as an internal capability and fails closed on removal', async () => {
  const { createOnboardingRuntime } = await import(runtimePath), { fixtureOptions, request, omit } = await import(fixturePath);
  const options = fixtureOptions();
  options.modules = options.modules.map((e: any) => e.manifest.id === 'ON-B-09' ? { manifest, load: async () => ({ createComposeDraftProvider }) } : e);
  let bound = false;
  options.bindings['compose-draft.v1'] = (module: any) => {
    expect(typeof module.createComposeDraftProvider).toBe('function'); bound = true;
    return { probe: () => ({ ready: true, reason: 'ready' }), operations: {} };
  };
  const runtime = createOnboardingRuntime(options);
  expect((await runtime.status(request())).capabilities['compose-draft.v1'].ready).toBe(true); expect(bound).toBe(true);
  await expect(runtime.execute(request(), 'compose.save', {})).rejects.toThrow();
  for (const absent of [omit(options, 'compose-draft.v1'), { ...options, bindings: { ...options.bindings, 'compose-draft.v1': undefined } }]) {
    const status = await createOnboardingRuntime(absent).status(request());
    expect(status.capabilities['compose-draft.v1'].ready).toBe(false);
    expect(status.capabilities['build-job.v1'].ready).toBe(false);
  }
});
