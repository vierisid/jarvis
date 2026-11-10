import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { ToolRegistry } from '../../actions/tools/registry';
import { browser, browserNavigateTool, browserSnapshotTool, browserClickTool, browserTypeTool, browserHoverTool, browserPressKeyTool } from '../../actions/tools/builtin';
import { FakeRenderer, wireController } from '../../actions/browser/fixtures/fake-renderer';
import { isNoLocalTools, setNoLocalTools } from '../../actions/tools/local-tools-guard';
import { currentTemplateDeliveryScope } from '../../actions/tools/template-delivery-scope';
import { getSidecarManager, setSidecarManagerRef, resetRemoteSnapshotGenerations } from '../../actions/tools/sidecar-route';
import { SidecarRPCError } from '../../sidecar/rpc';
import { AuthorityEngine } from '../../authority/engine';
import { ApprovalManager } from '../../authority/approval';
import { EmergencyController } from '../../authority/emergency';
import { AuditTrail } from '../../authority/audit';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { createJarvisToolsInvokeRoute } from '../sandbox-api/routes/jarvis-tools';

const originalManager = getSidecarManager();
const originalNoLocal = isNoLocalTools();
let restore: (() => void) | undefined;
beforeEach(() => { initWorkflowDb(':memory:'); resetRemoteSnapshotGenerations(); setNoLocalTools(false); });
afterEach(() => { restore?.(); restore = undefined; setNoLocalTools(originalNoLocal);
  setSidecarManagerRef(originalManager!); resetRemoteSnapshotGenerations(); closeWorkflowDb(); });

function fixture(action = browserClickTool, local = false) {
  let generation = 0;
  const calls: Array<{ method: string; args: Record<string, unknown>; delivery: string | undefined }> = [];
  const writes: Record<string, unknown>[] = [];
  setSidecarManagerRef({ listSidecars: () => local ? [] : [{ id: 'pc', name: 'PC', connected: true, capabilities: ['browser'],
    features: ['browser_elem_gen', 'browser_action_outcomes'] }], getConnectionSessionId: () => 'session',
    dispatchRPC: async (_id: string, method: string, args: Record<string, unknown>) => {
      calls.push({ method, args, delivery: currentTemplateDeliveryScope()?.kind });
      if (method === 'browser_snapshot' || method === 'browser_navigate') return { text: '[1] Editor',
        page_url: 'https://example.test/', loader_id: 'document', elem_gen: `snapshot-${++generation}` };
      if (args.elem_gen !== `snapshot-${generation}`) throw new SidecarRPCError('BROWSER_SNAPSHOT_SUPERSEDED', 'Snapshot changed');
      writes.push(args); return 'Action completed';
    } } as any);
  const target = local ? {} : { target: 'pc' };
  const steps = {
    navigate: { tool: browserNavigateTool, params: { ...target, url: 'https://example.test/' } },
    snapshot: { tool: browserSnapshotTool, params: target },
    action: { tool: action, params: action === browserPressKeyTool ? { ...target, key: 'Enter' }
      : { ...target, element_id: 1, ...(action === browserTypeTool ? { text: 'Synthetic note' } : {}) } },
  };
  const registry = new ToolRegistry();
  for (const step of Object.values(steps)) registry.register(step.tool);
  const flow = createFlow();
  let nextAction: any;
  for (const [name, step] of Object.entries(steps).reverse()) nextAction = { name, type: 'PIECE', nextAction,
    settings: { pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke',
      input: { toolName: step.tool.name, params: step.params } } };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Browser steps', trigger: { name: 'trigger', type: 'EMPTY', nextAction } });
  // A local run names no computer, so the flow is pinned to this one, as enabling pins it (#1314 M2).
  if (local) getWorkflowDb().run('UPDATE flow SET binding_pins = ? WHERE id = ?', [JSON.stringify({ schemaVersion: 1, versionId: version.id,
    pinnedAt: Date.now(), connections: {}, machine: { sidecarId: null, name: 'this computer' } }), flow.id]);
  const run = () => createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const approvals = new ApprovalManager();
  const build = () => buildSandboxServiceBackends({ toolRegistry: registry, approvalManager: approvals,
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), credentialResolver: new CredentialResolver(),
    eventBuffer: new WorkflowEventBuffer(), llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  const services = build();
  const call = (id: string, name: keyof typeof steps, backend = services) => createJarvisToolsInvokeRoute(backend)({
    req: new Request('http://local/v1/jarvis/tools/invoke', { method: 'POST',
      headers: { 'X-Jarvis-Step-Name': name, 'X-Jarvis-Execution-Path': '[]' },
      body: JSON.stringify({ toolName: steps[name].tool.name, params: steps[name].params }) }),
    claims: { runId: id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {},
  });
  const approve = async (id: string, name: keyof typeof steps, backend = services) => {
    const parked = await call(id, name, backend); expect(parked.status).toBe(202);
    approvals.approve((await parked.json()).approval.approvalId, 'dashboard');
    return call(id, name, backend);
  };
  return { run, call, approve, build, calls, writes, approvals };
}

for (const action of [browserClickTool, browserTypeTool, browserHoverTool]) test(`${action.name} binds the snapshot taken through the workflow route`, async () => {
  const f = fixture(action), run = f.run();
  expect((await f.approve(run.id, 'navigate')).status).toBe(200);
  expect((await f.call(run.id, 'snapshot')).status).toBe(200);
  expect((await f.approve(run.id, 'action')).status).toBe(200);
  expect(f.writes).toEqual([expect.objectContaining({ elem_gen: 'snapshot-2', action_outcome: true })]);
  expect(f.calls.every(call => call.delivery === 'suppressed')).toBe(true);
  expect((await f.call(run.id, 'action')).status).toBe(200);
  expect(f.writes).toHaveLength(1);
});

test('an approved navigation records its snapshot for the next direct action', async () => {
  const f = fixture(), run = f.run();
  expect((await f.approve(run.id, 'navigate')).status).toBe(200);
  expect((await f.approve(run.id, 'action')).status).toBe(200);
  expect(f.writes[0]?.elem_gen).toBe('snapshot-1');
});

test('interleaved workflow runs cannot adopt each other\'s snapshot', async () => {
  const f = fixture(), a = f.run(), b = f.run();
  expect((await f.call(a.id, 'snapshot')).status).toBe(200);
  expect((await f.call(b.id, 'snapshot')).status).toBe(200);
  const stale = await f.approve(a.id, 'action');
  expect((await stale.json()).outcome).toMatchObject({ code: 'BROWSER_SNAPSHOT_SUPERSEDED', effect: 'not_started' });
  expect(f.writes).toHaveLength(0);
  expect((await f.approve(b.id, 'action')).status).toBe(200);
  expect(f.writes[0]?.elem_gen).toBe('snapshot-2');
});

test('a chat snapshot cannot replace the workflow snapshot before review', async () => {
  const f = fixture(), run = f.run();
  await f.call(run.id, 'snapshot');
  await browserSnapshotTool.execute({ target: 'pc' });
  const stale = await f.approve(run.id, 'action');
  expect((await stale.json()).outcome).toMatchObject({ code: 'BROWSER_SNAPSHOT_SUPERSEDED', effect: 'not_started' });
  expect(f.writes).toHaveLength(0);
});

test('a workflow with no browser read cannot borrow a chat snapshot', async () => {
  const f = fixture(), run = f.run();
  await browserSnapshotTool.execute({ target: 'pc' });
  const response = await f.approve(run.id, 'action');
  expect((await response.json()).outcome).toMatchObject({ code: 'BROWSER_SNAPSHOT_UNVERIFIED', effect: 'not_started' });
  expect(f.writes).toHaveLength(0);
});

test('replaying a snapshot receipt after losing the reader does not restore a live binding', async () => {
  const f = fixture(), run = f.run();
  await f.call(run.id, 'snapshot');
  const restarted = f.build();
  await browserSnapshotTool.execute({ target: 'pc' });
  const before = f.calls.length;
  expect((await f.call(run.id, 'snapshot', restarted)).status).toBe(200);
  expect(f.calls).toHaveLength(before);
  const response = await f.approve(run.id, 'action', restarted);
  expect((await response.json()).outcome).toMatchObject({ code: 'BROWSER_SNAPSHOT_UNVERIFIED', effect: 'not_started' });
  expect(f.writes).toHaveLength(0);
});

test('a local workflow snapshot remains available through approval and the tool adapter', async () => {
  const fake = new FakeRenderer([{ name: 'Editor', x: 50, y: 40 }]);
  restore = wireController(browser, fake);
  const f = fixture(browserTypeTool, true), run = f.run();
  expect((await f.call(run.id, 'snapshot')).status).toBe(200);
  expect((await f.approve(run.id, 'action')).status).toBe(200);
  expect(fake.typed).toEqual([{ text: 'Synthetic note', into: 'Editor' }]);
});

for (const hasRead of [false, true]) test(`a local workflow cannot adopt a chat snapshot (own read: ${hasRead})`, async () => {
  const fake = new FakeRenderer([{ name: 'Editor', x: 50, y: 40 }]);
  restore = wireController(browser, fake);
  const f = fixture(browserTypeTool, true), run = f.run();
  if (hasRead) await f.call(run.id, 'snapshot');
  fake.dom = [{ name: 'Another editor', x: 50, y: 40 }];
  await browserSnapshotTool.execute({});
  const response = await f.approve(run.id, 'action');
  expect(response.status).not.toBe(200);
  expect((await response.json()).outcome.effect).toBe('not_started');
  expect(fake.typed).toEqual([]);
});

test('a direct browser read and an approved navigate reach the flow framed as untrusted content (#1314)', async () => {
  const f = fixture(), run = f.run();
  const navigated = await f.approve(run.id, 'navigate');
  const read = await f.call(run.id, 'snapshot');
  for (const response of [navigated, read]) {
    const body = await response.json();
    expect(String(body.result)).toContain('<<<UNTRUSTED_CONTENT');
    expect(String(body.result)).toContain('[1] Editor');
  }
});

for (const late of ['click', 'dispatch'] as const) test(`a navigate card expires after five minutes and is never executed (late ${late}, #1314)`, async () => {
  const { setSystemTime } = await import('bun:test');
  const f = fixture(), run = f.run();
  try {
    const parked = await f.call(run.id, 'navigate'); expect(parked.status).toBe(202);
    const id = (await parked.json()).approval.approvalId;
    const card = f.approvals.getRequest(id)!;
    const deadline = JSON.parse(card.context!).expiresAt as number;
    // Five minutes from when the card was raised (the deadline is taken just before the row is written).
    expect(deadline - card.created_at).toBeGreaterThan(5 * 60_000 - 1_000);
    expect(deadline - card.created_at).toBeLessThanOrEqual(5 * 60_000);
    if (late === 'click') {
      setSystemTime(new Date(deadline + 1));
      expect(f.approvals.approve(id, 'dashboard')).toBeNull();
    } else {
      f.approvals.approve(id, 'dashboard');
      setSystemTime(new Date(deadline + 1));
    }
    const result = await Promise.resolve(f.call(run.id, 'navigate')).catch((error) => error);
    const outcome = result instanceof Response ? (await result.json()).outcome : result.outcome;
    expect(outcome).toMatchObject({ code: 'APPROVAL_EXPIRED', effect: 'not_started' });
    expect(f.calls.filter(c => c.method === 'browser_navigate')).toHaveLength(0);
  } finally { setSystemTime(); }
});

for (const [moved, snapshot] of [[false, true], [true, true], [true, false]] as const) test(`a local workflow key press is bound to the reviewed document (navigated away: ${moved}, snapshot after: ${snapshot}, #1314)`, async () => {
  const fake = new FakeRenderer([{ name: 'Editor', x: 50, y: 40 }]);
  restore = wireController(browser, fake);
  const f = fixture(browserPressKeyTool, true), run = f.run();
  expect((await f.call(run.id, 'snapshot')).status).toBe(200);
  const parked = await f.call(run.id, 'action'); expect(parked.status).toBe(202);
  // Another snapshot of the same document does not retire the card; a new document does.
  if (moved) fake.loaderId = 'L2';
  // Without a snapshot the controller's record still names the reviewed page, so only the live check can see the move.
  if (snapshot) await browserSnapshotTool.execute({});
  f.approvals.approve((await parked.json()).approval.approvalId, 'dashboard');
  const response = await f.call(run.id, 'action');
  if (moved) {
    expect((await response.json()).outcome).toMatchObject({ effect: 'not_started' });
    expect(fake.keys).toEqual([]);
  } else {
    expect(response.status).toBe(200);
    expect(fake.keys).toHaveLength(1);
  }
});

test('a workflow key press bound for another computer is refused before any card (#1314)', async () => {
  const f = fixture(browserPressKeyTool), run = f.run();
  const response = await f.call(run.id, 'action');
  expect(response.status).toBe(409);
  expect((await response.json()).outcome).toMatchObject({ code: 'WORKFLOW_TOOL_UNSUPPORTED', effect: 'not_started' });
  expect(f.approvals.getPending()).toHaveLength(0);
  expect(f.calls.filter(c => c.method === 'browser_press_key')).toHaveLength(0);
});

test('a navigate card shows the full URL and a type card the text, with the computer (#1314 M1, m9)', async () => {
  const f = fixture(browserTypeTool), run = f.run();
  const nav = await f.call(run.id, 'navigate'); expect(nav.status).toBe(202);
  const navCard = JSON.parse(f.approvals.getRequest((await nav.json()).approval.approvalId)!.context!);
  expect(navCard.intent).toContain('url="https://example.test/"');
  expect(navCard.intent).toContain('On "PC (pc)": open a web page');
  f.approvals.approve(navCard.effectId ? f.approvals.getPending()[0]!.id : '', 'dashboard');
  expect((await f.call(run.id, 'navigate')).status).toBe(200);
  await f.call(run.id, 'snapshot');
  const typed = await f.call(run.id, 'action'); expect(typed.status).toBe(202);
  const card = JSON.parse(f.approvals.getRequest((await typed.json()).approval.approvalId)!.context!);
  expect(card.intent).toContain('text="Synthetic note"');
  expect(card.uiCard.values.map((v: any) => v.name)).toEqual(['element_id', 'text']);
});

test('the page URL a local navigate reports reaches the flow framed too (#1314 review)', async () => {
  const fake = new FakeRenderer([{ name: 'Editor', x: 50, y: 40 }]);
  restore = wireController(browser, fake);
  const f = fixture(browserTypeTool, true), run = f.run();
  const body = await (await f.approve(run.id, 'navigate')).json();
  expect(body.outcome.verification).toMatchObject({ status: 'verified', postcondition: 'page_observed' });
  expect(body.outcome.verification.pageUrl).toContain('<<<UNTRUSTED_CONTENT');
});

test('a key press with no written computer on a flow pinned to another computer is refused, binding nothing (#1314 review)', async () => {
  const { getRunMachineBinding } = await import('../db/repos/run-machine-binding');
  const f = fixture(browserPressKeyTool, true), run = f.run();
  getWorkflowDb().run(`UPDATE flow SET binding_pins = json_set(binding_pins, '$.machine', json('{"sidecarId":"pc","name":"PC"}'))`);
  // The pinned computer is enrolled and connected, so resolving it would have bound the run.
  setSidecarManagerRef({ listSidecars: () => [{ id: 'pc', name: 'PC', connected: true, capabilities: ['browser'], features: [] }],
    getConnectionSessionId: () => 'session', dispatchRPC: async () => { throw new Error('no dispatch expected'); } } as any);
  const response = await f.call(run.id, 'action');
  expect(response.status).toBe(409);
  expect((await response.json()).outcome).toMatchObject({ code: 'WORKFLOW_TOOL_UNSUPPORTED', effect: 'not_started' });
  expect(getRunMachineBinding(run.id)).toBeNull();
  expect(f.approvals.getPending()).toHaveLength(0);
});
