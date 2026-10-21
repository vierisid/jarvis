import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// #955: the dashboard says, where people decide, that community piece actions
// run without approval, and that they are still audited and stop on Pause/Kill.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NativeResponse = globalThis.Response;
let act: typeof import('react').act;
let createRoot: typeof import('react-dom/client').createRoot;
let gate: typeof import('./approval-gate');
let LibraryPanel: typeof import('./LibraryPanel').LibraryPanel;
let StepNode: typeof import('./WorkflowEditor').StepNode;
let Env: typeof import('./WorkflowEditorEnvironment').WorkflowEditorEnvironment;
let ReactFlowProvider: typeof import('@xyflow/react').ReactFlowProvider;
let AuthorityRoomBody: typeof import('../authority/AuthorityRoom').AuthorityRoomBody;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  gate = await import('./approval-gate');
  ({ LibraryPanel } = await import('./LibraryPanel'));
  ({ StepNode } = await import('./WorkflowEditor'));
  ({ WorkflowEditorEnvironment: Env } = await import('./WorkflowEditorEnvironment'));
  ({ ReactFlowProvider } = await import('@xyflow/react'));
  ({ AuthorityRoomBody } = await import('../authority/AuthorityRoom'));
});
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

const entry = (id: string, tier: 'verified' | 'community') =>
  ({ id, npmPackage: `@activepieces/piece-${id}`, displayName: id, description: '', iconUrl: null, tier });

for (const managed of [false, true]) {
  test(`the Library says community pieces run without approval, collapsed, when managed is ${managed}`, async () => {
    const request = (async () => NativeResponse.json({ managed, entries: [entry('gmail', 'verified'), entry('activecampaign', 'community')] })) as any;
    await act(async () => root.render(
      <Env.Provider value={{ request, portalHost: null, workspace: false }}><LibraryPanel /></Env.Provider>));
    // The community list itself stays collapsed; the sentence does not.
    expect(host.textContent).not.toContain('activecampaign');
    expect(host.textContent).toContain(gate.COMMUNITY_APPROVAL_NOTE);
    expect(gate.COMMUNITY_APPROVAL_NOTE).toMatch(/run without approval/);
    expect(gate.COMMUNITY_APPROVAL_NOTE).toMatch(/recorded in the audit log, and it is held while Jarvis is paused and refused after Kill/);
  });
}

const catalog = [
  { name: '@activepieces/piece-activecampaign', displayName: 'ActiveCampaign', description: '', actions: [], triggers: [], notApprovalGated: true },
  { name: '@activepieces/piece-gmail', displayName: 'Gmail', description: '', actions: [], triggers: [] },
];
const nodeData = (pieceName: string, type = 'PIECE') => ({
  step: { name: 'step_1', type, settings: { pieceName, actionName: 'create_contact', triggerName: 'new_contact' } },
  selected: false, catalog, depth: 0, branchName: null, isOrphan: false, targetIsFree: false, outConnected: false,
  loopBodyConnected: false, branchConnected: {}, runStatus: null, runError: null, runDuration: null,
});
const renderNode = async (data: ReturnType<typeof nodeData>) => act(async () => root.render(
  <ReactFlowProvider><StepNode {...({ data, id: 'n' } as any)} /></ReactFlowProvider>));

test('a community action step carries the Not approval-gated badge with its tooltip', async () => {
  await renderNode(nodeData('@activepieces/piece-activecampaign'));
  expect(host.textContent).toContain(gate.NOT_APPROVAL_GATED_LABEL);
  const badge = host.querySelector('.wf-node__ungated');
  expect(badge?.getAttribute('title')).toBe(gate.NOT_APPROVAL_GATED_TOOLTIP);
  // Not only a mouse tooltip: the explanation is the note's own text, read once.
  expect(badge?.getAttribute('role')).toBe('note');
  expect(badge?.hasAttribute('aria-describedby')).toBe(false);
  expect(badge?.querySelector('.wf-node__ungated-desc')?.textContent).toBe(gate.NOT_APPROVAL_GATED_TOOLTIP);
  expect(gate.NOT_APPROVAL_GATED_TOOLTIP).toMatch(/recorded in the audit log, and it is held while Jarvis is paused and refused after Kill/);
});

test('a verified step, a community trigger, an unconfigured community step and an unknown piece carry no badge', async () => {
  const unconfigured = nodeData('@activepieces/piece-activecampaign');
  unconfigured.step.settings.actionName = '';
  for (const data of [nodeData('@activepieces/piece-gmail'), nodeData('@activepieces/piece-activecampaign', 'PIECE_TRIGGER'), unconfigured,
    nodeData('@activepieces/piece-not-installed')]) {
    await renderNode(data);
    expect(host.textContent).toContain('step_1');
    expect(host.textContent).not.toContain(gate.NOT_APPROVAL_GATED_LABEL);
  }
});

test('the Authority room says governed categories do not reach community workflow steps', async () => {
  const config = { default_level: 3, governed_categories: ['send_email'], overrides: [], context_rules: [],
    learning: { enabled: true, suggest_threshold: 5 }, emergency_state: 'normal' };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/authority/config')) return NativeResponse.json(config);
    if (url.includes('/api/authority/status')) return NativeResponse.json({ emergency_state: 'normal', pending_approvals: 0, config });
    return NativeResponse.json([]);
  }) as unknown as typeof fetch;
  await act(async () => root.render(<AuthorityRoomBody mode="expanded" />));
  const grants = [...host.querySelectorAll('[role="tab"]')].find((b) => /^\s*Grants\s*$/.test(b.textContent ?? ''));
  expect(grants).toBeDefined();
  await act(async () => (grants as HTMLElement).click());
  expect(host.textContent).toContain('Governed categories');
  expect(host.textContent).toContain(gate.AUTHORITY_SCOPE_NOTE);
  expect(gate.AUTHORITY_SCOPE_NOTE).toMatch(/Community pieces and CODE steps in workflows run without approval/);
  expect(gate.AUTHORITY_SCOPE_NOTE).toMatch(/Built-in steps such as HTTP requests and webhooks also run without approval/);
});
