import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import manifest from './manifest.json';
import { createTourProvider } from './provider.ts';
import { portFixture, owner } from './test-fixture.ts';

test('standalone, absent and removed catalogs bundle with no startup effects or sibling imports', async () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-B-06', kind: 'provider', entry: './index.ts', provides: ['tour.v1'], requires: ['journey.v1'] });
  expect((await Bun.build({ entrypoints: [join(import.meta.dir, 'view-adapter.ts')], target: 'browser' })).success).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'on-b-06-boundary-'));
  try {
    for (const present of [false, true, false]) {
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, present ? `export { createTourProvider } from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};` : 'export const registry = {};');
      const result = await Bun.build({ entrypoints: [entry], target: 'bun' }); expect(result.success).toBe(true);
      const code = await result.outputs[0]!.text(); expect(code).not.toContain('../journey'); expect(code).not.toContain('api-routes');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const runtimePath = '../runtime/runtime.ts', fixturePath = '../runtime/test-fixture.ts';
test.skipIf(!existsSync(join(import.meta.dir, runtimePath)))('real B11 routes the provider; absence of B01/B06 closes the capability', async () => {
  const { createOnboardingRuntime } = await import(runtimePath), { fixtureOptions, request, omit } = await import(fixturePath);
  const options = fixtureOptions(), f = portFixture(); options.authorize = () => owner;
  options.modules = options.modules.map((e: any) => e.manifest.id === 'ON-B-06' ? { manifest, load: async () => ({ createTourProvider }) } : e);
  options.bindings['tour.v1'] = (module: any) => {
    const provider = module.createTourProvider({ enabled: true, authorize: () => owner, journeyFor: () => f.port, roomStatus: () => 'ready' });
    return { probe: () => ({ ready: true, reason: 'ready' }), operations: { 'tour.command': (input: unknown, c: any) => provider.request(c, input, c.signal) } };
  };
  const runtime = createOnboardingRuntime(options);
  expect((await runtime.status(request())).capabilities['tour.v1'].ready).toBe(true); expect(f.writes).toBe(0);
  expect(await runtime.execute(request(), 'tour.command', { type: 'read' })).toMatchObject({ snapshot: { stepId: 'today' } });
  for (const cap of ['tour.v1', 'journey.v1']) {
    const partial = createOnboardingRuntime(omit(options, cap)); expect((await partial.status(request())).ready).toBe(false);
    expect((await partial.status(request())).capabilities['tour.v1'].ready).toBe(false);
    await expect(partial.execute(request(), 'tour.command', { type: 'read' })).rejects.toThrow();
  }
});
