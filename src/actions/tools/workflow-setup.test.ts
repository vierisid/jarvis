import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../../workflows/db';
import { getWorkflowComposition } from '../../workflows/db/repos/workflow-composition';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
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
beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());
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
  expect(f.turns()).toBe(2);
  expect(f.prompts[1]).toContain('sheets_append_values');
  expect(result.setup).toMatchObject({ status: 'needs_input', nextQuestion: question,
    continueWith: { action: 'continue_setup', composition_id: result.compositionRecordId } });
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
