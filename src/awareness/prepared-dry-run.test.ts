import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initDatabase } from '../vault/schema.ts';
import { createGoal } from '../vault/goals.ts';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../workflows/db/index.ts';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness.ts';
import { createFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, type FlowTriggerNode } from '../workflows/db/repos/flow-version.ts';
import { createCompositionJournal } from '../workflows/db/repos/workflow-composition.ts';
import { PieceCatalog, metadataToCatalogEntry } from '../workflows/runtime/piece-catalog.ts';
import { SandboxApi } from '../workflows/sandbox-api/server.ts';
import { EngineRuntime } from '../workflows/runner/engine-runtime/engine-runtime.ts';
import { CredentialResolver } from '../workflows/credentials/adapter.ts';
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from '../workflows/runner/engine-runtime/build.ts';
import { buildAllJarvisPieces } from '../workflows/runner/engine-runtime/build-pieces.ts';
import { AuthorityEngine } from '../authority/engine.ts';
import { PreparedDryRunner, type DryFixture } from './prepared-dry-run.ts';
import { DRY_RUNNER, JOB_CONSTRAINTS, liveQualificationServices, qualifyPreparedProposal, versionDigest, type DrySample, type QualificationRequest } from './prepared-qualification.ts';

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const initialCached = findCachedBundle();
const piecesBuilt = existsSync(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/jarvis/test/dist/src/index.js'));
const skip = (initialCached === null && !buildOptIn) || (!piecesBuilt && !buildOptIn);
const JARVIS = '@jarvispieces/piece-jarvis-';

const step = (name: string, piece: string, actionName: string, input: Record<string, unknown>, nextAction?: FlowTriggerNode): FlowTriggerNode =>
  ({ name, type: 'PIECE', settings: { pieceName: JARVIS + piece, pieceVersion: '0.0.1', actionName, input }, ...(nextAction ? { nextAction } : {}) });
/** Read open commitments, draft a reminder with AI, show it to the owner. */
const reminder: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', nextAction:
  step('commitments', 'context', 'commitments_list', {},
    step('draft', 'ask', 'ask', { prompt: 'Draft a reminder about {{commitments}}' },
      step('tell_me', 'notify', 'notify', { message: '{{draft.text}}', channels: ['dashboard'] }))) };
const fixture = (reply?: string): DryFixture => ({ id: 'week-41', payload: {},
  context: { commitments: [{ id: 'c1', what: 'Invoice 1042 is overdue', status: 'pending' }] },
  ...(reply ? { replies: { draft: reply } } : {}) });
const count = (table: 'flow' | 'flow_run' | 'flow_version') =>
  getWorkflowDb().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

function prepare(trigger: FlowTriggerNode) {
  const goal = createGoal('Collect overdue invoices', 'objective', { status: 'active' });
  const journal = createCompositionJournal({ schemaVersion: 1, name: 'Invoice reminder', description: 'Remind me about overdue invoices' });
  journal.finish('VALIDATED', []);
  const flow = createFlow({ metadata: { compositionRecordId: journal.id } });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Invoice reminder', trigger });
  return { goal, journal, flow, version };
}
function request(p: ReturnType<typeof prepare>, sample: DrySample): QualificationRequest {
  return { proposalId: 'proposal-1', revision: 'r1', evidence: [{ kind: 'observation', id: 'capture-1', revision: null }],
    goal: { goalId: p.goal.id, revision: String(p.goal.updated_at) }, compositionId: p.journal.id,
    workflow: { flowId: p.flow.id, versionId: p.version.id, versionDigest: versionDigest(p.version.trigger) },
    bindings: [], constraints: JOB_CONSTRAINTS.invoice_review, sample,
    preview: { basis: 'sandbox_sample', runId: null, effects: [{ step: 'tell_me', approval: 'asks_first', sample: 'simulated' }] } };
}
const services = () => liveQualificationServices({ tool: () => null, targets: () => [], now: () => 1,
  authority: new AuthorityEngine({ default_level: 7, governed_categories: ['send_email', 'send_message'], overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }) });

describe('prepared dry runner (real engine)', () => {
  let runner: PreparedDryRunner | null = null;

  beforeAll(async () => {
    initDatabase(':memory:');
    initWorkflowDb(':memory:');
    if (skip) return;
    const bundle = initialCached ?? await buildEngineBundle();
    if (buildOptIn) await buildAllJarvisPieces();
    // Readiness uses the real pieces' metadata, as the daemon does.
    const api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ host: '127.0.0.1', port: 0 });
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
    try {
      const handle = await runtime.acquire({ runId: 'q13-metadata', projectId: DEFAULT_IDS.project });
      try {
        const entries = [];
        for (const piece of ['context', 'ask', 'notify']) {
          entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({ pieceName: JARVIS + piece, pieceVersion: '0.0.1' })));
        }
        configureWorkflowReadiness({ pieces: new PieceCatalog(entries) });
      } finally { await handle.release(); }
    } finally { await runtime.shutdown(); await api.stop(); }
    runner = await PreparedDryRunner.start(bundle.bundlePath);
  }, 120_000);

  afterAll(async () => {
    await runner?.close();
    closeWorkflowDb();
  });

  test.skipIf(skip)('runs the exact version with every service simulated, keeps no run, and its sample backs a Ready preview', async () => {
    const p = prepare(reminder);
    const before = { flows: count('flow'), versions: count('flow_version') };
    const sample = await runner!.run(p.flow.id, p.version.id, fixture('Ana, invoice 1042 is two weeks overdue.'));
    expect(sample).toMatchObject({ runner: DRY_RUNNER, flowId: p.flow.id, versionId: p.version.id,
      versionDigest: versionDigest(p.version.trigger), fixtureId: 'week-41', status: 'SUCCEEDED', error: null,
      simulated: [{ step: 'commitments', service: 'context' }, { step: 'draft', service: 'llm' }, { step: 'tell_me', service: 'notify' }] });
    expect(sample.outputs.draft).toMatchObject({ text: 'Ana, invoice 1042 is two weeks overdue.' });
    expect(sample.outputs.tell_me).toEqual({ delivered: [], failed: [] });
    // The scratch copy and its run are gone, and the proposal's workflow never ran.
    expect({ flows: count('flow'), versions: count('flow_version') }).toEqual(before);
    expect(count('flow_run')).toBe(0);

    const qualification = qualifyPreparedProposal(request(p, sample), services());
    expect(qualification.reasons).toEqual([]);
    expect(qualification.verdict).toBe('ready');
  }, 60_000);

  test.skipIf(skip)('a step the fixture does not cover fails the run, and that sample keeps the proposal from Ready', async () => {
    const p = prepare(reminder);
    const sample = await runner!.run(p.flow.id, p.version.id, fixture());
    expect(sample.status).toBe('FAILED');
    expect(sample.error).toStartWith('draft: ');
    expect(sample.error).toContain('The fixture has no simulated model reply for draft');
    expect(sample.error).not.toContain('\n');
    expect(sample.simulated.map(s => s.step)).toEqual(['commitments', 'draft']);
    expect(qualifyPreparedProposal(request(p, sample), services()).reasons.map(r => r.code)).toEqual(['sample_failed', 'preview_misstated']);
    expect(count('flow_run')).toBe(0);
  }, 60_000);

  test.skipIf(skip)('concurrent requests run one at a time, each against its own fixture', async () => {
    const p = prepare(reminder);
    const [first, second] = await Promise.all([
      runner!.run(p.flow.id, p.version.id, { ...fixture('First reply'), id: 'first' }),
      runner!.run(p.flow.id, p.version.id, { ...fixture('Second reply'), id: 'second' }),
    ]);
    expect([first.fixtureId, (first.outputs.draft as { text: string }).text]).toEqual(['first', 'First reply']);
    expect([second.fixtureId, (second.outputs.draft as { text: string }).text]).toEqual(['second', 'Second reply']);
    expect(first.simulated).toEqual(second.simulated);
  }, 90_000);

  test.skipIf(skip)('refuses a graph it cannot simulate before anything is created', async () => {
    const flows = count('flow');
    const p = prepare({ name: 'trigger', type: 'EMPTY', nextAction: { name: 'send', type: 'PIECE',
      settings: { pieceName: '@activepieces/piece-gmail', pieceVersion: '0.0.1', actionName: 'send_email', input: {} } } });
    await expect(runner!.run(p.flow.id, p.version.id, fixture('unused'))).rejects.toThrow(
      'The dry runner cannot run this workflow: send uses @activepieces/piece-gmail, which the dry runner cannot simulate');
    expect(count('flow')).toBe(flows + 1);
    expect(count('flow_run')).toBe(0);
  });
});
