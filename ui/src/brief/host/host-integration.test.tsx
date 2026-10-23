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
