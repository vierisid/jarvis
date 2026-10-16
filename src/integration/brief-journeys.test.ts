/** Cross-module Brief journeys on synthetic data: fresh temp SQLite, stub LLM
 * providers and an in-memory effect counter. No network, no paid model calls. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb } from '../workflows/db';
import { createEntity } from '../vault/entities';
import { createFact, correctFact, getFact, queryFact } from '../vault/facts';
import { getKnowledgeForMessage } from '../vault/retrieval';
import { buildSystemPrompt } from '../roles/prompt-builder';
import type { RoleDefinition } from '../roles/types';
import { AgentOrchestrator } from '../agents/orchestrator';
import { LLMManager } from '../llm/manager';
import { createGoal, createCheckIn, getGoal, getProgressHistory } from '../vault/goals';
import { checkWorkResult, createPlannedWork, configureWorkItem, decideWorkItem, getWorkItem } from '../goals/work-items';
import { startWorkItemRun } from '../goals/workflow-bridge';
import { createFlow, setPublishedVersion } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { claimNextJob, recoverOrphanedJobs } from '../workflows/db/repos/job-queue';
import { ToolRegistry } from '../actions/tools/registry';
import { AuthorityEngine } from '../authority/engine';
import { ApprovalManager } from '../authority/approval';
import { AuditTrail } from '../authority/audit';
import { EmergencyController } from '../authority/emergency';
import { buildSandboxServiceBackends } from '../workflows/runtime/service-backends';
import { WorkflowEventBuffer } from '../workflows/runtime/event-buffer';
import { CredentialResolver } from '../workflows/credentials/adapter';
import { listWorkflowEffects } from '../workflows/db/repos/workflow-effect';

let dir: string, db: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brief-journeys-')); db = join(dir, 'source.db'); initWorkflowDb(db); });
afterEach(() => { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); });
const restart = () => { closeWorkflowDb(); initWorkflowDb(db); };
const role = { id: 'personal-assistant', name: 'Fixture', description: 'Fixture', responsibilities: [], tools: [], authority_level: 3 } as RoleDefinition;

for (const condition of ['normal', 'restart', 'expiry'] as const) test(`source memory correction → recall → next reply (${condition}, stub model)`, async () => {
  const entity = createEntity('person', 'Fixture Person');
  const old = createFact(entity.id, 'preferred_editor', 'OldEditor', { source: 'llm_extraction' });
  const corrected = correctFact(old.id, 'CurrentEditor', 'Explicit synthetic correction');
  if (condition === 'expiry') createFact(entity.id, 'primary_email', 'expired@example.invalid', { confirmed: true, validTo: Date.now() - 1000 });
  if (condition === 'restart') restart();
  expect(getFact(old.id)?.status).toBe('superseded');
  expect(queryFact('Fixture Person', 'preferred_editor')?.id).toBe(corrected.id);
  const knowledgeContext = getKnowledgeForMessage('Fixture Person editor email');
  const system = buildSystemPrompt(role, { knowledgeContext });
  let calls = 0;
  const llm = new LLMManager();
  llm.registerProvider({ name: 'journey-stub', async chat(messages) {
    calls++;
    const prompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(prompt).toContain('preferred_editor: CurrentEditor');
    expect(prompt).not.toContain('preferred_editor: OldEditor');
    expect(prompt).not.toContain('expired@example.invalid');
    expect(prompt).toContain('"basis":"confirmed"');
    return { content: 'CurrentEditor', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'stub', finish_reason: 'stop' };
  }, async *stream() { throw new Error('unused'); }, async listModels() { return ['stub']; } });
  llm.setTierMap({ medium: { provider: 'journey-stub' } });
  const agent = new AgentOrchestrator(); agent.setLLMManager(llm); agent.createPrimary(role);
  expect(await agent.processMessage(system, 'What editor does Fixture Person use?')).toBe('CurrentEditor');
  expect(calls).toBe(1);
});

for (const interrupted of [false, true]) test(`source goal → next work → checked result (interrupted=${interrupted})`, () => {
  const goal = createGoal('Prepare synthetic report', 'task', { status: 'active' });
  const [work] = createPlannedWork(createCheckIn('morning_plan', 'Synthetic plan', [goal.id], ['Review report']).id, [{ title: 'Review report', goalId: goal.id }]);
  const flow = createFlow();
  const version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Synthetic report', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  setPublishedVersion(flow.id, version.id);
  configureWorkItem(work!.id, { mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id });
  const check = { verdict: 'passed', summary: 'Report checked', evidence: [{ ref: 'fixture:report', description: 'Synthetic source matched' }], goalScore: 1 };
  expect(() => checkWorkResult(work!.id, check)).toThrow();
  decideWorkItem(work!.id, { outcome: 'accepted', reason: 'Review synthetic report' });
  const run = startWorkItemRun(work!.id, flow.id); claimNextJob();
  expect(() => checkWorkResult(work!.id, check)).toThrow();
  // The runner result is injected here; this probe certifies the durable result
  // check boundary, not execution of a workflow or a measured outcome.
  updateRun(run.id, { status: interrupted ? 'RUNNING' : 'SUCCEEDED', steps: { report: { output: 'fixture' } } });
  restart();
  expect(getProgressHistory(goal.id)).toHaveLength(0);
  if (interrupted) {
    recoverOrphanedJobs();
    expect(getWorkItem(work!.id).status).toBe('failed');
    expect(() => checkWorkResult(work!.id, check)).toThrow('failed run');
    checkWorkResult(work!.id, { ...check, verdict: 'failed', goalScore: undefined });
    expect(getGoal(goal.id)?.score).toBe(0);
  } else {
    expect(getWorkItem(work!.id).status).toBe('needs_check');
    expect(checkWorkResult(work!.id, check).status).toBe('verified');
    expect(() => checkWorkResult(work!.id, check)).toThrow('already checked');
    expect(getProgressHistory(goal.id)).toHaveLength(1);
  }
  restart();
  expect(getWorkItem(work!.id).resultCheck?.runId).toBe(run.id);
});

test('source governed effect requires approval and keeps one receipt across restart/replay', async () => {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Synthetic effect', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
    name: 'write', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke', input: {} },
  } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  let effects = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', description: 'Synthetic effect counter', category: 'file-ops', parameters: { path: { type: 'string', required: true, description: 'Fixture path' }, content: { type: 'string', required: true, description: 'Fixture content' } },
    execute: async () => { effects++; return { fixture: true }; } });
  const approvals = new ApprovalManager();
  const backends = buildSandboxServiceBackends({ toolRegistry: registry, credentialResolver: new CredentialResolver(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any, eventBuffer: new WorkflowEventBuffer(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: ['write_data'], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    approvalManager: approvals, auditTrail: new AuditTrail(), emergencyController: new EmergencyController() });
  const invoke = () => backends.toolsInvoke!({ toolName: 'write_file', params: { path: '/fixture/report', content: 'fixture' } },
    { runId: run.id, projectId: run.projectId, stepName: 'write', executionPath: [] });
  const pending = await invoke() as unknown as { approval: { approvalId: string } };
  expect(pending.approval).toBeDefined(); expect(effects).toBe(0);
  approvals.approve(pending.approval.approvalId, 'fixture-user');
  await invoke(); expect(effects).toBe(1);
  restart();
  // Replayed success returns the persisted result without dispatching again.
  await invoke(); expect(effects).toBe(1);
  expect(listWorkflowEffects(run.id)).toHaveLength(1);
  expect(listWorkflowEffects(run.id)[0]!.status).toBe('succeeded');
});

test('source observation → accepted composition stays a disabled draft, not an enabled prepared proposal', async () => {
  const { createCapture } = await import('../vault/awareness');
  const { refreshOpportunity } = await import('../awareness/opportunities');
  const { acceptSuggestion, getCompositionRow } = await import('../awareness/suggestion-feedback');
  const { SuggestionComposer } = await import('../awareness/suggestion-composer');
  const { composePersistedFlow } = await import('../actions/tools/persisted-workflow-composer');
  const { sampleCatalog } = await import('../workflows/runtime/test-fixtures');
  const { getFlow } = await import('../workflows/db/repos/flow');
  for (let day = 1; day <= 3; day++) for (const [phase, text] of ['', 'Checking payment status', 'Invoice follow-up draft'].entries()) {
    createCapture({ timestamp: Date.now() - day * 86400000 + phase * 60000, pixelChangePct: 1,
      appName: 'Synthetic accounting', windowTitle: 'Overdue invoices', ocrText: text, sidecarId: 'fixture-device' });
  }
  const suggestion = refreshOpportunity()!; expect(suggestion).not.toBeNull();
  acceptSuggestion(suggestion.id, { requestId: 'fixture-accept', reason: 'Prepare only', name: 'Invoice review',
    description: 'Prepare a synthetic review', expectedOutcome: 'A draft for review' });
  const worker = new SuggestionComposer(request => composePersistedFlow({ pieceRegistry: sampleCatalog(),
    llm: { async chat() { return { text: JSON.stringify({ displayName: 'Invoice review', trigger: { name: 'trigger', type: 'EMPTY' } }) }; } },
  }, request));
  try { worker.start(); await worker.idle(); } finally { worker.stop(); await worker.idle(); }
  const composed = getCompositionRow(suggestion.id)!;
  expect(composed.state).toBe('draft_ready'); expect(getFlow(composed.flow_id!)?.status).toBe('DISABLED');
  restart(); expect(getFlow(composed.flow_id!)?.status).toBe('DISABLED');
});
