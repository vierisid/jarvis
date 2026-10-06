import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BriefCompositionProvider } from './composition';
import { ensureCompositionJobSchema } from './composition-schema';
import { BriefCapabilities } from './capabilities';
import { createCompositionRoutes } from './composition-routes';
import { registerWorkflowComposition } from './registrations/workflow-composition';
import { registerCompositionIngredients } from './registrations/composition-ingredients';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../workflows/db/index';
import { CompositionIngredients } from '../workflows/db/repos/composition-ingredients';
import { configureWorkflowReadiness, versionReadiness } from '../workflows/db/repos/flow-readiness';
import { getFlow, updateFlowStatus, setPublishedVersion, updateFlowMetadata } from '../workflows/db/repos/flow';
import { updateDraftVersion, type FlowTriggerNode } from '../workflows/db/repos/flow-version';
import { getWorkflowComposition } from '../workflows/db/repos/workflow-composition';
import { PieceCatalog, type PieceCatalogEntry } from '../workflows/runtime/piece-catalog';
import { actionContractVersion, parseCompositionIngredients, type CompositionIngredient } from '../workflows/runtime/composition-ingredients';
import type { ComposerLlmClient } from '../actions/tools/workflow-composer';

const pieceName = '@fixture/piece-account';
const secret = 'CREDENTIAL_SECRET_MUST_NEVER_BE_READ';
let piece: PieceCatalogEntry, catalog: PieceCatalog, providers: BriefCompositionProvider[];
beforeEach(() => {
  initWorkflowDb(':memory:'); providers = [];
  piece = { name: pieceName, version: '1.2.3', displayName: 'Account', description: 'Fixture', auth: { type: 'SECRET_TEXT' },
    actions: { send: { name: 'send', displayName: 'Send', description: 'Send a message', requireAuth: true,
      inputSchema: { fields: [{ name: 'text', label: 'Text', type: 'string', required: true }] } },
    other: { name: 'other', displayName: 'Other', description: 'Another action', requireAuth: false } } };
  catalog = new PieceCatalog([piece]); configureWorkflowReadiness({ pieces: catalog });
  connection(pieceName); // Intentionally the SAME id as the library entry.
});
afterEach(async () => { for (const p of providers) p.stop(); await Promise.all(providers.map(p => p.idle())); closeWorkflowDb(); });
function connection(id: string, externalId = 'selected-account', project = DEFAULT_IDS.project as string, owner: string | null = null, targetPiece = pieceName) {
  getWorkflowDb().run(`INSERT INTO app_connection(id, external_id, display_name, type, scope, status, piece_name, piece_version, project_id, owner_id, value, metadata, created, updated)
    VALUES (?, ?, ?, 'SECRET_TEXT', 'PROJECT', 'ACTIVE', ?, '0.0.0', ?, ?, ?, ?, 1, 1)`, [id, externalId, secret, targetPiece, project, owner, secret, JSON.stringify({ private: secret })]);
}
function selections(): CompositionIngredient[] { return [
  { kind: 'connection', id: pieceName, pieceName, pieceVersion: '1.2.3', required: true },
  { kind: 'library-action', id: pieceName, actionName: 'send', pieceVersion: '1.2.3', actionVersion: actionContractVersion(piece, 'send'), required: true },
]; }
function graph(action = 'send', externalId = 'selected-account') {
  return { displayName: 'Selected account', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
    name: 'send', type: 'PIECE', settings: { pieceName, actionName: action, input: { text: 'Hello', auth: `{{connections.${externalId}}}` } },
  } } };
}
function provider(llm: ComposerLlmClient = { async chat() { return { text: JSON.stringify(graph()) }; } }) {
  const p = new BriefCompositionProvider(getWorkflowDb()); providers.push(p);
  p.configure(() => ({ llm, pieceRegistry: catalog, maxAttempts: 2 })); return p;
}
async function submit(p: BriefCompositionProvider, ingredients = selections(), requestId = 'selection') {
  const { job } = p.submit({ requestId, prompt: 'Use the chosen ingredients.', ingredients });
  await p.idle(); return p.get(job.jobId);
}

test('typed identities survive repairs in the prompt, receipt and journal without credentials or labels', async () => {
  let calls = 0;
  const expected = selections();
  const p = provider({ async chat({ prompt, system }) {
    const all = `${prompt}${system}`; expect(all).not.toContain(secret);
    const context = JSON.parse(prompt.split('Composition context (JSON):\n')[1]!);
    expect(context.jobSpecification.ingredients).toMatchObject(expected);
    return { text: JSON.stringify(++calls === 1 ? graph('other') : graph()) };
  } });
  const job = await submit(p);
  expect(calls).toBe(2); expect(job.state).toBe('draft_ready');
  expect(job.specification.ingredients).toEqual(expected);
  expect(getWorkflowComposition(job.compositionId!)!.specification.ingredients).toMatchObject(expected);
  expect(JSON.stringify(job)).not.toContain(secret);
  expect(getFlow(job.workflow!.flowId)!.status).toBe('DISABLED');
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
  expect(versionReadiness(job.workflow!.flowId, job.workflow!.versionId).ready).toBe(true);
});

for (const toolMode of ['inline', 'submit_flow'] as const) test(`tool ${toolMode} candidates cannot omit a required selection`, async () => {
  let calls = 0;
  const p = provider({ async chat({ prompt }) {
    expect(toolMode).toBe('inline'); calls++; expect(prompt).toContain('Selected ingredient');
    expect(prompt).toContain('actionVersion'); expect(prompt).not.toContain(secret); return { text: JSON.stringify(graph()) };
  }, async chatTools(messages) {
    expect(JSON.stringify(messages)).toContain('actionVersion'); expect(JSON.stringify(messages)).not.toContain(secret);
    if (++calls > 1) expect(JSON.stringify(messages)).toContain('Selected ingredient');
    const candidate = graph(calls === 1 ? 'other' : 'send');
    return toolMode === 'inline' ? { content: JSON.stringify(candidate), tool_calls: [] }
      : { content: '', tool_calls: [{ id: String(calls), name: 'submit_flow', arguments: candidate }] };
  } });
  expect((await submit(p)).state).toBe('draft_ready'); expect(calls).toBe(2);
});

test('same piece with another account is a blocker, never a silent substitution', async () => {
  connection('other-id', 'other-account');
  const job = await submit(provider({ async chat() { return { text: JSON.stringify(graph('send', 'other-account')) }; } }));
  expect(job.state).toBe('blocked'); expect(job.blocker!.details.join(' ')).toContain('Selected ingredient');
  expect(job.workflow).toBeNull(); expect(getWorkflowDb().query('SELECT id FROM flow').all()).toHaveLength(0);
});

for (const change of ['missing-id', 'foreign-project', 'foreign-owner', 'inactive', 'piece-mismatch', 'auth-mismatch', 'ambiguous', 'unsafe-binding', 'package-version', 'action-version', 'unknown-action', 'missing-auth'] as const) {
  test(`invalid selection blocks before provider calls: ${change}`, async () => {
    const input = selections();
    switch (change) {
      case 'missing-id': input[0]!.id = 'not-found'; break;
      case 'foreign-project': getWorkflowDb().run('UPDATE app_connection SET project_id = ?', ['foreign']); break;
      case 'foreign-owner': getWorkflowDb().run('UPDATE app_connection SET owner_id = ?', ['foreign']); break;
      case 'inactive': getWorkflowDb().run("UPDATE app_connection SET status = 'ERROR'"); break;
      case 'piece-mismatch': getWorkflowDb().run("UPDATE app_connection SET piece_name = 'other'"); break;
      case 'auth-mismatch': getWorkflowDb().run("UPDATE app_connection SET type = 'BASIC_AUTH'"); break;
      case 'ambiguous': connection('duplicate', 'selected-account', DEFAULT_IDS.project, null, 'other-piece'); break;
      case 'unsafe-binding': getWorkflowDb().run("UPDATE app_connection SET external_id = 'jarvis:managed'"); break;
      case 'package-version': piece.version = '2.0.0'; break;
      case 'action-version': piece.actions.send!.description = 'New contract'; break;
      case 'unknown-action': (input[1] as Extract<CompositionIngredient, { kind: 'library-action' }>).actionName = 'unknown'; break;
      case 'missing-auth': input.shift(); break;
    }
    let calls = 0; const job = await submit(provider({ async chat() { calls++; return { text: '{}' }; } }), input);
    expect(calls).toBe(0); expect(job).toMatchObject({ state: 'blocked', workflow: null, blocker: { code: 'ingredient_unavailable' } });
    expect(job.specification.ingredients).toEqual(input); expect(JSON.stringify(job)).not.toContain(secret);
  });
}

for (const change of ['revoke', 'remove', 'retarget', 'replace', 'piece-version', 'action-version'] as const) {
  const mutate = () => {
    if (change === 'revoke') getWorkflowDb().run("UPDATE app_connection SET status = 'MISSING'");
    if (change === 'remove') getWorkflowDb().run('DELETE FROM app_connection');
    if (change === 'retarget') getWorkflowDb().run("UPDATE app_connection SET external_id = 'changed-account'");
    if (change === 'replace') { getWorkflowDb().run('DELETE FROM app_connection'); connection('new-id'); }
    if (change === 'piece-version') piece.version = '9.0.0';
    if (change === 'action-version') piece.actions.send!.requireAuth = false;
  };
  test(`selection change during the model call prevents draft attachment: ${change}`, async () => {
    const job = await submit(provider({ async chat() { mutate(); return { text: JSON.stringify(graph()) }; } }));
    expect(job).toMatchObject({ state: 'blocked', workflow: null, blocker: { code: 'ingredient_unavailable' } });
    expect(getWorkflowDb().query('SELECT id FROM flow').all()).toHaveLength(0);
  });
  test(`saved pins refuse readiness, enable and publish after ${change}`, async () => {
    const p = provider(), job = await submit(p); expect(job.state).toBe('draft_ready'); p.stop();
    mutate();
    const { flowId, versionId } = job.workflow!;
    expect(versionReadiness(flowId, versionId).issues.some(i => i.code === 'INGREDIENT')).toBe(true);
    expect(() => updateFlowStatus(flowId, 'ENABLED')).toThrow();
    expect(() => setPublishedVersion(flowId, versionId)).toThrow();
    expect(getFlow(flowId)!.status).toBe('DISABLED');
  });
}

test('graph/metadata edits cannot drop saved requirements, including on a live draft', async () => {
  const job = await submit(provider()), { flowId, versionId } = job.workflow!;
  updateFlowMetadata(flowId, null);
  updateFlowStatus(flowId, 'ENABLED');
  expect(() => updateDraftVersion(versionId, { trigger: graph('other').trigger })).toThrow();
  updateFlowStatus(flowId, 'DISABLED'); updateDraftVersion(versionId, { trigger: graph('other').trigger });
  expect(versionReadiness(flowId, versionId).ready).toBe(false);
  expect(() => updateFlowStatus(flowId, 'ENABLED')).toThrow();
});

test('idempotency retains selections across provider restart and rejects a changed pin or requirement', async () => {
  let calls = 0; const p = provider({ async chat() { calls++; return { text: JSON.stringify(graph()) }; } });
  const input = { requestId: 'stable', prompt: 'Keep this wording', ingredients: selections() };
  const accepted = p.submit(input); input.ingredients[0]!.id = 'caller-mutation'; await p.idle();
  const job = p.get(accepted.job.jobId); expect(job.state).toBe('draft_ready'); p.stop();
  const restarted = provider();
  expect(restarted.submit({ ...input, ingredients: selections() })).toEqual({ created: false, job });
  for (const modified of ['required', 'pieceVersion'] as const) {
    const ingredients = selections(); if (modified === 'required') ingredients[0]!.required = false; else ingredients[0]!.pieceVersion = '2.0.0';
    expect(() => restarted.submit({ ...input, ingredients })).toThrow('different specification');
  }
  expect(calls).toBe(1);
});

test('saved selections and readiness pins survive closing and reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f08-')), path = join(directory, 'test.db');
  try {
    closeWorkflowDb(); initWorkflowDb(path); configureWorkflowReadiness({ pieces: catalog }); connection(pieceName);
    const p = provider(), job = await submit(p); expect(job.state).toBe('draft_ready');
    p.stop(); closeWorkflowDb(); initWorkflowDb(path); configureWorkflowReadiness({ pieces: catalog });
    const restarted = provider();
    expect(restarted.submit({ requestId: 'selection', prompt: 'Use the chosen ingredients.', ingredients: selections() })).toEqual({ created: false, job });
    expect(versionReadiness(job.workflow!.flowId, job.workflow!.versionId).ready).toBe(true);
    getWorkflowDb().run('DELETE FROM app_connection'); connection('replacement');
    expect(() => updateFlowStatus(job.workflow!.flowId, 'ENABLED')).toThrow('Selected ingredient');
    restarted.stop();
  } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
});

test('F07 schema upgrade preserves old rows and allows old inserts without the new column', () => {
  // The old schema deliberately has no ingredients field.
  getWorkflowDb().run(`CREATE TABLE brief_workflow_composition_jobs (
    id TEXT PRIMARY KEY, project_id TEXT, request_id TEXT, name TEXT, prompt TEXT,
    state TEXT, checked_candidates INTEGER DEFAULT 0, composition_id TEXT, flow_id TEXT,
    version_id TEXT, blocker TEXT, created_at INTEGER, updated_at INTEGER)`);
  getWorkflowDb().run("INSERT INTO brief_workflow_composition_jobs(id, prompt, state) VALUES ('old', 'Keep original', 'queued')");
  ensureCompositionJobSchema(getWorkflowDb()); ensureCompositionJobSchema(getWorkflowDb());
  getWorkflowDb().run("INSERT INTO brief_workflow_composition_jobs(id, prompt, state) VALUES ('old-writer', 'Still works', 'queued')");
  expect(getWorkflowDb().query('SELECT id, ingredients, prompt FROM brief_workflow_composition_jobs ORDER BY id').all())
    .toEqual([{ id: 'old', ingredients: '[]', prompt: 'Keep original' }, { id: 'old-writer', ingredients: '[]', prompt: 'Still works' }]);
});

test('explicit inability to use selected ingredients keeps its explanation and creates no draft', async () => {
  const p = provider({ async chat() { throw new Error('unexpected'); }, async chatTools() {
    return { content: '', tool_calls: [{ id: 'blocked', name: 'report_blocked', arguments: { reason: 'The selected account cannot send to the requested destination.' } }] };
  } });
  const job = await submit(p);
  expect(job).toMatchObject({ state: 'blocked', workflow: null, blocker: { details: ['The selected account cannot send to the requested destination.'] } });
  expect(job.specification.ingredients).toEqual(selections());
});

test('a conflicting graph pin and a decorative auth field cannot satisfy required selections', async () => {
  const wrongVersion = graph(); Object.assign(wrongVersion.trigger.nextAction.settings, { pieceVersion: '9.9.9' });
  const job = await submit(provider({ async chat() { return { text: JSON.stringify(wrongVersion) }; } }));
  expect(job.state).toBe('blocked'); expect(job.blocker!.details.join(' ')).toContain('conflicting piece version');
  const decoration = await submit(provider({ async chat() { return { text: JSON.stringify(graph('other')) }; } }), [selections()[0]!], 'decorative');
  expect(decoration.state).toBe('blocked');
});

test('long multiple selections all survive repair without truncation', async () => {
  const ingredients = selections(), candidate = graph(), nodes: FlowTriggerNode[] = [candidate.trigger.nextAction];
  for (let i = 0; i < 20; i++) {
    const id = `connection-${i}-${'x'.repeat(180)}`, externalId = `account-${i}`; connection(id, externalId);
    ingredients.push({ kind: 'connection', id, pieceName, pieceVersion: '1.2.3', required: true });
    const node = { ...graph('send', externalId).trigger.nextAction, name: `send_${i}` };
    nodes[nodes.length - 1]!.nextAction = node; nodes.push(node);
  }
  let calls = 0;
  const job = await submit(provider({ async chat({ prompt }) {
    for (const selection of ingredients) expect(prompt).toContain(selection.id);
    return { text: ++calls === 1 ? JSON.stringify(graph()) : JSON.stringify(candidate) };
  } }), ingredients);
  expect(job.state).toBe('draft_ready'); expect(job.specification.ingredients).toHaveLength(22); expect(calls).toBe(2);
});

test('nested actions satisfy requirements; action-free fallback cannot', async () => {
  const candidate = graph();
  const trigger: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', nextAction: { name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{[1]}}' }, firstLoopAction: candidate.trigger.nextAction } };
  expect((await submit(provider({ async chat() { return { text: JSON.stringify({ ...candidate, trigger }) }; } }))).state).toBe('draft_ready');
});

test('optional selections can be unused, but are still validated and never substitute auth', async () => {
  const input = selections(); input[0]!.required = false; input[1]!.required = false;
  const job = await submit(provider({ async chat() { return { text: JSON.stringify(graph('other')) }; } }), input);
  expect(job.state).toBe('draft_ready');
  input[0]!.required = false;
  const wrong = await submit(provider({ async chat() { return { text: JSON.stringify(graph('send', 'other-account')) }; } }), input, 'wrong-auth');
  expect(wrong.state).toBe('blocked');
});

test('safe discovery uses typed choices, bounded pagination and no encrypted data', () => {
  const adapter = new CompositionIngredients(getWorkflowDb(), catalog);
  connection('foreign', 'foreign-account', 'foreign'); connection('foreign-owner', 'foreign-owner-account', DEFAULT_IDS.project, 'foreign');
  const result = adapter.list(); expect(result.ingredients).toHaveLength(3);
  expect(result.ingredients.map(i => i.selection.kind)).toContain('connection');
  expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain('foreign');
  for (let i = 0; i < 101; i++) piece.actions[`action_${i}`] = { name: `action_${i}`, displayName: `Action ${i}`, description: '' };
  expect(adapter.list().ingredients).toHaveLength(100); expect(adapter.list().nextOffset).toBe(100);
  expect(adapter.list(100).ingredients).toHaveLength(4); expect(adapter.list(100).nextOffset).toBeNull();
  expect(adapter.list(0, 'Action 99').ingredients).toHaveLength(1);
});

test('strict wire selections reject unknown fields, secrets, malformed versions and excess count', () => {
  for (const value of [null, {}, [null], [{ ...selections()[0], value: secret }], [{ ...selections()[0], externalId: 'forged' }],
    [{ ...selections()[0], kind: 'library' }], [{ ...selections()[0], required: 'yes' }], [{ ...selections()[0], id: 'x'.repeat(257) }],
    [{ ...selections()[1], actionVersion: 'unversioned' }], [selections()[0], selections()[0]], Array(65).fill(selections()[0])]) {
    expect(() => parseCompositionIngredients(value)).toThrow();
  }
  expect(parseCompositionIngredients(selections())).toEqual(selections());
});

test('ingredient API is default-off, provider-bound and dependent on workflow composition', async () => {
  const p = provider(), registrations = [...registerWorkflowComposition(p), ...registerCompositionIngredients(p)];
  const getPath = '/api/brief/composition-ingredients', postPath = '/api/brief/workflow-compositions';
  for (const [caps, expected] of [
    [new BriefCapabilities(registerWorkflowComposition(p), ['workflowComposition']), 501],
    [new BriefCapabilities(registrations, ['workflowComposition']), 503],
    [new BriefCapabilities(registrations, ['compositionIngredients']), 503],
    [new BriefCapabilities([...registerWorkflowComposition(p), ...registerCompositionIngredients(provider())], ['workflowComposition', 'compositionIngredients']), 501],
  ] as const) {
    const routes = createCompositionRoutes(caps, (body, status) => Response.json(body, { status }), p);
    expect((await routes[getPath].GET(new Request(`http://localhost${getPath}`))).status).toBe(expected);
    expect((await routes[postPath].POST(new Request(`http://localhost${postPath}`, { method: 'POST', body: JSON.stringify({ requestId: 'gated', prompt: 'Create', ingredients: selections() }) }))).status).toBe(expected);
  }
  const routes = createCompositionRoutes(new BriefCapabilities(registrations, ['workflowComposition', 'compositionIngredients']), (body, status) => Response.json(body, { status }), p);
  expect((await routes[getPath].GET(new Request(`http://localhost${getPath}?offset=-1`))).status).toBe(400);
  const response = await routes[getPath].GET(new Request(`http://localhost${getPath}`)); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(JSON.stringify(await response.json())).not.toContain(secret); expect(p.list()).toEqual([]);
});
