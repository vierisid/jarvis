import { afterEach, beforeEach, expect, test } from 'bun:test';
import { compileWorkflow } from './workflow-readiness';
import { PieceCatalog, propsToInputSchema } from './piece-catalog';
import { validateCronExpression, CronScheduler } from '../../lib/cron-scheduler';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../db';
import { configureWorkflowReadiness, versionReadiness } from '../db/repos/flow-readiness';
import { createFlow, getFlow, setPublishedVersion, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion, getFlowVersion, updateDraftVersion, setSampleInputEntry } from '../db/repos/flow-version';
import { publishFlowVersion } from '../db/repos/flow-publication';
import { createWorkflowRoutes } from '../api/routes';
import { createManageWorkflowTool } from '../../actions/tools/manage-workflow';
import { composeFlow } from '../../actions/tools/workflow-composer';
import { TriggerManager } from '../runner/triggers/manager';
import { WorkflowEventBus } from './event-bus';
import { setEncryptionKey } from '../db/encryption';
import { upsertConnection } from '../db/repos/app-connection';
import { CredentialResolver } from '../credentials/adapter';

const pieces = new PieceCatalog([
  { name: 'test', displayName: 'Test', description: '', actions: {
    send: { name: 'send', displayName: '', description: '', inputSchema: { fields: [
      { name: 'to', label: '', type: 'string', required: true },
      { name: 'count', label: '', type: 'number', required: false },
      { name: 'at', label: '', type: 'datetime', required: false },
    ] } },
    child: { name: 'child', displayName: '', description: '', inputSchema: { fields: [
      { name: 'flow', label: '', type: 'flow_ref', required: true },
    ] } },
  } },
  { name: 'auth', displayName: '', description: '', auth: { type: 'SECRET_TEXT' }, actions: {
    send: { name: 'send', displayName: '', description: '' },
    public: { name: 'public', displayName: '', description: '', requireAuth: false },
  } },
]);
const step = (name = 'send', to = '{{trigger.email}}'): any => ({ name, type: 'PIECE', settings: { pieceName: 'test', actionName: 'send', input: { to } } });
const graph = (nextAction = step()): any => ({ name: 'trigger', type: 'EMPTY', nextAction });
const cron = (expression = '0 9 * * 1-5'): any => ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: expression } }, nextAction: step('send', 'literal') });
const compile = (g: unknown) => compileWorkflow(g, { pieces });

for (const expression of ['60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '4-1 * * * *', '1junk * * * *', '1//2 * * * *', '@every 0s', 'bad cron', '0 0 31 2 *']) {
  test(`cron preflight and scheduler reject ${expression}`, () => {
    expect(() => validateCronExpression(expression)).toThrow();
    const scheduler = new CronScheduler();
    try { expect(() => scheduler.schedule('bad', expression, () => {})).toThrow(); }
    finally { scheduler.cancelAll(); }
    expect(compile(cron(expression)).issues).toContainEqual(expect.objectContaining({ node: 'trigger', code: 'CRON' }));
  });
}
test('valid schedules, ranges and subminute intervals use the scheduler grammar', () => {
  for (const expression of ['*/5 0-23/2 1,15 * 0-6', '@every 10s', '0 9 * * 1-5', '0 0 29 2 *']) expect(compile(cron(expression)).ready).toBe(true);
});
test('missing, forward, self, sibling and loop-local references fail with node locations', () => {
  for (const to of ['{{absent.email}}', '{{send.email}}', '{{false ? later.x : trigger.x}}']) {
    expect(compile(graph(step('send', to))).issues).toContainEqual(expect.objectContaining({ node: 'send', path: 'settings.input.to', code: 'REFERENCE_SCOPE' }));
  }
  const loop: any = { name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.rows}}' }, firstLoopAction: step('body', '{{loop.item.email}}'), nextAction: step('after', '{{body.email}}') };
  expect(compile(graph(loop)).issues.map(i => i.node)).toEqual(['after']);
  loop.nextAction.settings.input.to = '{{trigger.email}}';
  expect(compile(graph(loop)).ready).toBe(true);
  const router: any = { name: 'router', type: 'ROUTER', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [{ branchType: 'FALLBACK' }, { branchType: 'FALLBACK' }] }, children: [step('left'), step('right', '{{left.email}}')] };
  expect(compile(graph(router)).issues).toContainEqual(expect.objectContaining({ node: 'right', code: 'REFERENCE_SCOPE' }));
});
test('invalid graphs, unknown actions and known input types fail without trusting valid flags', () => {
  const g = graph();
  g.valid = true;
  g.nextAction.settings.input.count = 'not a number';
  g.nextAction.settings.input.at = 'not a date';
  expect(compile(g).issues).toContainEqual(expect.objectContaining({ node: 'send', code: 'INPUT_TYPE' }));
  expect(compile(g).issues.some(i => i.path.endsWith('.at'))).toBe(true);
  g.nextAction.settings.actionName = 'missing';
  expect(compile(g).issues.some(i => i.code === 'ACTION')).toBe(true);
  g.nextAction.settings.actionName = 'constructor';
  expect(compile(g).issues.some(i => i.code === 'ACTION')).toBe(true);
  g.nextAction.nextAction = g.nextAction;
  expect(compile(g).issues.some(i => i.code === 'LIMIT')).toBe(true);
  expect(compile({ name: 'trigger', type: 'CODE' }).ready).toBe(false);
  expect(compile(graph(step('send', '{{null}}'))).ready).toBe(false);
  expect(compile(graph({ name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{123}}' } })).ready).toBe(false);
});
test('dynamic data is an explicit runtime check, not a fabricated output schema', () => {
  const result = compile(graph());
  expect(result.ready).toBe(true);
  expect(result.runtimeChecks).toContainEqual(expect.objectContaining({ node: 'send', path: 'settings.input.to', guard: 'piece-input' }));
});
test('manual invoke graphs require known tool identities and their actual parameter contracts', () => {
  const catalog = new PieceCatalog([...pieces.list(), { name: 'jarvis-tool', displayName: '', description: '', actions: { invoke: { name: 'invoke', displayName: '', description: '' } } }]);
  const action = step(); action.settings = { pieceName: 'jarvis-tool', actionName: 'invoke', input: { toolName: 'send', params: {} } };
  const context = { pieces: catalog, tool: (name: string) => name === 'send' ? { params: [{ name: 'recipient', type: 'string', required: true }] } : null };
  expect(compileWorkflow(graph(action), context).issues.some(i => i.path.endsWith('.recipient'))).toBe(true);
  action.settings.input.params.recipient = '{{trigger.email}}';
  expect(compileWorkflow(graph(action), context).ready).toBe(true);
  expect(compileWorkflow(graph(action), context).runtimeChecks.some(c => c.guard === 'tool-input')).toBe(true);
  action.settings.input.toolName = '{{trigger.tool}}';
  expect(compileWorkflow(graph(action), context).ready).toBe(true);
  expect(compileWorkflow(graph(action), context).runtimeChecks.some(c => c.guard === 'tool-input' && c.path === 'settings.input')).toBe(true);
  action.settings.input = { toolName: 'list' };
  expect(compileWorkflow(graph(action), { pieces: catalog, tool: () => ({ params: [] }) }).ready).toBe(true);
});
test('native cron triggers receive the same schedule check as the built-in primitive', () => {
  const catalog = new PieceCatalog([{ name: '@activepieces/piece-schedule', displayName: '', description: '', actions: {}, triggers: { cron_expression: { name: 'cron_expression', displayName: '', description: '' } } }]);
  const trigger = { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: '@activepieces/piece-schedule', triggerName: 'cron_expression', input: { cronExpression: '61 * * * *', timezone: 'UTC' } } };
  expect(compileWorkflow(trigger, { pieces: catalog }).issues.some(i => i.code === 'CRON')).toBe(true);
  trigger.settings.input.cronExpression = '0 9 * * *';
  expect(compileWorkflow(trigger, { pieces: catalog }).ready).toBe(true);
  trigger.settings.input.timezone = 'Invalid/Zone';
  expect(compileWorkflow(trigger, { pieces: catalog }).ready).toBe(false);
});
test('an unresolved required dynamic schema blocks activation with a node explanation', () => {
  const catalog = new PieceCatalog([{ name: 'dynamic', displayName: '', description: '', actions: { fill: { name: 'fill', displayName: '', description: '', inputSchema: { fields: [{ name: 'form', label: '', type: 'json', sourceType: 'DYNAMIC', required: true }] } } } }]);
  const action = step(); action.settings = { pieceName: 'dynamic', actionName: 'fill', input: { form: { value: '{{trigger.value}}' } } };
  expect(compileWorkflow(graph(action), { pieces: catalog }).issues).toContainEqual(expect.objectContaining({ node: 'send', code: 'UNRESOLVED_CHECK', path: 'settings.input.form' }));
});

beforeEach(() => { initWorkflowDb(':memory:'); setEncryptionKey(Buffer.alloc(32, 0x71)); configureWorkflowReadiness({ pieces }); });
afterEach(() => { closeWorkflowDb(); setEncryptionKey(null); });
function draft(trigger: any) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Test', trigger });
  return { flow, version };
}
async function request(path: string, method: string, params: Record<string, string>, body?: unknown) {
  const req = Object.assign(new Request(`http://local${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) }), { params });
  const handler = createWorkflowRoutes()[path]![method as 'GET' | 'POST' | 'PATCH']!;
  return handler(req);
}
test('API publication and enable reject with 422 and preserve both row states', async () => {
  const { flow, version } = draft(cron('90 * * * *'));
  for (const versionId of [undefined, version.id]) {
    const response = await request('/api/workflows/:id/publish', 'POST', { id: flow.id }, { versionId });
    expect(response.status).toBe(422);
    expect((await response.json()).issues[0].node).toBe('trigger');
    expect(getFlow(flow.id)!.status).toBe('DISABLED');
    expect(getFlowVersion(version.id)!.state).toBe('DRAFT');
    expect(getFlow(flow.id)!.published_version_id).toBeNull();
  }
  expect((await request('/api/workflows/:id', 'PATCH', { id: flow.id }, { status: 'ENABLED' })).status).toBe(422);
  expect((await request('/api/workflows/:id/versions/:versionId/lock', 'POST', { id: flow.id, versionId: version.id })).status).toBe(422);
  const readiness = await request('/api/workflows/:id/versions/:versionId/readiness', 'GET', { id: flow.id, versionId: version.id });
  expect((await readiness.json()).ready).toBe(false);
});
test('chat publish, enable and direct run use the same validator', async () => {
  const { flow } = draft(graph(step('send', '{{missing.email}}')));
  const tool = createManageWorkflowTool();
  for (const action of ['publish', 'enable', 'run']) await expect(tool.execute({ action, flow: flow.id })).rejects.toThrow('Reference "missing"');
  expect((await request('/api/workflows/:id/run', 'POST', { id: flow.id }, {})).status).toBe(422);
});
test('correct explicit and latest draft publication work; invalid republish is atomic', () => {
  const { flow, version } = draft(cron());
  expect(publishFlowVersion(flow.id, version.id).flow.status).toBe('ENABLED');
  const next = createDraftVersion({ flowId: flow.id, displayName: 'invalid', trigger: cron('invalid') });
  expect(() => publishFlowVersion(flow.id)).toThrow();
  expect(() => setPublishedVersion(flow.id, null)).toThrow();
  expect(getFlow(flow.id)!.published_version_id).toBe(version.id);
  expect(getFlowVersion(next.id)!.state).toBe('DRAFT');
  updateDraftVersion(next.id, { trigger: cron('@every 10s') });
  expect(publishFlowVersion(flow.id).version.id).toBe(next.id);
});
test('editing or creating a live draft cannot bypass activation validation', () => {
  const { flow, version } = draft(cron());
  updateFlowStatus(flow.id, 'ENABLED');
  expect(() => updateDraftVersion(version.id, { trigger: cron('bad'), valid: true })).toThrow();
  expect(() => createDraftVersion({ flowId: flow.id, displayName: 'bad', trigger: cron('bad') })).toThrow();
  expect(getFlowVersion(version.id)!.trigger).toEqual(cron());
});
test('a client cannot label an invalid disabled draft as valid', () => {
  const { version } = draft(cron());
  expect(updateDraftVersion(version.id, { trigger: cron('bad'), valid: true }).valid).toBe(false);
  expect(updateDraftVersion(version.id, { valid: true }).valid).toBe(false);
  expect(updateDraftVersion(version.id, { trigger: cron() }).valid).toBe(true);
});
test('connection bindings are project-scoped, unique, active and matched to the piece', () => {
  const action = step(); action.settings = { pieceName: 'auth', actionName: 'send', input: { auth: '{{connections.account}}' } };
  const { flow, version } = draft(graph(action));
  const save = (pieceName = 'auth', projectId?: string) => upsertConnection({ externalId: 'account', pieceName, projectId, displayName: 'Fake', pieceVersion: '1', type: 'SECRET_TEXT', value: { secret_text: 'synthetic-only' } });
  save('auth', 'other-project');
  expect(versionReadiness(flow.id, version.id).ready).toBe(false);
  save();
  expect(versionReadiness(flow.id, version.id).ready).toBe(true);
  const row = save('different-piece');
  expect(versionReadiness(flow.id, version.id).issues.some(i => i.message.includes('ambiguous'))).toBe(true);
  getWorkflowDb().run('DELETE FROM app_connection WHERE id = ?', [row.id]);
  getWorkflowDb().run("UPDATE app_connection SET status = 'ERROR' WHERE external_id = ?", ['account']);
  expect(versionReadiness(flow.id, version.id).ready).toBe(false);
  action.settings.input.auth = '{{connections[\'jarvis:fake\']}}';
  updateDraftVersion(version.id, { trigger: graph(action) });
  const credentials = new CredentialResolver();
  let resolutions = 0;
  credentials.register({ id: 'fake', canResolve: id => id === 'jarvis:fake', resolve: async () => { resolutions++; return null; } });
  configureWorkflowReadiness({ pieces, credentials });
  const result = versionReadiness(flow.id, version.id);
  expect(result.ready).toBe(true);
  expect(result.runtimeChecks.some(c => c.guard === 'connection')).toBe(true);
  expect(resolutions).toBe(0); // No token refresh or LLM/network call in the transaction.
});
test('missing catalog and required workflow/connection bindings block activation', () => {
  const child = step(); child.settings = { pieceName: 'test', actionName: 'child', input: { flow: 'missing' } };
  const { flow, version } = draft(graph(child));
  expect(versionReadiness(flow.id, version.id).issues.some(i => i.code === 'WORKFLOW_BINDING')).toBe(true);
  const target = createFlow();
  child.settings.input.flow = target.id;
  updateDraftVersion(version.id, { trigger: graph(child) });
  expect(versionReadiness(flow.id, version.id).ready).toBe(false);
  createDraftVersion({ flowId: target.id, displayName: 'Child', trigger: { name: 'trigger', type: 'EMPTY' } });
  expect(versionReadiness(flow.id, version.id).ready).toBe(true);
  child.settings.input.flow = '{{trigger.flow}}';
  updateDraftVersion(version.id, { trigger: graph(child) });
  expect(versionReadiness(flow.id, version.id).ready).toBe(false);
  const auth = step(); auth.settings = { pieceName: 'auth', actionName: 'send', input: {} };
  updateDraftVersion(version.id, { trigger: graph(auth) });
  expect(versionReadiness(flow.id, version.id).issues.some(i => i.code === 'CONNECTION_BINDING')).toBe(true);
  auth.settings.actionName = 'public';
  updateDraftVersion(version.id, { trigger: graph(auth) });
  expect(versionReadiness(flow.id, version.id).ready).toBe(true);
  configureWorkflowReadiness({});
  expect(() => publishFlowVersion(flow.id)).toThrow('catalog is unavailable');
});
test('boot refuses a legacy enabled graph with an invalid schedule', async () => {
  const { flow } = draft(cron('90 * * * *'));
  getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id]);
  const logs: string[] = [];
  const manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: message => logs.push(message) });
  await manager.start();
  try { expect(manager.list()).toHaveLength(0); expect(logs.some(l => l.includes('Invalid cron'))).toBe(true); }
  finally { await manager.stop(); }
});
test('one-shot and tool-loop composition both feed readiness errors back for repair', async () => {
  for (const mode of ['one-shot', 'tools']) {
    let calls = 0;
    const candidate = () => ({ displayName: 'Test', trigger: cron(calls++ === 0 ? '90 * * * *' : '0 9 * * *') });
    const prompts: string[] = [];
    const llm: any = mode === 'one-shot' ? { chat: async ({ prompt }: any) => { prompts.push(prompt); return { text: JSON.stringify(candidate()) }; } }
      : { chat: async () => { throw new Error('unexpected fallback'); }, chatTools: async (messages: any[]) => { prompts.push(JSON.stringify(messages)); return { content: '', tool_calls: [{ id: `call${calls}`, name: 'submit_flow', arguments: candidate() }] }; } };
    const result = await composeFlow({ llm, pieceRegistry: pieces }, { name: 'Test', description: 'Email every morning' });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(prompts[1]).toContain('Invalid cron');
  }
});


test('R2: UI connection IDs are opaque bindings, never expression roots', () => {
  const credentials = new CredentialResolver();
  credentials.register({ id: 'managed', canResolve: id => id === 'jarvis:fake', resolve: async () => null });
  configureWorkflowReadiness({ pieces, credentials });
  for (const externalId of ['my-gmail', '123', 'account:work', 'jarvis:fake']) {
    if (!externalId.startsWith('jarvis:')) upsertConnection({ externalId, pieceName: 'auth', displayName: 'Fake', pieceVersion: '1', type: 'SECRET_TEXT', value: { secret_text: 'synthetic' } });
    for (const binding of [`{{connections.${externalId}}}`, `{{connections['${externalId}']}}`]) {
      const action = step(); action.settings = { pieceName: 'auth', actionName: 'send', input: { auth: binding } };
      const { flow, version } = draft(graph(action));
      expect(versionReadiness(flow.id, version.id).issues).toEqual([]);
      expect(publishFlowVersion(flow.id, version.id).flow.status).toBe('ENABLED');
    }
  }
  expect(compile(graph(step('send', '{{trigger.email + absent.value}}'))).ready).toBe(false);
});

test('R3: preview validates only the selected step with its saved input override', async () => {
  const selected = step('selected', '');
  selected.nextAction = { name: 'unfinished', type: 'PIECE', settings: { pieceName: 'auth', actionName: 'send', input: {} } };
  const trigger = cron('not a schedule'); trigger.nextAction = selected;
  const { flow, version } = draft(trigger);
  setSampleInputEntry(version.id, 'selected', { to: 'preview recipient' });
  const response = await request('/api/workflows/:id/run', 'POST', { id: flow.id }, { stepNameToTest: 'selected', environment: 'TESTING' });
  expect(response.status).toBe(202);
  expect(getFlowVersion(version.id)!.trigger.nextAction!.settings!.input).toEqual({ to: '' });
  for (const body of [{}, { stepNameToTest: 'unfinished' }, { stepNameToTest: 'missing' }]) {
    expect((await request('/api/workflows/:id/run', 'POST', { id: flow.id }, body)).status).toBe(422);
  }
  setSampleInputEntry(version.id, 'selected', { to: 'valid', count: 'invalid number' });
  expect((await request('/api/workflows/:id/run', 'POST', { id: flow.id }, { stepNameToTest: 'selected' })).status).toBe(422);
  setSampleInputEntry(version.id, 'selected', { to: '{{unfinished.value}}' });
  expect((await request('/api/workflows/:id/run', 'POST', { id: flow.id }, { stepNameToTest: 'selected' })).status).toBe(422);
});

test('R3: preview retains lexical scope within a loop and excludes sibling outputs', async () => {
  const loop = { name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.rows}}' }, firstLoopAction: step('inside', '{{loop.item.email}}'), nextAction: step('outside', '{{inside.email}}') };
  const { flow } = draft(graph(loop));
  expect((await request('/api/workflows/:id/run', 'POST', { id: flow.id }, { stepNameToTest: 'inside' })).status).toBe(202);
  expect((await request('/api/workflows/:id/run', 'POST', { id: flow.id }, { stepNameToTest: 'outside' })).status).toBe(422);
});

for (const [sourceType, value] of [['JSON', 'not-json'], ['JSON', 'null'], ['JSON', '123'], ['OBJECT', '[]'], ['ARRAY', 'not an array']]) {
  test(`R4: known invalid ${sourceType} input ${value} cannot publish`, async () => {
    const catalog = new PieceCatalog([{ name: 'structured', displayName: '', description: '', actions: { send: { name: 'send', displayName: '', description: '', inputSchema: { fields: [{ name: 'payload', label: '', type: 'json', sourceType, required: false }] } } } }]);
    configureWorkflowReadiness({ pieces: catalog });
    const action = step(); action.settings = { pieceName: 'structured', actionName: 'send', input: { payload: value } };
    const { flow, version } = draft(graph(action));
    const response = await request('/api/workflows/:id/publish', 'POST', { id: flow.id }, { versionId: version.id });
    expect(response.status).toBe(422);
    expect((await response.json()).issues).toContainEqual(expect.objectContaining({ node: 'send', path: 'settings.input.payload', code: 'INPUT_TYPE' }));
    expect(getFlowVersion(version.id)!.state).toBe('DRAFT');
  });
}


test('R4: valid structured literals and dynamic values keep their supported shapes', () => {
  const fields = propsToInputSchema({
    json: { type: 'JSON', required: false },
    object: { type: 'OBJECT', required: false },
    array: { type: 'ARRAY', required: false },
    rows: { type: 'ARRAY', required: false, properties: { email: { type: 'SHORT_TEXT', required: true } } },
  });
  const catalog = new PieceCatalog([{ name: 'structured', displayName: '', description: '', actions: { send: { name: 'send', displayName: '', description: '', inputSchema: fields } } }]);
  const action = step(); action.settings = { pieceName: 'structured', actionName: 'send', input: {} };
  const inspect = (input: Record<string, unknown>) => { action.settings.input = input; return compileWorkflow(graph(action), { pieces: catalog }); };
  expect(inspect({ json: '{"message":"hello"}', object: { a: 1 }, array: [1], rows: { email: ['a', 'b'] } }).ready).toBe(true);
  expect(inspect({ json: [], object: '{}', array: [], rows: [{ email: 'a' }] }).ready).toBe(true);
  expect(inspect({ array: { email: ['a'] } }).ready).toBe(false);
  const result = inspect({ json: '{{trigger.value}}', object: '{{trigger.record}}', array: '{{trigger.rows}}' });
  expect(result.ready).toBe(true);
  expect(result.runtimeChecks.some(c => c.guard === 'piece-input')).toBe(true);
});


test('R5: required collections accept empty values but still reject missing values', () => {
  const fields = propsToInputSchema({
    rows: { type: 'ARRAY', required: true },
    document: { type: 'JSON', required: true },
  });
  const catalog = new PieceCatalog([{ name: 'collections', displayName: '', description: '', actions: {
    send: { name: 'send', displayName: '', description: '', inputSchema: fields },
  } }]);
  const action = step();
  action.settings = { pieceName: 'collections', actionName: 'send', input: { rows: [], document: [] } };
  expect(compileWorkflow(graph(action), { pieces: catalog }).issues).toEqual([]);
  for (const value of [undefined, null]) {
    action.settings.input = { rows: value, document: value };
    expect(compileWorkflow(graph(action), { pieces: catalog }).ready).toBe(false);
  }
});

test('R6: supplied dynamic schemas validate known values and retain checks for runtime data', () => {
  const catalog = new PieceCatalog([{ name: 'dynamic', displayName: '', description: '', actions: {
    fill: { name: 'fill', displayName: '', description: '', inputSchema: propsToInputSchema({ form: { type: 'DYNAMIC', required: true } }) },
  } }]);
  const schema = { recipient: { type: 'SHORT_TEXT', required: true }, count: { type: 'NUMBER', required: true } };
  const action = step();
  action.settings = { pieceName: 'dynamic', actionName: 'fill', propertySettings: { form: { schema } }, input: { form: {} } };
  const inspect = (form: unknown) => { action.settings.input.form = form; return compileWorkflow(graph(action), { pieces: catalog }); };
  expect(inspect({}).issues).toContainEqual(expect.objectContaining({ node: 'send', path: 'settings.input.form.recipient', code: 'INPUT_TYPE' }));
  expect(inspect({ recipient: 'owner@example.test', count: 'not a number' }).ready).toBe(false);
  expect(inspect({ recipient: 'owner@example.test', count: '2' }).ready).toBe(true);
  const dynamic = inspect('{{trigger.form}}');
  expect(dynamic.ready).toBe(true);
  expect(dynamic.runtimeChecks).toContainEqual(expect.objectContaining({ path: 'settings.input.form', guard: 'piece-input' }));
  action.settings.propertySettings.form.schema = { rows: { type: 'ARRAY', required: true, properties: schema } };
  expect(inspect({ rows: [{ recipient: 'owner@example.test', count: 'wrong' }] }).ready).toBe(false);
  expect(inspect({ rows: [] }).ready).toBe(true);
  expect(inspect({ rows: { recipient: ['owner@example.test'], count: [2] } }).ready).toBe(true);
  const oversizedColumns = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`column${i}`, Array(150).fill(1)]));
  expect(inspect({ rows: oversizedColumns }).issues).toContainEqual(expect.objectContaining({ code: 'LIMIT' }));
});

test('R6: malformed or unresolved supplied schemas cannot certify a dynamic input', () => {
  const catalog = new PieceCatalog([{ name: 'dynamic', displayName: '', description: '', actions: {
    fill: { name: 'fill', displayName: '', description: '', inputSchema: propsToInputSchema({ form: { type: 'DYNAMIC', required: true } }) },
  } }]);
  for (const schema of [null, [], { name: null }, { name: { type: 'invented', required: true } }, { name: { type: 'DYNAMIC', required: true } }]) {
    const action = step();
    action.settings = { pieceName: 'dynamic', actionName: 'fill', propertySettings: { form: { schema } }, input: { form: '{{trigger.form}}' } };
    expect(compileWorkflow(graph(action), { pieces: catalog }).issues).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_CHECK' }));
  }
});


test('router branch outputs join the continuation as runtime checks without leaking into siblings or out of loops', () => {
  const router: any = { name: 'router', type: 'ROUTER', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [{ branchType: 'CONDITION', conditions: [[{ operator: 'EXISTS', firstValue: '{{trigger.email}}' }]] }, { branchType: 'FALLBACK' }] }, children: [step('a'), step('b')], nextAction: step('after', '{{a.out ?? b.out}}') };
  const result = compile(graph(router));
  expect(result.issues).toEqual([]);
  expect(result.runtimeChecks).toContainEqual(expect.objectContaining({ node: 'after', guard: 'expression' }));
  expect(compileWorkflow(graph(router), { pieces, preview: { stepName: 'after' } }).ready).toBe(true);
  router.children[1].settings.input.to = '{{a.out}}';
  expect(compile(graph(router)).issues).toContainEqual(expect.objectContaining({ node: 'b', code: 'REFERENCE_SCOPE' }));
  router.children[1].settings.input.to = '{{trigger.email}}';
  router.children[0] = { name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.rows}}' }, firstLoopAction: step('a') };
  expect(compile(graph(router)).issues).toContainEqual(expect.objectContaining({ node: 'after', code: 'REFERENCE_SCOPE' }));
  router.children[0].nextAction = step('a_after_loop');
  router.nextAction.settings.input.to = '{{a_after_loop.out ?? b.out}}';
  expect(compile(graph(router)).ready).toBe(true);
});


test('enabled-flow audit includes static refusals and runtime checks without changing legacy versions', async () => {
  const invalid = draft(cron('90 * * * *'));
  const dynamic = draft(graph(step('send', '{{trigger.optional ?? "No note"}}')));
  draft(graph(step('disabled', 'literal')));
  for (const { flow } of [invalid, dynamic]) getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id]);
  const before = getFlowVersion(invalid.version.id);
  const response = await request('/api/workflows/readiness', 'GET', {});
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report.items).toHaveLength(2);
  expect(report.items.find((i: any) => i.flowId === invalid.flow.id).readiness.ready).toBe(false);
  expect(report.items.find((i: any) => i.flowId === dynamic.flow.id).readiness.runtimeChecks.length).toBeGreaterThan(0);
  expect(getFlowVersion(invalid.version.id)).toEqual(before);
  const pageReq = new Request('http://local/api/workflows/readiness?limit=1&offset=0');
  const page = await (await createWorkflowRoutes()['/api/workflows/readiness']!.GET!(pageReq)).json();
  expect(page.items).toHaveLength(1);
  expect(page.nextOffset).toBe(1);
});


test('review R3: ordinary array row contracts reject known missing and invalid fields before publication', async () => {
  const properties = { file: { type: 'FILE', required: true }, count: { type: 'NUMBER', required: true }, nested: { type: 'ARRAY', required: false, properties: { label: { type: 'SHORT_TEXT', required: true } } } };
  const catalog = new PieceCatalog([{ name: 'rows', displayName: '', description: '', actions: {
    zip: { name: 'zip', displayName: '', description: '', inputSchema: propsToInputSchema({ files: { type: 'ARRAY', required: true, properties } }) },
  } }]);
  configureWorkflowReadiness({ pieces: catalog });
  for (const files of [[{}], [{ file: 'https://example.test/file', count: 'bad' }], [{ file: 'https://example.test/file', count: 2, nested: [{}] }], { file: ['https://example.test/file'], count: ['bad'] }]) {
    const action = step(); action.settings = { pieceName: 'rows', actionName: 'zip', input: { files } };
    const { flow, version } = draft(graph(action));
    const response = await request('/api/workflows/:id/publish', 'POST', { id: flow.id }, {});
    expect(response.status).toBe(422);
    expect((await response.json()).issues).toContainEqual(expect.objectContaining({ node: 'send', code: 'INPUT_TYPE', path: expect.stringContaining('settings.input.files.0.') }));
    expect(getFlowVersion(version.id)!.state).toBe('DRAFT');
  }
  for (const files of [[], [{ file: 'https://example.test/file', count: '2', nested: [] }], { file: ['https://example.test/file'], count: [2] }, '{{trigger.files}}', [{ file: '{{trigger.file}}', count: '{{trigger.count}}' }]]) {
    const action = step(); action.settings = { pieceName: 'rows', actionName: 'zip', input: { files } };
    const result = compileWorkflow(graph(action), { pieces: catalog });
    expect(result.issues).toEqual([]);
    expect(result.runtimeChecks.some(c => c.guard === 'piece-input')).toBe(true);
  }
});
