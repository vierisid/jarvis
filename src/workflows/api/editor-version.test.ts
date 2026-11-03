import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { createFlow, setPublishedVersion } from '../db/repos/flow';
import { createDraftVersion, getFlowVersion, getLatestDraft, lockVersion, updateDraftVersion } from '../db/repos/flow-version';
import { draftRevision } from '../../actions/tools/workflow-draft-update';
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
test('an editor save invalidates an assistant readback revision of the same draft', async () => {
  const { version, call } = fixture();
  const assistant = draftRevision(getFlowVersion(version.id)!);
  const revision = (await call('GET')).body.editorRevision;
  expect((await call('PATCH', { expectedRevision: revision, displayName: 'Editor edit' })).status).toBe(200);
  expect(draftRevision(getFlowVersion(version.id)!)).not.toBe(assistant);
});
test('the first save from a published version cannot supersede a draft created meanwhile', async () => {
  const flow = createFlow();
  const published = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Live', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  setPublishedVersion(flow.id, published.id);
  const routes = createWorkflowRoutes();
  const detail = async () => {
    const request = new Request('http://localhost') as Request & { params: any };
    request.params = { id: flow.id };
    return await (await routes['/api/workflows/:id']!.GET!(request)).json() as any;
  };
  const post = async (body: unknown) => {
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }) as Request & { params: any };
    request.params = { id: flow.id };
    const response = await routes['/api/workflows/:id/versions']!.POST!(request);
    return { status: response.status, body: await response.json() as any };
  };
  const tabA = (await detail()).published.editorRevision, tabB = (await detail()).published.editorRevision;
  const first = await post({ expectedRevision: tabA, displayName: 'Tab A', trigger: { name: 'trigger', type: 'EMPTY' } });
  expect(first.status).toBe(201);
  expect(first.body.editorRevision).toMatch(/^[a-f0-9]{64}$/);
  const stale = await post({ expectedRevision: tabB, displayName: 'Tab B', trigger: { name: 'trigger', type: 'EMPTY' } });
  expect(stale.status).toBe(409);
  expect(getLatestDraft(flow.id)?.displayName).toBe('Tab A');
  // Older clients without a revision keep the previous behaviour.
  expect((await post({ displayName: 'Legacy', trigger: { name: 'trigger', type: 'EMPTY' } })).status).toBe(201);
});
