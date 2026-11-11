/**
 * Owner decision 2026-11-11 (#1314 follow-up): an approval raised by a
 * screen-derived background turn is marked so when it is created, and while
 * screen awareness is off it is held: no card is delivered or retried,
 * approving it waits (the card stays pending, it is not denied), the
 * executor refuses to run it, and it is approvable again once awareness is
 * back on. Every other approval is unchanged.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { getDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager, type ApprovalRequest } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import { ApprovalDelivery } from './approval-delivery.ts';
import { approvalHeldByAwareness, AWARENESS_HELD_APPROVAL_MESSAGE, runWithApprovalProvenance } from './approval-provenance.ts';
import { applyApprovalDecision, applyExecutionResolution, channelDecisionReply, heldApprovalMessage } from '../daemon/approval-decision.ts';
import { setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard.ts';
import { ToolRegistry, type ToolRegistry as Registry } from '../actions/tools/registry.ts';
import { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMProvider, LLMResponse, LLMStreamEvent } from '../llm/provider.ts';
import type { RoleDefinition } from '../roles/types.ts';
import type { JarvisConfig } from '../config/types.ts';
import { BackgroundAgentService } from '../daemon/background-agent-service.ts';

let on = true;
let mgr: ApprovalManager;
let executor: DeferredExecutor;
let executions: number;
let deps: Parameters<typeof applyApprovalDecision>[3];
beforeEach(() => {
  on = true;
  setScreenCaptureEnabledSource(() => on);
  initDatabase(':memory:', { quiet: true });
  mgr = new ApprovalManager();
  executor = new DeferredExecutor(mgr, new AuditTrail());
  executions = 0;
  executor.setToolRegistry({ get: () => undefined, execute: async () => { executions++; return 'sent'; } } as unknown as Registry);
  deps = { approvalManager: mgr, deferredExecutor: executor, wsService: { broadcastApprovalUpdate: () => {} } };
});
afterEach(() => setScreenCaptureEnabledSource(null));

function request(screen: boolean): ApprovalRequest {
  const create = () => mgr.createRequest({ agentId: 'bg', agentName: 'Background', toolName: 'send_email',
    toolArguments: { to: 'x@example.com' }, actionCategory: 'send_email', urgency: 'normal', reason: 'test', context: '' });
  return screen ? runWithApprovalProvenance('screen', create) : create();
}

test('an approval created inside a screen-derived turn is marked so on the row; any other is not', () => {
  const screen = request(true), plain = request(false);
  expect(screen.provenance).toBe('screen');
  expect(mgr.getRequest(screen.id)!.provenance).toBe('screen');
  expect(plain.provenance).toBeNull();
  expect(mgr.getRequest(plain.id)!.provenance).toBeNull();
  // An explicit provenance wins over the turn's.
  const explicit = runWithApprovalProvenance('screen', () => mgr.createRequest({ agentId: 'w', agentName: 'W', toolName: 't',
    toolArguments: {}, actionCategory: 'send_email', urgency: 'normal', reason: 'r', context: '', provenance: null }));
  expect(explicit.provenance).toBeNull();
});

test('held only while screen awareness is off, and only when screen-derived', () => {
  const screen = request(true), plain = request(false);
  expect(approvalHeldByAwareness(screen)).toBe(false);
  on = false;
  expect(approvalHeldByAwareness(screen)).toBe(true);
  expect(approvalHeldByAwareness(plain)).toBe(false);
});

// ── The background agent marks what its screen-derived turns raise ──

const ROLE = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: [], authority_level: 10 } as unknown as RoleDefinition;
const reply = (content: string, call?: boolean): LLMResponse => ({ content, usage: { input_tokens: 1, output_tokens: 1 }, model: 'rec',
  tool_calls: call ? [{ id: 'c1', name: 'ask', arguments: {} }] : [], finish_reason: call ? 'tool_use' : 'stop' });
class Provider implements LLMProvider {
  name = 'rec'; calls = 0;
  async chat(_m: LLMMessage[]): Promise<LLMResponse> { this.calls++; return this.calls % 2 === 1 ? reply('', true) : reply('done'); }
  async *stream(m: LLMMessage[]): AsyncIterable<LLMStreamEvent> { const r = await this.chat(m); yield { type: 'done', response: r }; }
  async listModels(): Promise<string[]> { return ['rec']; }
}

test('a screen-derived background turn marks every approval it raises; an ordinary turn does not', async () => {
  const llm = new LLMManager();
  const provider = new Provider();
  llm.registerProvider(provider);
  llm.setTierMap({ medium: { provider: provider.name } });
  const svc = new BackgroundAgentService({} as JarvisConfig, llm);
  const orch = svc.getOrchestrator();
  orch.setLLMManager(llm);
  const tools = new ToolRegistry();
  const raised: ApprovalRequest[] = [];
  // A tool that asks for approval the way request_approval does: inside the turn.
  tools.register({ name: 'ask', description: 'ask', category: 'research', parameters: {},
    execute: async () => { raised.push(request(false)); return 'asked'; } });
  orch.setToolRegistry(tools);
  orch.createPrimary(ROLE);
  await svc.handleMessage('screen: an error dialog', 'awareness', { screenDerived: true });
  await svc.handleMessage('a commitment is due', 'system');
  expect(raised.map(r => mgr.getRequest(r.id)!.provenance)).toEqual(['screen', null]);
});

// ── Delivery ──

function delivery() {
  const shown: string[] = [];
  const sent: string[] = [];
  const out = new ApprovalDelivery();
  out.setBroadcaster({ broadcastApprovalRequest: (r) => shown.push(r.id) });
  let midSend: () => void = () => {};
  out.setChannelSender({ async broadcastToAll(_text, _options, d) {
    // Each channel attempt asks shouldContinue first, as ChannelService does.
    if (d?.shouldContinue && !d.shouldContinue()) return;
    sent.push('first');
    midSend();
    if (d?.shouldContinue && !d.shouldContinue()) return;
    sent.push('retry');
  } });
  return { out, shown, sent, setMidSend: (f: () => void) => { midSend = f; } };
}

test('no card for a held request goes anywhere while awareness is off; an ordinary one still does', async () => {
  const { out, shown, sent } = delivery();
  const screen = request(true), plain = request(false);
  on = false;
  await out.deliver(screen);
  expect(shown).toEqual([]);
  expect(sent).toEqual([]);
  await out.deliver(plain);
  expect(shown).toEqual([plain.id]);
  expect(sent).toEqual(['first', 'retry']);
});

test('a screen-derived card stops before its next channel retry once awareness turns off', async () => {
  const { out, sent, setMidSend } = delivery();
  setMidSend(() => { on = false; });
  await out.deliver(request(true));
  expect(sent).toEqual(['first']);
});

test('held cards go out when awareness is back on, except one decided meanwhile', async () => {
  const { out, shown } = delivery();
  const waiting = request(true), decided = request(true);
  on = false;
  await out.deliver(waiting);
  await out.deliver(decided);
  mgr.deny(decided.id, 'dashboard');
  on = true;
  await out.resumeHeld((id) => mgr.getRequest(id));
  expect(shown).toEqual([waiting.id]);
  // Once: a second resume has nothing left to send.
  await out.resumeHeld((id) => mgr.getRequest(id));
  expect(shown).toEqual([waiting.id]);
});

// ── Deciding and running ──

test('approving a held request waits: the card stays pending, nothing runs, and the answer says why', async () => {
  const screen = request(true);
  on = false;
  const outcome = await applyApprovalDecision('approve', screen.id, 'dashboard', { ...deps, auditTrail: new AuditTrail() });
  expect(outcome).toMatchObject({ status: 'held', state: 'awareness_off' });
  expect(mgr.getRequest(screen.id)!.status).toBe('pending');
  // Refused before the decision: no approval is recorded at all.
  expect(getDb().query('SELECT count(*) AS n FROM audit_trail WHERE approval_id = ?').get(screen.id)).toEqual({ n: 0 });
  expect(executions).toBe(0);
  expect(heldApprovalMessage('awareness_off')).toBe(AWARENESS_HELD_APPROVAL_MESSAGE);
  expect(channelDecisionReply(outcome, screen)).toBe(AWARENESS_HELD_APPROVAL_MESSAGE);
  // Back on: approvable again, and it runs.
  on = true;
  expect(await applyApprovalDecision('approve', screen.id, 'dashboard', deps)).toMatchObject({ status: 'approved', executed: true });
  expect(executions).toBe(1);
});

test('denying a held request still works', async () => {
  const screen = request(true);
  on = false;
  expect(await applyApprovalDecision('deny', screen.id, 'dashboard', deps)).toMatchObject({ status: 'denied' });
});

test('an ordinary request is approved and run while awareness is off, as before', async () => {
  const plain = request(false);
  on = false;
  expect(await applyApprovalDecision('approve', plain.id, 'dashboard', deps)).toMatchObject({ status: 'approved', executed: true });
  expect(executions).toBe(1);
});

test('the executor refuses a held request with a typed refusal, takes no claim, and puts the card back to pending', async () => {
  const screen = request(true);
  mgr.approve(screen.id, 'dashboard');
  on = false;
  const receipt = await executor.executeApprovedWithReceipt(screen.id, 'dashboard');
  expect(receipt).toMatchObject({ claimed: false, held: 'awareness_off' });
  expect(receipt.result).toContain(AWARENESS_HELD_APPROVAL_MESSAGE);
  expect(executions).toBe(0);
  const row = mgr.getRequest(screen.id)!;
  expect(row).toMatchObject({ status: 'pending', decided_by: null, execution_claimed_at: null, execution_outcome: null });
  on = true;
  expect(await applyApprovalDecision('approve', screen.id, 'dashboard', deps)).toMatchObject({ status: 'approved', executed: true });
  expect(executions).toBe(1);
});

test('the decision answers held, not approved, when awareness goes off between the check and the run', async () => {
  const screen = request(true);
  // The switch is read on approve and again by the executor; it goes off in between.
  const approve = mgr.approve.bind(mgr);
  mgr.approve = (id, by) => { const row = approve(id, by); on = false; return row; };
  const outcome = await applyApprovalDecision('approve', screen.id, 'dashboard', deps);
  expect(outcome).toMatchObject({ status: 'held', state: 'awareness_off' });
  expect(mgr.getRequest(screen.id)!.status).toBe('pending');
  expect(executions).toBe(0);
});

test('a held request a restart left not started is not run while awareness is off', async () => {
  const screen = request(true);
  mgr.approve(screen.id, 'dashboard');
  mgr.reconcileAfterRestart();
  on = false;
  expect(await applyExecutionResolution('execute', screen.id, 'dashboard', deps)).toEqual({ status: 'not_executable', reason: AWARENESS_HELD_APPROVAL_MESSAGE });
  expect(executions).toBe(0);
  on = true;
  expect(await applyExecutionResolution('execute', screen.id, 'dashboard', deps)).toMatchObject({ status: 'executed' });
  expect(executions).toBe(1);
});

test('approval_requests carries the provenance column', () => {
  const columns = (getDb().query('PRAGMA table_info(approval_requests)').all() as Array<{ name: string }>).map(c => c.name);
  expect(columns).toContain('provenance');
});
