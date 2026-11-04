import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { HumanRequest } from '../../../../src/workflows/runtime/human-input-contract';
import { createHostTransport } from './http';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let Forms: typeof import('./HumanInputs');
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeAll(async () => { GlobalRegistrator.register({ url: 'http://localhost:3198/' }); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client')); Forms = await import('./HumanInputs'); });
beforeEach(() => { sessionStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
const request: HumanRequest = { id: 'test-request', kind: 'input', title: 'Daily update', prompt: 'What changed today?', requestKey: '2026-11-04', workflowName: 'Daily operations', flowId: 'flow', runId: 'run', created: Date.now(), deadline: Date.now()+172800000, status: 'pending', answers: null,
  fields: [{ key: 'progress', label: 'Progress', type: 'long_text', required: true }, { key: 'count', label: 'Count', type: 'number', required: true }, { key: 'blocked', label: 'Blocked', type: 'boolean', required: true }] };
async function change(selector: string, value: string) { const element = host.querySelector(selector) as HTMLInputElement;
  await React.act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
async function click(name: string) { await React.act(async () => { const button = [...host.querySelectorAll('button')].find(b => b.textContent === name)!; expect(button).toBeTruthy(); button.click(); }); }
test('form supplies visible labels, required validation, zero and false, keeps draft across remount and submits once', async () => {
  let writes: any[] = [], refreshes = 0;
  const http = createHostTransport((async (_url, init) => { writes.push(JSON.parse(String(init?.body))); return Response.json({ request: { ...request, status: 'submitted' } }); }) as typeof fetch);
  const render = () => root.render(<Forms.HumanInputForm request={request} http={http} changed={async () => { refreshes++; }} />);
  await React.act(async () => render()); await click('Submit update'); expect(writes).toHaveLength(0); expect(host.querySelectorAll('[aria-invalid="true"]')).toHaveLength(3);
  await change('textarea', 'Fixture update'); await change('input[type="number"]', '0'); await change('select', 'false');
  await React.act(async () => root.render(null)); await React.act(async () => render());
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Fixture update');
  await React.act(async () => { const button = host.querySelector('button[type="submit"]') as HTMLButtonElement; button.click(); button.click(); });
  expect(writes).toEqual([{ decision: 'submit', answers: { progress: 'Fixture update', count: 0, blocked: false } }]); expect(refreshes).toBe(1);
  expect(host.textContent).toContain('Response saved: submitted'); expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toBeNull();
});
test('unconfirmed transport retains typed answers and asks for status reconciliation', async () => {
  let reads = 0;
  const http = createHostTransport((async () => { throw Error('Connection lost after commit'); }) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputForm request={request} http={http} changed={async () => { reads++; }} />));
  await change('textarea', 'Keep this answer'); await change('input[type="number"]', '0'); await change('select', 'false'); await click('Submit update');
  expect(host.textContent).toContain('could not be confirmed'); expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toContain('Keep this answer'); expect(reads).toBe(1);
});
test('approval exposes exact proposal, occurrence and explicit reject rather than a generic permission button', async () => {
  const writes: unknown[] = [];
  const http = createHostTransport((async (_url, init) => { writes.push(JSON.parse(String(init?.body))); return Response.json({ request: { ...request, status: 'rejected' } }); }) as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputForm request={{ ...request, kind: 'approval', prompt: 'Approve the local plan for Wednesday. No external action.', fields: [] }} http={http} changed={async () => {}} />));
  expect(host.textContent).toContain('Approve the local plan for Wednesday'); expect(host.textContent).toContain('2026-11-04');
  await click('Reject request'); expect(writes).toEqual([{ decision: 'reject' }]); expect(host.textContent).toContain('Response saved: rejected');
});
test('a required text answer of only whitespace is refused before anything is sent', async () => {
  const writes: unknown[] = [];
  const http = createHostTransport((async (_url, init) => { writes.push(init?.body); return Response.json({}); }) as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputForm request={request} http={http} changed={async () => {}} />));
  await change('textarea', '   \n  '); await change('input[type="number"]', '1'); await change('select', 'true'); await click('Submit update');
  expect(writes).toHaveLength(0); expect(host.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true');
});
test('the request a Needs you link names is focused', async () => {
  const other = { ...request, id: 'other-request', title: 'Other update' };
  const queue = { requests: [other, request], error: '', refresh: async () => {} };
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputInbox queue={queue} http={http} focusId="test-request" />));
  expect(document.activeElement?.getAttribute('aria-labelledby')).toBe('human-title-test-request');
});
test('the queue does not poll while the decisions capability is off', async () => {
  let reads = 0;
  const http = createHostTransport((async () => { reads++; return Response.json({ requests: [] }); }) as unknown as typeof fetch);
  function Probe({ enabled }: { enabled: boolean }) { const queue = Forms.useHumanInputQueue(http, enabled); return <p>{queue.requests.length}</p>; }
  await React.act(async () => root.render(<Probe enabled={false} />)); expect(reads).toBe(0);
  await React.act(async () => root.render(<Probe enabled />)); expect(reads).toBe(1);
});
