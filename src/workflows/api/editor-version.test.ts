import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, getFlowVersion, updateDraftVersion } from '../db/repos/flow-version';
import { createWorkflowRoutes } from './routes';

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());
const path = '/api/workflows/:id/versions/:versionId';
function fixture() {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Original', trigger: { name: 'trigger', type: 'EMPTY' } });
  const routes = createWorkflowRoutes();
  const call = async (method: 'GET' | 'PATCH', body?: unknown) => {
    const request = new Request('http://localhost', { method, ...(body ? { body: JSON.stringify(body) } : {}) }) as Request & { params: any };
    request.params = { id: flow.id, versionId: version.id };
    const response = await routes[path]![method]!(request);
    return { status: response.status, body: await response.json() as any };
  };
  return { flow, version, call };
}
test('two editors cannot overwrite a newer save, even in the same millisecond', async () => {
  const { version, call } = fixture();
  const a = (await call('GET')).body, b = (await call('GET')).body;
  expect(a.editorRevision).toMatch(/^[a-f0-9]{64}$/);
  const saved = await call('PATCH', { expectedRevision: a.editorRevision, displayName: 'Newer edit' });
  expect(saved.status).toBe(200);
  expect((await call('PATCH', { expectedRevision: b.editorRevision, displayName: 'Stale edit' })).status).toBe(409);
  expect(getFlowVersion(version.id)?.displayName).toBe('Newer edit');
  expect((await call('PATCH', { expectedRevision: saved.body.editorRevision, displayName: 'Next edit' })).status).toBe(200);
});
test('an AI/repository edit and a layout-only edit each invalidate the editor snapshot', async () => {
  const { version, call } = fixture();
  let revision = (await call('GET')).body.editorRevision;
  updateDraftVersion(version.id, { displayName: 'AI change' });
  expect((await call('PATCH', { expectedRevision: revision, displayName: 'Stale' })).status).toBe(409);
  revision = (await call('GET')).body.editorRevision;
  expect((await call('PATCH', { expectedRevision: revision, uiMeta: { schema: 1, positions: { trigger: { x: 2, y: 3 } }, orphans: [] } })).status).toBe(200);
  expect((await call('PATCH', { expectedRevision: revision, uiMeta: { schema: 1, positions: {}, orphans: [] } })).status).toBe(409);
});
