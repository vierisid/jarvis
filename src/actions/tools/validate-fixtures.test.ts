/** validate_fixtures is read-only: no installs, connections, credentials, network or saved-draft change. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb } from '../../workflows/db';
import { setEncryptionKey } from '../../workflows/db/encryption';
import * as connections from '../../workflows/db/repos/app-connection';
import { createFlow } from '../../workflows/db/repos/flow';
import { createDraftVersion, getLatestDraft, listVersions } from '../../workflows/db/repos/flow-version';
import { listRuns } from '../../workflows/db/repos/flow-run';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { savedSupportRoutingGraph, savedSupportRoutingSetup, savedSupportRoutingCases, rejectedSupportRoutingCases } from '../../workflows/runtime/support-routing-test-data';
import { PieceCatalog } from '../../workflows/runtime/piece-catalog';
import { createManageWorkflowTool } from './manage-workflow';

const field = (name: string, type: 'string' | 'json' | 'number' = 'string', required = false) => ({ name, label: name, type, required });
const clickup = { name: '@activepieces/piece-clickup', displayName: 'ClickUp', description: '', auth: { type: 'OAUTH2' as const }, actions: {
  create_task: { name: 'create_task', displayName: 'Create task', description: '', inputSchema: { fields: [
    field('workspace_id', 'string', true), field('space_id', 'string', true), field('list_id', 'string', true), field('name', 'string', true),
    field('description'), field('priority_id', 'number'), field('custom_fields', 'json'),
  ] } },
} };

// Slack is a Library connector that is not installed, so a call that could install would plan it.
const library = [{ id: 'slack', npmPackage: '@activepieces/piece-slack', displayName: 'Slack', description: 'Fixture' }];
let pieces: PieceCatalog, installed: string[], fetches: unknown[], restore: Array<{ mockRestore(): void }>;
beforeEach(() => {
  initWorkflowDb(':memory:'); setEncryptionKey(Buffer.alloc(32, 0x52)); pieces = new PieceCatalog([clickup]); configureWorkflowReadiness({ pieces });
  installed = []; fetches = []; restore = [];
  restore.push(spyOn(globalThis, 'fetch').mockImplementation((async (...args: unknown[]) => { fetches.push(args); throw Error('network refused in test'); }) as unknown as typeof fetch));
});
afterEach(() => { for (const r of restore) r.mockRestore(); closeWorkflowDb(); setEncryptionKey(null); });

function tool() {
  return createManageWorkflowTool({ pieceRegistry: pieces, library, installLibraryPiece: async id => { installed.push(id); } });
}
const unwrap = (raw: unknown) => JSON.parse(String(raw).split('\n').slice(2, -1).join('\n'));

function savedDraft(auth?: string) {
  const trigger = savedSupportRoutingGraph();
  if (auth !== undefined) for (const n of trigger.nextAction.children) n.settings.input.auth = auth;
  const flow = createFlow();
  const draft = createDraftVersion({ flowId: flow.id, displayName: 'Support routing', trigger });
  return { flow, draft };
}

for (const auth of [undefined, '{{connections.real-clickup}}']) {
  test(`fixtures on an unconnected draft raise no install card and reach no connection or network (auth ${auth ?? 'omitted'})`, async () => {
    // A real connection exists; the fixture must never read or resolve it.
    connections.upsertConnection({ externalId: 'real-clickup', displayName: 'Real', type: 'OAUTH2',
      pieceName: '@activepieces/piece-clickup', pieceVersion: '0.9.1', value: { access_token: 'must-not-be-read' } });
    const reads = Object.entries(connections).filter(([, v]) => typeof v === 'function').map(([k]) => spyOn(connections, k as 'getConnection'));
    restore.push(...reads);
    const { flow, draft } = savedDraft(auth);
    const before = structuredClone(getLatestDraft(flow.id)!.trigger);
    const t = tool();
    // Even a model-supplied install list cannot make a fixture call install.
    const params = { action: 'validate_fixtures', flow: flow.id, install: 'slack',
      fixture_input: { setup: savedSupportRoutingSetup(), cases: [...savedSupportRoutingCases(), ...rejectedSupportRoutingCases()] } };
    expect(t.authorityGate?.(params)).toBeNull();
    expect(t.freezeArguments?.(params)).toEqual(params);
    let page = unwrap(await t.execute(params)), content = '';
    for (;;) { content += page.content; if (!page.nextCursor) break; page = unwrap(await t.execute({ ...params, cursor: page.nextCursor })); }
    const report = JSON.parse(content);
    expect(report.passed).toBe(true);
    expect(report.externalActions).toBe(0);
    expect(installed).toEqual([]);
    expect(fetches).toEqual([]);
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
    // Setup was substituted in memory only: the saved draft and its versions are unchanged.
    const after = getLatestDraft(flow.id)!;
    expect(after.id).toBe(draft.id);
    expect(after.trigger).toEqual(before);
    expect((after.trigger as any).nextAction.children[0].settings.input.list_id).toBeNull();
    expect(listVersions(flow.id)).toHaveLength(1);
    expect(listRuns({ flowId: flow.id })).toHaveLength(0);
  });
}

test('fixture setup cannot overwrite configured inputs, and a changed fixture invalidates the cursor', async () => {
  const { flow } = savedDraft();
  const t = tool();
  await expect(t.execute({ action: 'validate_fixtures', flow: flow.id,
    fixture_input: { setup: { step_2: { priority_id: 1 } }, cases: savedSupportRoutingCases() } })).rejects.toThrow('only empty');
  const params = { action: 'validate_fixtures', flow: flow.id, fixture_input: { setup: savedSupportRoutingSetup(), cases: [...savedSupportRoutingCases(), ...rejectedSupportRoutingCases()] } };
  const first = unwrap(await t.execute(params));
  expect(first.nextCursor).toBeString();
  await expect(t.execute({ ...params, cursor: first.nextCursor, fixture_input: { ...params.fixture_input, cases: params.fixture_input.cases.slice(0, 1) } })).rejects.toThrow('changed');
  await expect(t.execute({ ...params, cursor: 'invalid' })).rejects.toThrow('cursor');
});
