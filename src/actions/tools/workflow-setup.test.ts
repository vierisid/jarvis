import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS, getWorkflowDb } from '../../workflows/db';
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

const gate = (tool: ReturnType<typeof createManageWorkflowTool>, params: Record<string, unknown>) => tool.authorityGate?.(params) ?? null;

test('compose raises no install card and installs nothing when every connector is already present', async () => {
  const f = setup();
  f.registry.upsert(piece);
  const params = { action: 'compose', name: 'Submission processor', description: 'Trim and validate form submissions, append once, never activate.' };
  expect(gate(f.tool, params)).toBeNull();
  const result = await call(f.tool, params);
  expect(f.installed).toEqual([]);
  expect(result.suggestedInstalls).toBeUndefined();
  expect(result.setup).toMatchObject({ status: 'needs_input', nextQuestion: question });
  expect(result.setup.continueWith).toEqual({ action: 'continue_setup', composition_id: result.compositionRecordId });
  expect(gate(f.tool, result.setup.continueWith)).toBeNull();
});

test('a missing connector is offered by name and installed only by a continue_setup that raises a card naming it', async () => {
  const f = setup();
  const params = { action: 'compose', name: 'Submission processor', description: 'Original job: trim and validate form submissions, append once, never activate.' };
  // Whether anything is missing is only known once the composer has looked,
  // so compose itself never asks for installation authority.
  expect(gate(f.tool, params)).toBeNull();
  const first = await call(f.tool, params);
  expect(f.installed).toEqual([]);
  expect(first.ok).toBe(false);
  expect(first.setup).toMatchObject({ status: 'needs_installation', label: 'Setup required',
    missingConnectors: ['Google Sheets (google-sheets)'],
    continueWith: { action: 'continue_setup', composition_id: first.compositionRecordId, install: 'google-sheets' } });
  expect(first.setup.nextQuestion).toContain('Google Sheets (google-sheets)');
  const card = gate(f.tool, first.setup.continueWith);
  expect(card).toMatchObject({ actionCategory: 'install_software', confirm: 'above_level' });
  expect(card!.intent).toContain('Install Library connector Google Sheets (google-sheets)');
  // The card names the stored workflow, not the raw composition ID.
  expect(card!.intent).toContain('to set up workflow: Submission processor');
  expect(card!.intent).not.toContain(first.compositionRecordId);
  const result = await call(f.tool, first.setup.continueWith);
  expect(f.installed).toEqual(['google-sheets']);
  expect(result.installedConnectors).toEqual(['google-sheets']);
  expect(f.registry.get(name)).toBeTruthy();
  expect(result.setup).toMatchObject({ status: 'needs_input', nextQuestion: question,
    continueWith: { action: 'continue_setup', composition_id: result.compositionRecordId } });
  expect(result.setup.continueWith.install).toBeUndefined();
  expect(result.suggestedInstalls).toBeUndefined();
  expect(getWorkflowComposition(result.compositionRecordId)?.specification.provenance?.installedPieces?.map(p => p.id)).toEqual(['google-sheets']);
});

test('a denied install card leaves setup required, naming the connector that was not installed', async () => {
  const f = setup();
  const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Build disabled draft' });
  // Denial means the gated continue_setup never executes. What the person is
  // left with is the compose result: no draft, nothing installed, the
  // connector named. A later continuation without install still installs
  // nothing and keeps naming it.
  expect(gate(f.tool, first.setup.continueWith)).toMatchObject({ actionCategory: 'install_software' });
  expect(first.flow).toBeUndefined();
  expect((await call(f.tool, { action: 'list' })).flows).toHaveLength(0);
  expect(first.suggestedInstalls).toEqual([expect.objectContaining({ id: 'google-sheets', displayName: 'Google Sheets' })]);
  const later = await call(f.tool, { action: 'continue_setup', composition_id: first.compositionRecordId, answers: { idField: 'id' } });
  expect(f.installed).toEqual([]);
  expect(later.setup).toMatchObject({ status: 'needs_installation', missingConnectors: ['Google Sheets (google-sheets)'],
    continueWith: { install: 'google-sheets' } });
});

test('create with a description offers the install and installs only under a card naming it', async () => {
  const f = setup();
  const params = { action: 'create', name: 'Submission processor', description: 'Build disabled draft' };
  expect(gate(f.tool, params)).toBeNull();
  const first = await call(f.tool, params);
  expect(f.installed).toEqual([]);
  expect(first.routedFrom).toBe('create');
  expect(first.setup.continueWith.install).toBe('google-sheets');
  const direct = { ...params, name: 'Submission processor 2', install: 'google-sheets' };
  expect(gate(f.tool, direct)!.intent).toContain('Google Sheets (google-sheets)');
  expect(gate(f.tool, { action: 'create', name: 'Blank', empty: true, install: 'google-sheets' })).toBeNull();
  await call(f.tool, { action: 'create', name: 'Blank', empty: true, install: 'google-sheets' });
  expect(f.installed).toEqual([]);
  const installed = await call(f.tool, direct);
  expect(f.installed).toEqual(['google-sheets']);
  expect(installed.installedConnectors).toEqual(['google-sheets']);
});

test('install is refused before anything runs when it is not one this call may install', async () => {
  const f = setup();
  const base = { action: 'compose', name: 'Submission processor', description: 'Build disabled draft' };
  expect(gate(f.tool, { ...base, install: 'google-sheets', install_missing: false })).toBeNull();
  await expect(f.tool.execute({ ...base, install: 'google-sheets', install_missing: false })).rejects.toThrow('install_missing: false');
  await expect(f.tool.execute({ ...base, install: 'not-in-library' })).rejects.toThrow('Unknown Library ID');
  await expect(f.tool.execute({ ...base, install: 'a,b,c,d' })).rejects.toThrow('at most 3');
  const hosted = createManageWorkflowTool({ pieceRegistry: f.registry, llm: { chat: async () => { throw Error('unused'); } } });
  expect(gate(hosted, { ...base, install: 'google-sheets' })).toBeNull();
  await expect(hosted.execute({ ...base, install: 'google-sheets' })).rejects.toThrow('not available');
  const noInstall = await call(f.tool, { ...base, install_missing: false });
  expect(noInstall.setup.continueWith).toMatchObject({ install_missing: false });
  expect(noInstall.setup.continueWith.install).toBeUndefined();
  // Following continueWith with install added keeps install_missing: false, so no card.
  expect(gate(f.tool, { ...noInstall.setup.continueWith, install: 'google-sheets' })).toBeNull();
  // Dropping it raises no card either: the gate reads the stored setup, and
  // the action refuses, saying nothing was installed.
  const dropped = { action: 'continue_setup', composition_id: noInstall.compositionRecordId, install: 'google-sheets' };
  expect(gate(f.tool, dropped)).toBeNull();
  expect(gate(f.tool, { ...dropped, install_missing: true })).toMatchObject({ actionCategory: 'install_software' });
  await expect(f.tool.execute(dropped)).rejects.toThrow('Nothing was installed, even if an install was just approved');
  expect(f.installed).toEqual([]);
  expect(f.turns()).toBe(1);
});

function scripted(respond: (turn: number) => Record<string, unknown>) {
  const registry = new PieceCatalog([]), installed: string[] = [];
  configureWorkflowReadiness({ pieces: registry });
  let turn = 0;
  const llm: ComposerLlmClient = { chat: async () => { throw Error('Use discovery'); },
    chatTools: async () => ({ content: '', tool_calls: [respond(++turn)] }) as never };
  const tool = createManageWorkflowTool({ pieceRegistry: registry, llm, library: [entry], installLibraryPiece: async id => {
    installed.push(id); registry.upsert(piece);
  } });
  return { tool, registry, installed };
}

test('a real capability gap is reported as blocked, naming the connector, with no install offered', async () => {
  const f = scripted(() => ({ id: 'gap', name: 'report_blocked', arguments: { reason: 'Unsupported',
    capabilityGaps: ['No action reads every page of results'],
    suggestedPieces: [{ id: 'google-sheets', reason: 'Required destination' }] } }));
  const result = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Build disabled draft' });
  expect(result.ok).toBe(false);
  expect(result.capabilityGaps).toEqual(['No action reads every page of results']);
  expect(result.setup).toMatchObject({ status: 'blocked', missingConnectors: ['Google Sheets (google-sheets)'] });
  expect(result.setup.nextQuestion).toContain('No action reads every page of results');
  expect(result.setup.nextQuestion).toContain('Google Sheets (google-sheets)');
  expect(result.setup.nextQuestion).toContain('would not unblock');
  expect(result.setup.continueWith.install).toBeUndefined();
  expect(gate(f.tool, result.setup.continueWith)).toBeNull();
  expect(f.installed).toEqual([]);
});

test('a preinstall that is already installed is reported as already installed, not failed', async () => {
  const f = setup();
  f.registry.upsert(piece);
  const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Build disabled draft' });
  const params = { action: 'continue_setup', composition_id: first.compositionRecordId, install: 'google-sheets' };
  // Nothing will be installed, so no install card is raised.
  expect(gate(f.tool, params)).toBeNull();
  expect(gate(f.tool, { action: 'compose', name: 'Again', description: 'x', install: 'google-sheets' })).toBeNull();
  const result = await call(f.tool, params);
  expect(f.installed).toEqual([]);
  expect(result.alreadyInstalledConnectors).toEqual(['google-sheets']);
  expect(result.installedConnectors).toBeUndefined();
  expect(result.installationErrors).toBeUndefined();
});

test('a composer failure after a preinstall reports the connector it installed', async () => {
  const f = scripted(turn => turn > 1 ? { id: 'saved', name: 'submit_flow', arguments: graph } : blocked(true));
  const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Build disabled draft' });
  expect(first.setup.continueWith.install).toBe('google-sheets');
  // The install is journaled (an UPDATE of specification); the composer's
  // next checkpoint then fails, so the composer throws after installing.
  getWorkflowDb().exec(`CREATE TRIGGER broken_checkpoint BEFORE UPDATE OF previous_response ON workflow_composition
    BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END`);
  const failure = f.tool.execute(first.setup.continueWith);
  await expect(failure).rejects.toThrow('checkpoint write failed');
  await expect(failure).rejects.toThrow('installedConnectors: google-sheets');
  await expect(failure).rejects.toMatchObject({ installedConnectors: ['google-sheets'] });
  expect(f.installed).toEqual(['google-sheets']);
});

test('create with a blank description raises no install card and installs nothing', async () => {
  const f = setup();
  const params = { action: 'create', name: 'Blank', description: '   ', install: 'google-sheets' };
  expect(gate(f.tool, params)).toBeNull();
  await expect(f.tool.execute(params)).rejects.toThrow('empty workflow');
  expect(f.installed).toEqual([]);
});

test('setup continuation preserves the original request and answers, then saves only one disabled draft', async () => {
  const f = setup();
  const description = 'Trim, validate, append once. No real actions or activation.';
  const initial = await call(f.tool, { action: 'compose', name: 'Submission processor', description });
  const answers = { sample: { id: 'fixture-1', email: ' A@EXAMPLE.COM ' }, idField: 'id', emailField: 'email' };
  const waiting = await call(f.tool, { ...initial.setup.continueWith, answers });
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
  expect(f.installed).toEqual(['google-sheets']);
});

test('answers or installs sent after the draft is saved are refused, pointing to the editor, and raise no card', async () => {
  const f = setup();
  f.registry.upsert(piece);
  f.complete();
  const saved = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Trim, validate, append once.' });
  expect(saved.ok).toBe(true);
  expect(saved.setup.status).toBe('needs_configuration');
  expect(saved.setup.editor).toEqual({ flowId: saved.flow.id, versionId: saved.versionId });
  // A saved draft is configured in the editor, so no continueWith is offered.
  expect(saved.setup.continueWith).toBeUndefined();
  expect(saved.setup.nextStep).toContain('workflow editor (setup.editor)');
  expect(saved.setup.recheckWith).toEqual({ action: 'continue_setup', composition_id: saved.compositionRecordId });
  const turns = f.turns();
  const before = getFlowVersion(saved.versionId)!.trigger;
  await expect(f.tool.execute({ action: 'continue_setup', composition_id: saved.compositionRecordId, answers: { spreadsheet: 'other' } }))
    .rejects.toThrow(/draft is already saved.*workflow editor \(setup\.editor\)/);
  // An install into a saved draft installs nothing, so no card is raised for it.
  f.registry.remove(name);
  const install = { action: 'continue_setup', composition_id: saved.compositionRecordId, install: 'google-sheets' };
  expect(gate(f.tool, install)).toBeNull();
  await expect(f.tool.execute(install)).rejects.toThrow('nothing was installed or changed');
  expect(f.installed).toEqual([]);
  expect(f.turns()).toBe(turns);
  expect(getFlowVersion(saved.versionId)!.trigger).toEqual(before);
  // Recheck without answers still reports readiness for the same draft.
  const recheck = await call(f.tool, saved.setup.recheckWith);
  expect(recheck).toMatchObject({ ok: true, flow: { id: saved.flow.id }, setup: { status: 'needs_configuration' } });
  // Models send null or {} for an unused optional parameter: still a recheck.
  for (const answers of [null, {}]) {
    expect(await call(f.tool, { ...saved.setup.recheckWith, answers })).toMatchObject({ ok: true, flow: { id: saved.flow.id } });
  }
});

test('explicit no-install stays disabled and is retained across setup continuation', async () => {
  const f = setup();
  expect(f.tool.authorityGate?.({ action: 'compose', install_missing: false })).toBeNull();
  const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'No installs', install_missing: false });
  await call(f.tool, { action: 'continue_setup', composition_id: first.compositionRecordId, answers: { idField: 'id' } });
  expect(f.installed).toEqual([]);
});

test('failed installation is attempted once and reported as the concrete blocker, not offered again', async () => {
  const f = setup(true);
  const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Build disabled draft' });
  const result = await call(f.tool, first.setup.continueWith);
  expect(f.installed).toEqual(['google-sheets']);
  expect(result.ok).toBe(false);
  expect(result.installationErrors.join(' ')).toContain('Fixture install unavailable');
  expect(result.installedConnectors).toBeUndefined();
  expect(result.setup.missingConnectors).toEqual(['Google Sheets (google-sheets)']);
  expect(result.setup.continueWith.install).toBeUndefined();
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


test('a COMPOSING journal left by a crash does not block the chain', async () => {
  const f = setup();
  const initial = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Preserve this job' });
  // A crash leaves the row COMPOSING with no live attempt in this process.
  getWorkflowDb().run(`UPDATE workflow_composition SET state = 'COMPOSING' WHERE id = ?`, [initial.compositionRecordId]);
  const resumed = await call(f.tool, { action: 'continue_setup', composition_id: initial.compositionRecordId, answers: { idField: 'id' } });
  expect(resumed.compositionRecordId).not.toBe(initial.compositionRecordId);
  expect(getWorkflowComposition(resumed.compositionRecordId)!.specification.context?.workflowSetup).toMatchObject({ answers: { idField: 'id' } });
});

test('a live attempt blocks the chain however long it runs, and raises no install card meanwhile', async () => {
  const registry = new PieceCatalog([]);
  let hold = false, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const tool = createManageWorkflowTool({ pieceRegistry: registry, library: [entry], installLibraryPiece: async () => {}, llm: {
    chat: async () => { throw Error('Use tools'); }, chatTools: async () => {
      calls++;
      if (hold) { hold = false; entered(); await waiting; }
      return { content: '', tool_calls: [blocked()] };
    },
  } });
  const initial = await call(tool, { action: 'compose', name: 'Submission processor', description: 'Preserve this job' });
  hold = true;
  const continuing = call(tool, { action: 'continue_setup', composition_id: initial.compositionRecordId, answers: { idField: 'id' } });
  await started;
  try {
    // Long past any time window: liveness is this process's own record.
    getWorkflowDb().run(`UPDATE workflow_composition SET updated = ? WHERE state = 'COMPOSING'`, [Date.now() - 24 * 60 * 60_000]);
    const before = calls;
    const install = { action: 'continue_setup', composition_id: initial.compositionRecordId, install: 'google-sheets' };
    expect(gate(tool, install)).toBeNull();
    await expect(tool.execute({ action: 'continue_setup', composition_id: initial.compositionRecordId })).rejects.toThrow('already being prepared');
    await expect(tool.execute(install)).rejects.toThrow('already being prepared');
    expect(calls).toBe(before);
  } finally { release(); await continuing; }
  expect((await call(tool, { action: 'list' })).flows).toHaveLength(0);
});

test('the action installs only what the card named, even if another entry goes missing while the card waits', async () => {
  const otherName = '@activepieces/piece-fixture-other';
  const other = { id: 'fixture-other', npmPackage: otherName, displayName: 'Fixture Other', description: 'Fixture' };
  const registry = new PieceCatalog([{ name: otherName, displayName: 'Other', description: '', actions: {} }]);
  configureWorkflowReadiness({ pieces: registry });
  const installed: string[] = [];
  const tool = createManageWorkflowTool({ pieceRegistry: registry, library: [entry, other], installLibraryPiece: async id => {
    installed.push(id); if (id === entry.id) registry.upsert(piece);
  }, llm: { chat: async () => { throw Error('Use tools'); }, chatTools: async () => ({ content: '', tool_calls: [blocked()] }) } });
  const params = { action: 'compose', name: 'Submission processor', description: 'Build disabled draft', install: 'google-sheets,fixture-other' };
  const frozen = tool.freezeArguments!(params);
  expect(frozen.pinned_installs).toEqual(['google-sheets']);
  // A model cannot widen the pin: freezing overwrites it.
  expect(tool.freezeArguments!({ ...params, pinned_installs: ['fixture-other'] }).pinned_installs).toEqual(['google-sheets']);
  const card = gate(tool, frozen)!;
  expect(card.intent).toContain('Google Sheets (google-sheets)');
  expect(card.intent).not.toContain('fixture-other');
  registry.remove(otherName);
  await call(tool, frozen);
  expect(installed).toEqual(['google-sheets']);
  // Nothing left to install: no card, and the frozen call installs nothing.
  const again = tool.freezeArguments!({ ...params, install: 'google-sheets' });
  expect(again.pinned_installs).toEqual([]);
  expect(gate(tool, again)).toBeNull();
});

test('setup answers and the original request survive database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-setup-'));
  const database = join(directory, 'fixture.db');
  closeWorkflowDb(); initWorkflowDb(database);
  try {
    const f = setup();
    const first = await call(f.tool, { action: 'compose', name: 'Submission processor', description: 'Keep the original disabled form processor request' });
    await call(f.tool, { ...first.setup.continueWith, answers: { sample: { id: 'fixture-after-restart' } } });
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
  expect(saved.validation).toEqual({ structureValid: true, readyToRun: false });
  expect(saved.setup.status).toBe('needs_configuration');
  expect(saved.setup.fields.map((f: any) => f.path)).toEqual(expect.arrayContaining([
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
  expect(result.readiness.ready).toBe(false);
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
