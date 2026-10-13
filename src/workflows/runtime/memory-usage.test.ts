import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryForget } from '../../brief/memory-forget';
import { closeWorkflowDb, initWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { AuthorityEngine } from '../../authority/engine';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { AuditTrail } from '../../authority/audit';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { createJarvisLlmChatRoute } from '../sandbox-api/routes/jarvis-llm';
import { LLMManager } from '../../llm/manager';
import { createEntity } from '../../vault/entities';
import { createFact, correctFact } from '../../vault/facts';
import { getKnowledgeForMessage } from '../../vault/retrieval';
import { getMemoryUsageLedger } from '../../vault/memory-usage';
import { getDb } from '../../vault/schema';

let saved: string | undefined, dir: string, file: string;
beforeEach(() => { saved = process.env.JARVIS_BRIEF_MEMORY_USAGE; process.env.JARVIS_BRIEF_MEMORY_USAGE = '1'; dir = mkdtempSync(join(tmpdir(), 'q16-workflow-')); file = join(dir, 'vault.db'); initWorkflowDb(file); });
afterEach(() => { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); if (saved === undefined) delete process.env.JARVIS_BRIEF_MEMORY_USAGE; else process.env.JARVIS_BRIEF_MEMORY_USAGE = saved; });
function fixture(overrideSystem = false, blocked = false, afterBuild?: (id: string) => void) {
  const fact = createFact(createEntity('person', 'Ada').id, 'editor', 'Emacs', { confirmed: true });
  const input = { prompt: 'Ada editor', ...(overrideSystem ? { overrideSystem: true, system: 'Generic only' } : {}) };
  const action: FlowTriggerNode = { name: 'ask', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-ask', pieceVersion: '0.0.1', actionName: 'ask', input } };
  const flow = createFlow(), version = createDraftVersion({ flowId: flow.id, displayName: 'Memory fixture', trigger: { name: 'trigger', type: 'EMPTY', nextAction: action } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const manager = new LLMManager(); let calls = 0, builds = 0; const seen: unknown[] = [];
  manager.registerProvider({ name: 'fixture', listModels: async () => [], chat: async messages => { calls++; seen.push(messages); return { content: 'Answer', tool_calls: [], finish_reason: 'stop', model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 } }; }, async *stream() {} });
  const services = buildSandboxServiceBackends({ authorityEngine: new AuthorityEngine({ default_level: blocked ? 1 : 10, governed_categories: blocked ? ['read_data'] : [], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    approvalManager: new ApprovalManager(), emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(), llmManager: manager,
    channelService: {} as any, wsService: {} as any, buildJarvisSystemPrompt: text => { builds++; const dynamic = getKnowledgeForMessage(text); afterBuild?.(fact.id); return { static: 'Jarvis fixture', dynamic }; } });
  const call = () => createJarvisLlmChatRoute({ llmChat: services.llmChat! })({ req: new Request('http://localhost/v1/jarvis/llm/chat', { method: 'POST',
    headers: { 'X-Jarvis-Step-Name': 'ask', 'X-Jarvis-Execution-Path': '[]' }, body: JSON.stringify(input) }),
    claims: { runId: run.id, projectId: DEFAULT_IDS.project, sandboxId: 'fixture' } as any, params: {} });
  return { fact, flow, run, call, calls: () => calls, builds: () => builds, seen };
}
test('governed workflow asks record run/workflow/revision/purpose, and effect replay appends nothing', async () => {
  const f = fixture(); const response = await f.call(); expect(response.status).toBe(200); expect(f.calls()).toBe(1);
  expect(JSON.stringify(f.seen)).toContain(f.fact.id);
  const result = getMemoryUsageLedger().readTarget({ runId: f.run.id }); if (!result.data) throw Error('Missing run history');
  expect(result.data.uses.filter(u => u.stage === 'supplied')).toMatchObject([{ factId: f.fact.id, runId: f.run.id, workflowId: f.flow.id, purpose: 'workflow_context', turn: null }]);
  expect(result.data.uses.some(u => u.stage === 'outcome_verified')).toBe(false);
  const before = getDb().query('SELECT * FROM memory_use_events').all(); expect((await f.call()).status).toBe(200);
  expect(f.calls()).toBe(1); expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual(before);
});
test('explicit system override skips retrieval and cannot claim memory was supplied', async () => {
  const f = fixture(true); expect((await f.call()).status).toBe(200); expect(f.calls()).toBe(1); expect(f.builds()).toBe(0);
  expect(JSON.stringify(f.seen)).not.toContain(f.fact.id); expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
});
test('pending Authority approval cannot record selected or supplied context', async () => {
  const f = fixture(false, true); const response = await f.call(); const body = await response.json();
  expect(body.approval).toBeDefined(); expect(f.calls()).toBe(0); expect(f.builds()).toBe(0);
  expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
});

function mutate(id: string, mutation: 'correct' | 'forget') {
  if (mutation === 'correct') { correctFact(id, 'Vim', 'Owner correction'); return; }
  const forget = new MemoryForget(getDb(), () => true), ready = forget.get(id);
  if (ready.state !== 'ready') throw Error('Missing fact');
  forget.forget(id, { requestId: crypto.randomUUID(), expectedRevision: ready.revision, confirmed: true });
}
for (const mutation of ['correct', 'forget'] as const) {
  test(`governed ask ${mutation === 'forget' ? 'rejects' : 'passes'} ${mutation} between context preparation and provider handoff without usage logging`, async () => {
    delete process.env.JARVIS_BRIEF_MEMORY_USAGE;
    const f = fixture(false, false, id => mutate(id, mutation));
    // Owner decision (F18 I-3): Forget refuses the handoff, a correction passes once.
    if (mutation === 'forget') { await expect(f.call()).rejects.toThrow('forgotten'); expect(f.calls()).toBe(0); }
    else { expect((await f.call()).status).toBe(200); expect(f.calls()).toBe(1); }
    expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual([]);
  });
  test(`queued ask selects current memory after ${mutation} and disk restart`, async () => {
    const f = fixture(); mutate(f.fact.id, mutation);
    closeWorkflowDb(); initWorkflowDb(file);
    expect((await f.call()).status).toBe(200); expect(f.calls()).toBe(1);
    expect(JSON.stringify(f.seen)).not.toContain('Emacs');
    if (mutation === 'correct') expect(JSON.stringify(f.seen)).toContain('Vim');
    const history = getMemoryUsageLedger().readTarget({ runId: f.run.id });
    expect(history.data?.uses.some(use => use.factId === f.fact.id)).toBe(false);
  });
  test(`immutable effect replay and historical use references survive ${mutation} and disk restart`, async () => {
    const f = fixture(); expect((await f.call()).status).toBe(200);
    const effects = getDb().query('SELECT * FROM workflow_effect WHERE run_id = ?').all(f.run.id);
    const version = getDb().query('SELECT * FROM flow_version WHERE flow_id = ?').all(f.flow.id);
    const uses = getDb().query('SELECT * FROM memory_use_events').all();
    expect(effects).toHaveLength(1); expect(uses).toHaveLength(2);
    mutate(f.fact.id, mutation); closeWorkflowDb(); initWorkflowDb(file);
    expect((await f.call()).status).toBe(200); expect(f.calls()).toBe(1); expect(f.builds()).toBe(1);
    expect(getDb().query('SELECT * FROM workflow_effect WHERE run_id = ?').all(f.run.id)).toEqual(effects);
    expect(getDb().query('SELECT * FROM flow_version WHERE flow_id = ?').all(f.flow.id)).toEqual(version);
    expect(getDb().query('SELECT * FROM memory_use_events').all()).toEqual(uses);
    const history = getMemoryUsageLedger().readTarget({ runId: f.run.id });
    expect(history.data?.uses.every(use => use.factState === (mutation === 'correct' ? 'superseded' : 'forgotten'))).toBe(true);
    expect(JSON.stringify(uses)).not.toContain('Emacs');
  });
}
