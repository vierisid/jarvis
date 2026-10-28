import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../../workflows/db';
import { getWorkflowComposition } from '../../workflows/db/repos/workflow-composition';
import { assertVersionReady, versionReadiness, configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { updateDraftVersion, getFlowVersion } from '../../workflows/db/repos/flow-version';
import { setEncryptionKey } from '../../workflows/db/encryption';
import { upsertConnection } from '../../workflows/db/repos/app-connection';
import { compileWorkflow } from '../../workflows/runtime/workflow-readiness';
import { PieceCatalog } from '../../workflows/runtime/piece-catalog';
import { createManageWorkflowTool } from './manage-workflow';
import type { ComposerLlmClient } from './workflow-composer';
const name = '@activepieces/piece-google-sheets';
const entry = { id: 'google-sheets', npmPackage: name, displayName: 'Google Sheets', description: 'Fixture' };
const piece = { name, displayName: 'Sheets fixture', description: '', auth: { type: 'OAUTH2' as const }, actions: {
  sheets_append_values: { name: 'sheets_append_values', displayName: 'Append', description: '', inputSchema: { fields: [
    { name: 'spreadsheet_id', label: 'Spreadsheet', type: 'string' as const, required: true },
    { name: 'values', label: 'Values', type: 'json' as const, required: true },
  ] } },
} };
const graph = { displayName: 'Submission processor', trigger: { name: 'trigger', type: 'PIECE_TRIGGER', settings: {
  pieceName: 'webhook', input: { submission_id_field: 'id', submission_email_field: 'email' },
}, nextAction: { name: 'append', type: 'PIECE', settings: { pieceName: name, actionName: 'sheets_append_values', input: {
  spreadsheet_id: 'fixture-only', values: [['{{trigger.id}}', '{{trigger.email}}']],
} } } } };
const question = 'Please share a redacted sample submission and identify the ID and email fields.';
const blocked = (suggest = false) => ({ id: 'setup', name: 'report_blocked', arguments: { reason: 'Missing setup',
  configurationQuestions: [question, 'Which spreadsheet, worksheet and columns should receive the submissions?'],
  ...(suggest ? { suggestedPieces: [{ id: 'google-sheets', reason: 'Required destination' }] } : {}),
} });
beforeEach(() => { initWorkflowDb(':memory:'); setEncryptionKey(Buffer.alloc(32, 0x71)); });
afterEach(() => { closeWorkflowDb(); setEncryptionKey(null); });
async function call(tool: ReturnType<typeof createManageWorkflowTool>, params: Record<string, unknown>) {
  const raw = await tool.execute(params) as string;
  return JSON.parse(raw.split('\n').slice(2, -1).join('\n'));
}
function setup(installError = false) {
  const registry = new PieceCatalog([]), installed: string[] = [];
  configureWorkflowReadiness({ pieces: registry });
  let turns = 0, complete = false;
  const prompts: string[] = [];
  const llm: ComposerLlmClient = { chat: async () => { throw Error('Use discovery'); }, chatTools: async request => {
    turns++; prompts.push(JSON.stringify(request));
    return { content: '', tool_calls: [complete ? { id: 'saved', name: 'submit_flow', arguments: graph } : blocked(!registry.get(name))] };
  } };
  const tool = createManageWorkflowTool({ pieceRegistry: registry, llm, library: [entry], installLibraryPiece: async id => {
    installed.push(id); if (installError) throw Error('Fixture install unavailable'); registry.upsert(piece);
  } });
  return { tool, registry, installed, prompts, complete: () => { complete = true; }, turns: () => turns };
}

test('ordinary compose installs the missing connector before guiding the first setup question', async () => {
  const f = setup();
  expect(f.tool.authorityGate?.({ action: 'compose', name: 'Submission processor' })).toMatchObject({ actionCategory: 'install_software' });
  const result = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Original job: trim and validate form submissions, append once, never activate.' });
  expect(f.installed).toEqual(['google-sheets']);
  expect(f.turns()).toBe(3);
  expect(f.prompts[1]).toContain('sheets_append_values');
  expect(result.setup).toMatchObject({ status: 'needs_input', nextQuestion: question,
    continueWith: { action: 'continue_setup', composition_id: result.compositionRecordId, install_missing: false } });
  expect(result.suggestedInstalls).toBeUndefined();
});

test('setup continuation preserves the original request and answers, then saves only one disabled draft', async () => {
  const f = setup();
  const description = 'Trim, validate, append once. No real actions or activation.';
  const initial = await call(f.tool, { action: 'compose', name: 'Submission processor', description });
  const answers = { sample: { id: 'fixture-1', email: ' A@EXAMPLE.COM ' }, idField: 'id', emailField: 'email' };
  const waiting = await call(f.tool, { action: 'continue_setup', composition_id: initial.compositionRecordId, answers });
  expect(f.installed).toEqual(['google-sheets']);
  const record = getWorkflowComposition(waiting.compositionRecordId)!;
  expect(record.specification.description).toBe(description);
  expect(record.specification.context?.workflowSetup).toMatchObject({ rootCompositionId: initial.compositionRecordId, answers });
  f.complete();
  const saved = await call(f.tool, { action: 'continue_setup', composition_id: initial.compositionRecordId, answers: { spreadsheet: 'fixture-only' } });
  expect(saved.ok).toBe(true); expect(saved.flow.status).toBe('DISABLED');
  expect(saved.readiness.ready).toBe(false);
  expect(saved.setup.status).toBe('needs_configuration');
  expect(saved.setup.accountSetup).toContain('Connected workspace');
  expect(f.prompts.at(-1)).toContain('fixture-1');
  const repeated = await call(f.tool, { action: 'continue_setup', composition_id: initial.compositionRecordId });
  expect(repeated.flow.id).toBe(saved.flow.id);
  expect(f.tool.authorityGate?.(saved.setup.continueWith)).toBeNull();
  expect(f.tool.authorityGate?.({action:'continue_setup',composition_id:initial.compositionRecordId,answers:{draft_repair:'fixture auth omitted'}})).toBeNull();
  expect(saved.setup.continueWith.install_missing).toBe(false);
  expect(f.installed).toEqual(['google-sheets']);
  expect(await call(f.tool, { action: 'list_runs', flow: saved.flow.id })).toEqual([]);
  expect((await call(f.tool, { action: 'list' })).flows).toHaveLength(1);
  expect(getWorkflowComposition(initial.compositionRecordId)?.specification.description).toBe(description);
});

test('explicit no-install stays disabled and is retained across setup continuation', async () => {
  const f = setup();
  expect(f.tool.authorityGate?.({ action: 'compose', install_missing: false })).toBeNull();
  const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'No installs', install_missing: false });
  await call(f.tool, { action: 'continue_setup', composition_id: first.compositionRecordId, answers: { idField: 'id' } });
  expect(f.installed).toEqual([]);
});

test('continuation cannot install by default or inherit install authority from prior composition', async () => {
  const f = setup();
  const first = await call(f.tool,{action:'compose',name:'Submission processor',description:'Save a disabled draft',install_missing:false});
  for(const option of [undefined,false,'true',1]) {
    const params={action:'continue_setup',composition_id:first.compositionRecordId,...(option===undefined?{}:{install_missing:option})};
    expect(f.tool.authorityGate?.(params)).toBeNull();
    await call(f.tool,params);
    expect(f.installed).toEqual([]);
  }
  const permitted={action:'continue_setup',composition_id:first.compositionRecordId,install_missing:true};
  expect(f.tool.authorityGate?.(permitted)).toMatchObject({actionCategory:'install_software',confirm:'above_level'});
  await call(f.tool,permitted);
  expect(f.installed).toEqual(['google-sheets']);
});

test('failed installation is attempted once and reported as the concrete blocker', async () => {
  const f = setup(true);
  const result = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Build disabled draft' });
  expect(f.installed).toEqual(['google-sheets']);
  expect(result.ok).toBe(false);
  expect(f.prompts[1]).toContain('Fixture install unavailable');
  expect(result.capabilityGaps.join(' ')).toContain('Fixture install unavailable');
});

test('continuation cannot access another project or run a completed draft', async () => {
  const f = setup();
  const initial = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Disabled draft' });
  const other = createManageWorkflowTool({ callerProjectId: () => DEFAULT_IDS.project + '-other' });
  await expect(other.execute({ action: 'continue_setup', composition_id: initial.compositionRecordId })).rejects.toThrow('not found');
});


test('concurrent setup continuation does not start a second model attempt', async () => {
  const registry = new PieceCatalog([]);
  let hold = false, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const tool = createManageWorkflowTool({ pieceRegistry: registry, llm: {
    chat: async () => { throw Error('Use tools'); }, chatTools: async () => {
      if (hold) { entered(); await waiting; }
      return { content: '', tool_calls: [blocked()] };
    },
  } });
  const initial = await call(tool, { action: 'compose', name: 'Submission processor', description: 'Preserve this job' });
  hold = true;
  const continuing = call(tool, { action: 'continue_setup', composition_id: initial.compositionRecordId, answers: { idField: 'id' } });
  await started;
  try { await expect(tool.execute({ action: 'continue_setup', composition_id: initial.compositionRecordId })).rejects.toThrow('already being prepared'); }
  finally { release(); await continuing; }
});


test('setup answers and the original request survive database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-setup-'));
  const database = join(directory, 'fixture.db');
  closeWorkflowDb(); initWorkflowDb(database);
  try {
    const f = setup();
    const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Keep the original disabled form processor request' });
    await call(f.tool, { action: 'continue_setup', composition_id: first.compositionRecordId, answers: { sample: { id: 'fixture-after-restart' } } });
    closeWorkflowDb(); initWorkflowDb(database); configureWorkflowReadiness({ pieces: f.registry });
    f.complete();
    const saved = await call(f.tool, { action: 'continue_setup', composition_id: first.compositionRecordId, answers: { spreadsheet: 'fixture-only' } });
    expect(saved.flow.status).toBe('DISABLED');
    expect(f.prompts.at(-1)).toContain('fixture-after-restart');
    expect(getWorkflowComposition(saved.compositionRecordId)?.specification.description).toBe('Keep the original disabled form processor request');
  } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
});


test('unconfigured processor saves disabled and becomes ready only after setup', async () => {
  const registry = new PieceCatalog([piece]);
  configureWorkflowReadiness({ pieces: registry });
  const pending = structuredClone(graph);
  pending.trigger.settings.input = { submission_id_field: '', submission_email_field: '' };
  pending.trigger.nextAction.settings.input = { spreadsheet_id: '', values: null as any };
  const tool = createManageWorkflowTool({ pieceRegistry: registry, llm: {
    chat: async () => ({ text: JSON.stringify(pending) }),
  } });
  const saved = await call(tool, { action: 'compose', name: 'Submission processor', description: 'Save disabled with setup required; normalize webhook submissions and append once to Sheets. Payload and destination are unknown.' });
  expect(saved.ok).toBe(true);
  expect(saved.flow.status).toBe('DISABLED');
  expect(saved.validation).toMatchObject({ structureValid: true, readyToRun: false, functionalTesting: 'not_performed' });
  expect(saved.setup.status).toBe('needs_configuration');
  let report = '', cursor: string | undefined;
  do {
    const page = await call(tool, { action: 'get', flow: saved.flow.id, version_id: saved.versionId, view: 'validation', ...(cursor ? { cursor } : {}) });
    report += page.content; cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(JSON.parse(report).readiness.issues.map((f: any) => f.path)).toEqual(expect.arrayContaining([
    'settings.input.submission_id_field', 'settings.input.submission_email_field',
    'settings.input.spreadsheet_id', 'settings.input.values', 'settings.input.auth',
  ]));
  const stored = getFlowVersion(saved.versionId)!;
  expect(stored.trigger.nextAction?.settings?.actionName).toBe('sheets_append_values');
  expect(stored.valid).toBe(false);
  for (const action of ['run', 'enable', 'publish']) {
    await expect(tool.execute({ action, flow: saved.flow.id })).rejects.toThrow('Submission ID field');
  }
  expect(() => assertVersionReady(saved.flow.id, saved.versionId)).toThrow();
  expect((await call(tool, { action: 'continue_setup', composition_id: saved.compositionRecordId })).flow.id).toBe(saved.flow.id);
  expect(await call(tool, { action: 'list_runs', flow: saved.flow.id })).toEqual([]);
  // Use the same repository write as the editor, without running or connecting an account.
  updateDraftVersion(saved.versionId, { trigger: graph.trigger });
  expect(versionReadiness(saved.flow.id, saved.versionId).issues.every(i => i.code === 'CONNECTION_BINDING')).toBe(true);
  // Local connection metadata fixture only; no credentials or external provider call.
  upsertConnection({ externalId: 'fixture-account', displayName: 'Fixture account', type: 'OAUTH2', pieceName: name, pieceVersion: '0.18.2', value: {} });
  const complete = structuredClone(graph.trigger);
  (complete.nextAction.settings.input as Record<string, unknown>).auth = '{{connections.fixture-account}}';
  updateDraftVersion(saved.versionId, { trigger: complete });
  expect(versionReadiness(saved.flow.id, saved.versionId).ready).toBe(true);
  expect((await call(tool, { action: 'continue_setup', composition_id: saved.compositionRecordId })).setup).toBeUndefined();
  expect((await call(tool, { action: 'list' })).flows).toHaveLength(1);
  expect(await call(tool, { action: 'list_runs', flow: saved.flow.id })).toEqual([]);
});

test('draft composition defers missing values but refuses invalid mappings, types, references and actions', () => {
  const registry = new PieceCatalog([piece]);
  const trigger = structuredClone(graph.trigger);
  trigger.settings.input = { submission_id_field: '', submission_email_field: '' };
  trigger.nextAction.settings.input = { spreadsheet_id: '', values: null as any };
  const deferred = compileWorkflow(trigger, { pieces: registry, phase: 'composition' });
  expect(deferred.ready).toBe(true);
  expect(deferred.setupIssues?.length).toBeGreaterThanOrEqual(4);
  trigger.settings.input.submission_id_field = '__proto__.id';
  expect(compileWorkflow(trigger, { pieces: registry, phase: 'composition' }).ready).toBe(false);
  trigger.settings.input.submission_id_field = '';
  for (const input of [{ spreadsheet_id: {}, values: [] }, { spreadsheet_id: '{{missing.id}}', values: [] }]) {
    trigger.nextAction.settings.input = input as any;
    expect(compileWorkflow(trigger, { pieces: registry, phase: 'composition' }).ready).toBe(false);
  }
  trigger.nextAction.settings.actionName = 'invented';
  expect(compileWorkflow(trigger, { pieces: registry, phase: 'composition' }).ready).toBe(false);
});


test('configuration-only blocker is repaired into a saved draft without asking the user first', async () => {
  const registry = new PieceCatalog([piece]);
  configureWorkflowReadiness({ pieces: registry });
  const pending = structuredClone(graph);
  pending.trigger.settings.input = { submission_id_field: '', submission_email_field: '' };
  pending.trigger.nextAction.settings.input = { spreadsheet_id: '', values: null as any };
  let turns = 0;
  const tool = createManageWorkflowTool({ pieceRegistry: registry, llm: {
    chat: async () => { throw Error('Must use tools'); },
    chatTools: async (messages) => {
      if (++turns === 1) return { content: '', tool_calls: [blocked()] };
      expect(JSON.stringify(messages)).toContain('Missing configuration does not block a disabled draft');
      return { content: '', tool_calls: [{ id: 'draft', name: 'submit_flow', arguments: pending }] };
    },
  } });
  const result = await call(tool, { action: 'compose', name: 'Forms to Sheets', description: 'Create a disabled form processor draft, leave unknown configuration for later.' });
  expect(turns).toBe(2);
  expect(result.ok).toBe(true);
  expect(result.setup.label).toBe('Setup required');
  expect(result.validation.readyToRun).toBe(false);
  expect(result.flow.status).toBe('DISABLED');
});

test('unconfigured saved draft retains its graph and setup status across database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-pending-draft-'));
  closeWorkflowDb(); initWorkflowDb(join(directory, 'fixture.db'));
  try {
    const registry = new PieceCatalog([piece]);
    configureWorkflowReadiness({ pieces: registry });
    const pending = structuredClone(graph);
    pending.trigger.settings.input = { submission_id_field: '', submission_email_field: '' };
    pending.trigger.nextAction.settings.input = { spreadsheet_id: '', values: null as any };
    const tool = createManageWorkflowTool({ pieceRegistry: registry, llm: { chat: async () => ({ text: JSON.stringify(pending) }) } });
    const saved = await call(tool, { action: 'compose', name: 'Forms to Sheets', description: 'Disabled, configure later' });
    closeWorkflowDb(); initWorkflowDb(join(directory, 'fixture.db')); configureWorkflowReadiness({ pieces: registry });
    expect(getFlowVersion(saved.versionId)?.trigger).toEqual(pending.trigger);
    const reopened = await call(tool, { action: 'continue_setup', composition_id: saved.compositionRecordId });
    expect(reopened.flow.id).toBe(saved.flow.id);
    expect(reopened.setup.fields).toEqual(saved.setup.fields);
    expect(reopened.flow.status).toBe('DISABLED');
    expect(await call(tool, { action: 'list_runs', flow: saved.flow.id })).toEqual([]);
  } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
});
