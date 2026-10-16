import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createActivationIntentProvider } from './index.ts';
import { fixture, submission } from './test-fixture.ts';
import manifest from './manifest.json';

test('provider and feedback bundle independently; absence/removal requires no sibling import', async () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-B-07', kind: 'provider', entry: './index.ts', provides: ['activation-intent.v1'], requires: [] });
  expect((await Bun.build({ entrypoints: [join(import.meta.dir, 'feedback.ts')], target: 'browser' })).success).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'on-b-07-boundary-'));
  try {
    for (const present of [false, true, false]) {
      const path = join(dir, 'entry.ts');
      writeFileSync(path, present ? `export { createActivationIntentProvider } from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};` : 'export const registry = {};');
      expect((await Bun.build({ entrypoints: [path], target: 'bun' })).success).toBe(true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const runtimePath = '../runtime/runtime.ts', fixturePath = '../runtime/test-fixture.ts';
test.skipIf(!existsSync(join(import.meta.dir, runtimePath)))('real B11 maps intent.validate and fails closed without the module/binding', async () => {
  const { createOnboardingRuntime } = await import(runtimePath), { fixtureOptions, request, omit } = await import(fixturePath);
  const options = fixtureOptions(), f = fixture();
  options.modules = options.modules.map((e: any) => e.manifest.id === 'ON-B-07' ? { manifest, load: async () => ({ createActivationIntentProvider }) } : e);
  options.bindings['activation-intent.v1'] = (module: any) => {
    const provider = module.createActivationIntentProvider(f.deps);
    return { probe: () => ({ ready: true, reason: 'ready' }), operations: { 'intent.validate': (input: unknown, c: any) => provider.validate(c, input, c.signal) } };
  };
  const runtime = createOnboardingRuntime(options);
  expect((await runtime.status(request())).capabilities['activation-intent.v1'].ready).toBe(true); expect(f.calls).toEqual([]);
  expect(await runtime.execute(request(), 'intent.validate', submission())).toMatchObject({ state: 'ready' });
  for (const missing of [omit(options, 'activation-intent.v1'), { ...options, bindings: { ...options.bindings, 'activation-intent.v1': undefined } }]) {
    const absent = createOnboardingRuntime(missing);
    expect((await absent.status(request())).capabilities['activation-intent.v1'].ready).toBe(false);
    await expect(absent.execute(request(), 'intent.validate', submission())).rejects.toThrow();
  }
});
