import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../../../../src/workflows/db';
import { createWorkItem, getWorkItem } from '../../../../src/goals/work-items';
import { DecisionQueue } from '../../../../src/brief/decisions';
import { createDecisionRoutes } from '../../../../src/brief/decision-routes';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { ApprovalManager } from '../../../../src/authority/approval';
import { DeferredExecutor } from '../../../../src/authority/deferred-executor';
import { AuditTrail } from '../../../../src/authority/audit';
import { createHostTransport } from './http';
import { maintenanceRoom } from './maintenance';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let Input: typeof import('./InputDialog'), Commands: typeof import('./canonical-commands');
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost:3198/' });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  Input = await import('./InputDialog'); Commands = await import('./canonical-commands');
});
beforeEach(() => { closeWorkflowDb(); initWorkflowDb(':memory:'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); closeWorkflowDb(); });
afterAll(() => GlobalRegistrator.unregister());
const button = (name: string) => [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.querySelector('.brief-button__label')?.textContent || b.textContent)?.trim() === name)!;
async function click(name: string) { expect(button(name)).toBeTruthy(); await React.act(async () => button(name).click()); }
test('intent resolution requires an in-app reason, reaches the canonical queue once and re-reads its result', async () => {
  const item = createWorkItem({ title: 'Local decision' });
  const approvals = new ApprovalManager(), deferred = new DeferredExecutor(approvals, new AuditTrail());
  const queue = new DecisionQueue(getWorkflowDb(), { approvalManager: approvals, deferredExecutor: deferred });
  const caps = new BriefCapabilities([{ id: 'decisions', provider: queue }], ['decisions']);
  const routes = createDecisionRoutes(caps, (value, status = 200) => Response.json(value, { status }), queue);
  let writes = 0, changed = 0;
  const transport = createHostTransport((async (path: string, init: RequestInit) => {
    writes++;
    const request = Object.assign(new Request('http://localhost' + path, init), { params: { id: path.split('/').at(-2)! } });
    return routes['/api/brief/decisions/:id/resolve']!.POST!(request);
  }) as unknown as typeof fetch);
  const read = async () => { const response = await queue.read({}); return response.state === 'ready' ? response.data.items : []; };
  await React.act(async () => root.render(<><Input.InputHost /><Commands.PendingDecisions http={transport} read={read} enabled changed={() => changed++} /></>));
  expect(await read()).toHaveLength(1);
  await click('Accept next step'); expect(writes).toBe(0); expect(button('Continue').disabled).toBe(true);
  await click('Cancel'); expect(writes).toBe(0); expect(getWorkItem(item.id)?.status).toBe('proposed');
  await click('Accept next step');
  const input = document.querySelector('textarea')!;
  await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Reviewed the isolated integration fixture'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Continue');
  expect(writes).toBe(1); expect(changed).toBe(1); expect(getWorkItem(item.id)?.status).toBe('ready');
  expect(host.textContent).toContain('Decision updated: ready');
  transport.stop();
});
test('scope cancellation closes a pending input without submitting and the next prompt still works', async () => {
  await React.act(async () => root.render(<Input.InputHost />));
  const abort = new AbortController(); let answer!: Promise<string | null>;
  await React.act(async () => { answer = Input.inputDialog('Local run input', '{}', abort.signal); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await React.act(async () => abort.abort()); expect(await answer).toBeNull();
  await React.act(async () => { answer = Input.inputDialog('Second input', 'retained'); });
  await click('Continue'); expect(await answer).toBe('retained');
});
test('canonical maintenance rooms retain the owner, while native panels and reset links retain their separate owner', () => {
  expect(maintenanceRoom('http://localhost/?brief=0&briefMaintenance=1&settingsTab=llm#/_room_settings')).toBe('settings');
  for (const hash of ['#/_panel_settings', '#/_task_123', '#/_answer_123', '#/_room_missing', '#/'])
    expect(maintenanceRoom('http://localhost/?briefMaintenance=1' + hash)).toBeNull();
  expect(maintenanceRoom('http://localhost/?briefMaintenance=1&onboarding=reset#/_room_settings')).toBeNull();
  expect(maintenanceRoom('http://localhost/#/_room_settings')).toBeNull();
});


test('host Run skips empty scheduled input, retains webhook cancellation and sends one version-bound request', async () => {
  const { createWorkflowRooms } = await import('./workflow-rooms');
  const { makeRunsFixture, RUN_SCOPE, RUN_CAPABILITY } = await import('../workflows/runs/fixtures');
  for (const kind of ['schedule', 'webhook']) {
    const fixture = makeRunsFixture(), payloads: any[] = []; let prompts = 0;
    const { scopeId, flowId, versionId } = RUN_SCOPE;
    const version = { id: versionId, flowId, state: 'LOCKED', displayName: 'Calendar digest',
      trigger: { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: kind, input: { cron_expression: '0 8 * * 1-5', timezone: 'Europe/Rome' } },
        nextAction: { name: 'read', type: 'PIECE', settings: { input: { goal: 'Read today’s calendar' } } } } };
    const transport = createHostTransport((async (input: any, init: any = {}) => {
      const path = String(input), signal = new AbortController().signal;
      if (init.method === 'POST') {
        const body = JSON.parse(init.body); payloads.push(body);
        return Response.json(await fixture.port.start!( { ...RUN_SCOPE, requestId: body.brief.requestId } ));
      }
      if (path.endsWith('/versions/' + versionId)) return Response.json(version);
      if (path.includes('/inspection?')) return Response.json({ status: 'ready', data: { ...RUN_SCOPE } });
      if (path.endsWith('/runs')) return Response.json(await fixture.port.list(null, signal));
      if (path.includes('/runs/')) return Response.json(await fixture.port.detail(path.split('/').at(-1)!, signal));
      if (path === '/api/workflows/' + flowId) return Response.json({ flow: { id: flowId }, published: version });
      throw Error('Unexpected fixture path ' + path);
    }) as typeof fetch);
    const stored = new Map<string, string>();
    const workflows = createWorkflowRooms({ scopeId, transport, capabilities: () => RUN_CAPABILITY,
      storage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); } }, dirty() {},
      runInput: async () => { prompts++; return null; } });
    const shell = { mode: 'live', route: { room: 'workflow-runs', selection: { flowId, versionId } },
      theme: 'dark', sidebar: 'expanded', chatOpen: false, navigate() {}, setTheme() {}, setSidebar() {}, setChatOpen() {} } as any;
    const Room = workflows.rooms['workflow-runs']!.Body!;
    try {
      await React.act(async () => root.render(<Room shell={shell} />));
      await React.act(async () => { button('Run workflow').click(); await new Promise(r => setTimeout(r, 400)); });
      expect(prompts).toBe(kind === 'schedule' ? 0 : 1);
      expect(payloads).toHaveLength(kind === 'schedule' ? 1 : 0);
      if (kind === 'schedule') {
        expect(payloads[0].payload).toEqual({});
        expect(payloads[0].brief).toMatchObject({ scopeId, versionId });
        expect(fixture.stats().requests).toBe(1);
      }
    } finally {
      await React.act(async () => root.render(null));
      workflows.retire(); fixture.controller.retire(); transport.stop();
    }
  }
});


test('permission cards preserve selection and settle only the selected request once', async () => {
  let rows: any[] = ['one', 'two'].map(id => ({ decisionId: 'approval:' + id, revision: 'revision-' + id, kind: 'permission',
    title: 'Review browser_navigate. This action needs review.', state: 'pending', review: { toolName: 'browser_navigate', reason: 'Approval required', origin: 'https://calendar.example' },
    supportedActions: ['approve_permission', 'reject_permission', 'inspect'] }));
  const writes: any[] = [];
  const transport = createHostTransport((async (path, init) => {
    const body = JSON.parse(String(init?.body)); writes.push({ path, body });
    const id = decodeURIComponent(String(path).split('/').at(-2)!);
    rows = rows.filter(row => row.decisionId !== id);
    return Response.json({ decisionId: id, revision: 'settled', state: 'approved' });
  }) as typeof fetch);
  await React.act(async () => root.render(<Commands.PendingDecisions http={transport} read={async () => rows} enabled changed={() => {}} selection="two" />));
  expect(host.querySelectorAll('.brief-decision-choice')).toHaveLength(2);
  expect(host.querySelector('article.brief-decision-paper')).not.toBeNull();
  await click('Grant permission');
  expect(writes).toHaveLength(1); expect(writes[0].path).toContain('approval%3Atwo');
  expect(writes[0].body).toMatchObject({ revision: 'revision-two', action: 'approve_permission' });
  expect(host.querySelectorAll('.brief-decision-choice')).toHaveLength(1);
  await click('Deny permission'); expect(writes[1].body.action).toBe('reject_permission');
  transport.stop();
});

test('a browser click card leads with what will be clicked and where, with the generic action as subtitle', async () => {
  const row = { decisionId: 'approval:c', revision: 'r', kind: 'permission', state: 'pending', title: 'Review browser_click on element [5]. Business effect unknown.',
    review: { toolName: 'browser_click', reason: 'Approval required', origin: 'https://mail.example', element: 'button "Send" [5]' },
    supportedActions: ['approve_permission', 'reject_permission', 'inspect'] };
  const transport = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Commands.PendingDecisions http={transport} read={async () => [row as any]} enabled changed={() => {}} />));
  expect(host.querySelector('article h2')?.textContent).toBe('On https://mail.example: click button "Send" [5]');
  expect(host.querySelector('.brief-decision-subtitle')?.textContent).toBe('Interact with the browser');
  expect(host.querySelector('.brief-decision-document')?.textContent).toContain('Business effect unknown');
  expect(host.querySelector('details')?.textContent).not.toContain('Business effect unknown');
  transport.stop();
});


test('a desktop workflow card leads with the computer and lists every value with its source (#1314)', async () => {
  const row = { decisionId: 'approval:d', revision: 'r', kind: 'permission', state: 'pending', title: 'On "Studio PC (pc-1)": act on an app control',
    review: { toolName: 'desktop_click', reason: 'Approval required', computer: 'Studio PC (pc-1)', window: 'Untitled - Notepad', element: '"Text editor" [3]',
      values: [{ name: 'action', value: '"set_value"', source: 'agent' }, { name: 'value', value: '"A poem"', source: 'run_data' }] },
    supportedActions: ['approve_permission', 'reject_permission', 'inspect'] };
  const transport = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Commands.PendingDecisions http={transport} read={async () => [row as any]} enabled changed={() => {}} />));
  expect(host.querySelector('article h2')?.textContent).toBe('On Studio PC (pc-1): act on an app control');
  const doc = host.querySelector('.brief-decision-document')!.textContent!;
  for (const text of ['Studio PC (pc-1)', 'Untitled - Notepad', 'action (chosen by the agent)', '"set_value"', 'value (from run data)', '"A poem"']) expect(doc).toContain(text);
  transport.stop();
});

test('a hostile element label cannot put another origin where the card names the page', async () => {
  const row = { decisionId: 'approval:h', revision: 'r', kind: 'permission', state: 'pending', title: 'Review browser_click on element [5].',
    review: { toolName: 'browser_click', reason: 'Approval required', origin: 'https://evil.example', element: 'button "Cancel\\" on https://yourbank.example" [5]' },
    supportedActions: ['approve_permission', 'reject_permission', 'inspect'] };
  const transport = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Commands.PendingDecisions http={transport} read={async () => [row as any]} enabled changed={() => {}} />));
  const heading = host.querySelector('article h2')!.textContent!;
  expect(heading.startsWith('On https://evil.example: click button "Cancel\\"')).toBe(true);
  transport.stop();
});


test('notification permission renders the reviewed message, destination and occurrence context', async () => {
  const transport = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  const row = { decisionId: 'approval:notice', revision: 'r', kind: 'permission', state: 'pending', title: 'Send daily check-in',
    review: { toolName: 'workflow_notify', reason: 'Permission required', workflowName: 'Daily priorities', requestedAt: Date.UTC(2026, 10, 4, 8),
      message: 'What are your priorities?\nWhat is blocking you?', channels: ['dashboard'], fallback: 'desktop' }, supportedActions: ['approve_permission', 'reject_permission', 'inspect'] };
  await React.act(async () => root.render(<Commands.PendingDecisions http={transport} read={async () => [row as any]} enabled changed={() => {}} />));
  expect(host.textContent).toContain('Daily priorities'); expect(host.textContent).toContain('What is blocking you?');
  expect(host.textContent).toContain('dashboard'); expect(host.textContent).toContain('If no dashboard is open: desktop notification');
  expect(host.querySelector('time')?.dateTime).toBe('2026-11-04T08:00:00.000Z');
  transport.stop();
});

test('permission list reports its real count to suppress the unrelated document empty state', async () => {
  const counts: (number | null)[] = [];
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Commands.PendingDecisions http={http} read={async () => [{ decisionId: 'request', revision: 'r', title: 'Review fixture', kind: 'permission', state: 'pending', supportedActions: ['inspect'] } as any]} enabled changed={() => {}} onCount={count => counts.push(count)} />));
  expect(counts.at(-1)).toBe(1);
  expect(host.textContent).toContain('Review fixture');
});

test('permission list reports an unknown count while it cannot read, and zero when the capability is off', async () => {
  const counts: (number | null)[] = [];
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Commands.PendingDecisions http={http} read={async () => { throw Error('down'); }} enabled changed={() => {}} onCount={count => counts.push(count)} />));
  expect(counts.at(-1)).toBeNull(); expect(host.textContent).toContain('Decision status is unavailable');
  await React.act(async () => root.render(<Commands.PendingDecisions http={http} read={async () => []} enabled={false} changed={() => {}} onCount={count => counts.push(count)} />));
  expect(counts.at(-1)).toBe(0);
});

test('the permission list takes exactly the rows without document actions, so it and DecisionsRoom never overlap', async () => {
  const { createDomainPorts } = await import('./domain-ports');
  const rows = [
    { decisionId: 'approval:a', revision: 'r', kind: 'permission', supportedActions: ['inspect'] },
    { decisionId: 'work:w', revision: 'r', kind: 'intent', supportedActions: ['inspect'] },
    { decisionId: 'approval:c', revision: 'r', kind: 'permission', supportedActions: ['approve_permission', 'inspect'] },
    { decisionId: 'decision:d', revision: 'r', kind: 'permission', supportedActions: ['approve_permission', 'inspect'] },
  ];
  const http = createHostTransport((async (path: string) => {
    if (path.startsWith('/api/brief/decisions?')) return Response.json({ state: 'ready', data: { items: rows, nextCursor: null } });
    const id = decodeURIComponent(path.split('/')[4]!);
    return Response.json({ decision: { decisionId: id, revision: 'r' }, actions: id === 'decision:d' ? ['approve'] : [] });
  }) as unknown as typeof fetch);
  const ports = createDomainPorts('scope', http, { setItem() {} });
  expect((await ports.otherDecisions()).map(row => row.decisionId)).toEqual(['approval:a', 'work:w', 'approval:c']);
  http.stop();
});

test('an allowed permission card whose outcome is unknown shows its state, not a request for permission', async () => {
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  const row = { decisionId: 'approval:done', revision: 'r', kind: 'permission', state: 'unknown', title: 'Send report', supportedActions: ['inspect'] };
  await React.act(async () => root.render(<Commands.PendingDecisions http={http} read={async () => [row as any]} enabled changed={() => {}} />));
  expect(host.textContent).not.toContain('permission is needed'); expect(host.textContent).not.toContain('needs your permission');
  expect(host.textContent).not.toContain('Allowing this request'); expect(host.textContent).toContain('unknown');
  http.stop();
});


test('manual run JSON stays open with the exact text until corrected; cancellation never dispatches', async () => {
  await React.act(async () => root.render(<Input.InputHost />));
  let result: Record<string, unknown> | null | undefined;
  await React.act(async () => { void Input.manualRunInput().then(value => { result = value; }); });
  const enter = async (text: string) => { const area = document.querySelector('textarea')!;
    await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text); area.dispatchEvent(new Event('input', { bubbles: true })); }); };
  for (const invalid of ['{"customer":', '[]', 'null', 'false', '42', '"text"']) {
    await enter(invalid); await click('Continue');
    expect(result).toBeUndefined(); expect(document.querySelector('textarea')?.value).toBe(invalid);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('JSON object');
    expect(document.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true');
  }
  await enter('{"price":0,"active":false,"nested":{"id":"customer"}}'); await click('Continue');
  expect(result).toEqual({ price: 0, active: false, nested: { id: 'customer' } });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  for (const cancel of ['Cancel', 'Escape']) {
    result = undefined;
    await React.act(async () => { void Input.manualRunInput().then(value => { result = value; }); });
    await enter('{broken'); await click('Continue');
    if (cancel === 'Cancel') await click('Cancel');
    else await React.act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(result).toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull();
  }
});

test('a manual trigger that declares fields asks for them in a form, with JSON as an advanced option', async () => {
  await React.act(async () => root.render(<Input.InputHost />));
  let result: Record<string, unknown> | null | undefined;
  await React.act(async () => { void Input.manualRunInput(undefined, ['customer', 'amount']).then(value => { result = value; }); });
  expect(document.querySelector('textarea')).toBeNull();
  const boxes = [...document.querySelectorAll('input')] as HTMLInputElement[];
  expect(boxes.length).toBe(2);
  expect(document.body.textContent).toContain('customer'); expect(document.body.textContent).toContain('amount');
  const type = async (box: HTMLInputElement, text: string) => React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(box, text); box.dispatchEvent(new Event('input', { bubbles: true })); });
  await type(boxes[0]!, 'acme');
  await click('Advanced: JSON');
  expect(document.querySelector('textarea')!.value).toBe('{"customer":"acme","amount":""}');
  await click('Use the form');
  expect((document.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('acme');
  await type(document.querySelectorAll('input')[1] as HTMLInputElement, '12');
  await click('Continue');
  expect(result).toEqual({ customer: 'acme', amount: '12' });
});

test('a declared field named like an Object.prototype member starts empty and is sent', async () => {
  await React.act(async () => root.render(<Input.InputHost />));
  let result: Record<string, unknown> | null | undefined;
  await React.act(async () => { void Input.manualRunInput(undefined, ['toString', 'constructor']).then(value => { result = value; }); });
  const boxes = [...document.querySelectorAll('input')] as HTMLInputElement[];
  expect(boxes.map(box => box.value)).toEqual(['', '']);
  await click('Advanced: JSON');
  expect(document.querySelector('textarea')!.value).toBe('{"toString":"","constructor":""}');
  await click('Use the form');
  await click('Continue');
  expect(result).toEqual({ toString: '', constructor: '' });
});

test('publishing from the existing canvas route reloads authoritative state and enables Run without navigation', async () => {
  const { createWorkflowRooms } = await import('./workflow-rooms');
  const { makeCanvasFixture } = await import('../workflows/canvas/fixtures');
  const { RUN_CAPABILITY } = await import('../workflows/runs/fixtures');
  const fixture = makeCanvasFixture(); let published = false, reads = 0, publications = 0;
  const flowId = 'meeting', versionId = fixture.versionId, scopeId = 'scope';
  const transport = createHostTransport((async (input: any, init: any = {}) => {
    const path = String(input), version = { ...fixture.snapshot().version, state: published ? 'LOCKED' : 'DRAFT' };
    if (path.endsWith('/publish')) { publications++; published = true; return Response.json({ version: { ...version, state: 'LOCKED' } }); }
    if (path === '/api/workflows/meeting') { reads++; return Response.json({ flow: { id: flowId }, latestDraft: published ? null : version, published: published ? version : null, uiMeta: fixture.snapshot().uiMeta }); }
    if (path.endsWith('/versions/' + versionId)) return Response.json(version);
    if (path.includes('/inspection?')) return Response.json({ status: 'ready', data: { scopeId, flowId, versionId } });
    return fixture.request(input, init);
  }) as typeof fetch);
  const rooms = createWorkflowRooms({ scopeId, transport, capabilities: () => RUN_CAPABILITY,
    storage: localStorage, dirty() {}, runInput: async () => null });
  const shell = { mode: 'live', route: { room: 'workflow', selection: { flowId, versionId } },
    theme: 'dark', sidebar: 'expanded', chatOpen: false, navigate() {}, setTheme() {}, setSidebar() {}, setChatOpen() {} } as any;
  const Room = rooms.rooms.workflow!.Body!;
  try {
    await React.act(async () => root.render(<Room shell={shell} />));
    expect(button('Run workflow').disabled).toBe(true); const before = reads;
    await click('Publish version');
    expect(publications).toBe(1); expect(reads).toBeGreaterThan(before);
    expect(button('Run workflow').disabled).toBe(false);
    expect(button('Publish version')).toBeUndefined(); expect(button('Edit a new draft')).toBeTruthy();
  } finally { rooms.retire(); transport.stop(); }
});
