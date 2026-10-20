import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { ToolRegistry } from '../../actions/tools/registry';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { spendApproval } from '../../authority/approved-action-scope';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';

/**
 * #932: the spawn sink inside a workflow delegation is told "already
 * approved" only when the delegation effect really was approved on a card.
 * The boundary judges the workflow's principal, not the primary the sink
 * judges, so an outright authorisation must leave the sink to decide.
 */

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-delegation-spawn-scope-'));
  initWorkflowDb(join(directory, 'workflow.db'));
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

const PIECE = '@jarvispieces/piece-jarvis-agent';
const ROLE = { id: 'note-writer', name: 'Workflow role', description: '', responsibilities: [], tools: [] as string[] };

function setup(governed: string[]) {
  const flow = createFlow({});
  const delegate: FlowTriggerNode = { name: 'delegate', type: 'PIECE', displayName: 'delegate', settings: { pieceName: PIECE,
    pieceVersion: '0.0.1', actionName: 'delegate', input: { goal: 'Save the note', maxIterations: 2, role: ROLE.id } } };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Delegated routine', trigger: { name: 'trigger', type: 'EMPTY', nextAction: delegate } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const approvals = new ApprovalManager();
  const grants: Array<string | null> = [];
  const child = () => {
    const grant = spendApproval('spawn_agent');
    grants.push(grant ? `${grant.source}:${grant.approvalId}` : null);
    const history: Array<{ role: string; content: unknown }> = [];
    return { id: 'child', agent: { role: ROLE, authority: { allowed_tools: [], max_authority_level: 10 } },
      setTask() {}, activate() {}, idle() {}, addMessage: (role: string, content: unknown) => history.push({ role, content }),
      getMessages: () => history };
  };
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    toolRegistry: new ToolRegistry(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: governed as never, overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), approvalManager: approvals,
    agentOrchestrator: { getPrimary: () => ({ id: 'primary' }), getProfileFor: () => null, getTaintGating: () => null, spawnSubAgent: child, reapAgent: () => {} } as never,
    agentSpecialists: new Map([[ROLE.id, ROLE]]) as never,
    agentScopedRegistry: () => new ToolRegistry(),
    llmManager: { chatTier: async () => ({ content: 'done', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) } as never,
    channelService: {} as never, wsService: {} as never });
  const delegateNow = () => services.agentDelegate!({ goal: 'Save the note', maxIterations: 2, role: ROLE.id },
    { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'delegate', executionPath: [] });
  return { approvals, grants, delegateNow };
}

describe('the workflow delegation hands the spawn sink an approval only when there was one (#932)', () => {
  test('an approved delegation reaches the spawn with that approval', async () => {
    const f = setup(['spawn_agent']);
    const parked = await f.delegateNow();
    expect(parked.status).toBe('approval_required');
    expect(f.grants).toEqual([]);
    f.approvals.approve(parked.approval!.approvalId, 'dashboard');
    await f.delegateNow();
    expect(f.grants).toEqual([`workflow_effect:${parked.approval!.approvalId}`]);
  });

  test('a delegation the boundary allowed outright leaves the sink to decide', async () => {
    const f = setup([]);
    await f.delegateNow();
    expect(f.grants).toEqual([null]);
  });
});
