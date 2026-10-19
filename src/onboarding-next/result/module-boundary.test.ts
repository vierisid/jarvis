import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDraftResultProvider } from './index';
import { fixture, input } from './fixtures.test';
import { closeWorkflowDb } from '../../workflows/db';
import manifest from './manifest.json';
afterEach(closeWorkflowDb);
test('compiles as an isolated optional provider; construction performs no I/O', async () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-B-10', kind: 'provider', entry: './index.ts', provides: ['draft-result.v1'], requires: ['build-job.v1'] });
  const dir = mkdtempSync(join(tmpdir(), 'on-b10-boundary-'));
  try {
    for (const present of [false, true, false]) {
      const entry = join(dir, 'entry.ts'); writeFileSync(entry, present
        ? `export { createDraftResultProvider } from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};` : 'export const providers = {};');
      expect((await Bun.build({ entrypoints: [entry], target: 'bun' })).success).toBe(true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const runtimePath = '../runtime/runtime.ts', fixturePath = '../runtime/test-fixture.ts', routesPath = '../runtime/routes.ts';
test.skipIf(!existsSync(join(import.meta.dir, runtimePath)))('actual B11 result route with explicit test binder and absent/removed dependencies', async () => {
  const { createOnboardingRuntime } = await import(runtimePath), { fixtureOptions, omit } = await import(fixturePath);
  const { createOnboardingRoutes } = await import(routesPath), f = fixture(), options = fixtureOptions();
  options.authorize = () => f.owner;
  options.modules = options.modules.map((e: any) => e.manifest.id === manifest.id ? { manifest, load: async () => ({ createDraftResultProvider }) } : e);
  options.bindings['draft-result.v1'] = (module: any) => {
    const p = module.createDraftResultProvider({ enabled: true, authorize: (c: any) => c.scope, servicesFor: () => f.services });
    return { probe: () => ({ ready: true, reason: 'ready' }), operations: { 'result.read': (i: unknown, c: any) => p.read(c, i) } };
  };
  const request = () => new Request('http://localhost/api/onboarding-next/v1/result/read', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, input }) });
  const route = '/api/onboarding-next/v1/result/read';
  const response = await createOnboardingRoutes(createOnboardingRuntime(options))[route].POST(request());
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ schemaVersion: 1, result: { state: 'saved', flowId: f.flow.id, versionId: f.version.id } });
  for (const missing of ['draft-result.v1', 'build-job.v1', 'activation-intent.v1', 'compose-draft.v1']) {
    expect((await createOnboardingRoutes(createOnboardingRuntime(omit(options, missing)))[route].POST(request())).status).toBe(503);
  }
});
const routePath = '../../../ui/src/brief/entry/route.ts', viewPath = '../../../ui/src/onboarding-next/views/build/state.ts';
test.skipIf(!existsSync(join(import.meta.dir, viewPath)))('existing U08 reference and Brief version route accept only this persisted identity', async () => {
  const { verifiedReference } = await import(viewPath), { briefHash, resolveBriefEntry } = await import(routePath), f = fixture();
  const r = await createDraftResultProvider({ enabled: true, authorize: () => f.owner, servicesFor: () => f.services }).read(null, input);
  if (r.availability !== 'ready' || r.state !== 'saved') throw Error(JSON.stringify(r));
  expect(verifiedReference(r.reference, f.job.jobId, f.job.requestId)).toBe(true);
  expect(verifiedReference(r.reference, 'another-job', f.job.requestId)).toBe(false);
  expect(resolveBriefEntry(`http://localhost/?brief=1${briefHash(r.workflow)}`)).toEqual({ kind: 'brief', route: r.workflow });
  expect(r.selectedNodeId).toBeNull();
});
const canvasPath = '../../../ui/src/brief/workflows/canvas/request.ts';
test.skipIf(!existsSync(join(import.meta.dir, canvasPath)))('D18 existing canvas request adapter accepts the exact draft and rejects a replacement', async () => {
  const { versionBoundRequest } = await import(canvasPath), f = fixture();
  const r = await createDraftResultProvider({ enabled: true, authorize: () => f.owner, servicesFor: () => f.services }).read(null, input);
  if (r.availability !== 'ready' || r.state !== 'saved') throw Error(JSON.stringify(r));
  let versionId = r.versionId;
  const request = versionBoundRequest(async () => Response.json({ flow: { id: r.flowId }, latestDraft: {
    id: versionId, flowId: r.flowId, displayName: r.title, trigger: r.graph,
  } }), r.flowId, r.versionId);
  expect((await (await request(`/api/workflows/${r.flowId}`)).json()).latestDraft.trigger).toEqual(r.graph);
  versionId = 'replacement';
  await expect(request(`/api/workflows/${r.flowId}`)).rejects.toThrow('selected version changed');
});
