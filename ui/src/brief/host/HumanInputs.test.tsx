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

test('request links resolve to the actual Brief run route with the selected run and version', async () => {
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputForm request={{...request, runs:[{runId:'run / one', versionId:'version', status:'PAUSED'}]}} http={http} changed={async()=>{}} />));
  const { resolveBriefEntry } = await import('../entry/route');
  const link = host.querySelector('a')!;
  expect(resolveBriefEntry(link.href)).toEqual({kind:'brief',route:{room:'workflow-runs',selection:{flowId:'flow',versionId:'version',runId:'run / one'}}});
});
test('failed continuation stays visible outside collapsed history after submission and refresh', async () => {
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  const failed = {...request,status:'submitted' as const,answers:{progress:'Saved'},runs:[{runId:'run',versionId:'v',status:'FAILED'}]};
  await React.act(async () => root.render(<Forms.HumanInputInbox queue={{requests:[failed],error:'',refresh:async()=>{}}} http={http} />));
  expect(host.textContent).toContain('Workflow failed. Review the run before retrying.');
  expect(host.querySelector('article')?.closest('details')).toBeNull();
  expect(host.querySelector('button[type="submit"]')).toBeNull();
  expect(host.querySelector('a')?.href).toContain('runId=run');
});

test('expiry keeps the focused unsent form readable, copyable and recoverable after remount without another POST', async () => {
  let writes=0, copied='';
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied=text;}}});
  const http = createHostTransport((async () => {writes++; return Response.json({});}) as unknown as typeof fetch);
  const render=(status:HumanRequest['status'])=>root.render(<Forms.HumanInputInbox queue={{requests:[{...request,status}],error:'',refresh:async()=>{}}} http={http} />);
  await React.act(async()=>render('pending')); await change('textarea','Keep my detailed update'); await change('input[type="number"]','0'); await change('select','false');
  const textarea=host.querySelector('textarea') as HTMLTextAreaElement; textarea.focus();
  await React.act(async()=>render('expired'));
  expect(document.activeElement).toBe(textarea); expect(textarea.readOnly).toBe(true); expect(textarea.value).toBe('Keep my detailed update');
  expect(host.textContent).toContain('deadline passed'); expect(host.querySelector('button[type="submit"]')).toBeNull();
  await click('Copy unsent answers'); expect(copied).toContain('Count: 0'); expect(copied).toContain('Blocked: false'); expect(writes).toBe(0);
  await React.act(async()=>root.render(null)); await React.act(async()=>render('expired'));
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Keep my detailed update');
  await click('Discard unsent answers'); expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toBeNull(); expect(host.querySelector('textarea')).toBeNull();
});
test('cancelled stale requests retain unsent text and explain why the answer was not accepted', async()=>{
  sessionStorage.setItem('jarvis:workflow-input:test-request',JSON.stringify({progress:'Do not lose this'}));
  const http=createHostTransport((async()=>Response.json({})) as unknown as typeof fetch);
  await React.act(async()=>root.render(<Forms.HumanInputInbox queue={{requests:[{...request,status:'cancelled',closureReason:'workflow_changed'}],error:'',refresh:async()=>{}}} http={http}/>));
  expect(host.textContent).toContain('Your answer was not accepted');expect(host.querySelector('button[type="submit"]')).toBeNull();
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Do not lose this');
});
test('an emptied draft is no unsent answer, and an explicit cancel clears the draft', async () => {
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: '  ', count: '' }));
  expect(Forms.hasLocalDraft(request)).toBe(false);
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: 'Half written' }));
  expect(Forms.hasLocalDraft(request)).toBe(true);
  const writes: unknown[] = [];
  const http = createHostTransport((async (_url, init) => { writes.push(JSON.parse(String(init?.body))); return Response.json({ request: { ...request, status: 'cancelled' } }); }) as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputForm request={request} http={http} changed={async () => {}} />));
  await click('Cancel this request'); expect(writes).toEqual([{ decision: 'cancel' }]);
  expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toBeNull();
  await React.act(async () => root.render(<Forms.HumanInputForm request={{ ...request, status: 'cancelled' }} http={http} changed={async () => {}} />));
  expect(host.textContent).not.toContain('unsent answers');
});
test('a request answered in another tab does not show this tab\'s draft as unsent', async () => {
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: 'Typed here, answered elsewhere' }));
  const answered = { ...request, status: 'submitted' as const, answers: { progress: 'Sent elsewhere' }, runs: [{ runId: 'run', versionId: 'v', status: 'SUCCEEDED' }] };
  expect(Forms.hasLocalDraft(answered)).toBe(false);
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputInbox queue={{ requests: [answered], error: '', refresh: async () => {} }} http={http} />));
  expect(host.textContent).not.toContain('unsent answers'); expect(host.querySelector('textarea')).toBeNull();
});
test('a stopped run needs nothing; a failed one stays until dismissed on the server', async () => {
  const { humanRequestNeedsAttention } = await import('../../../../src/workflows/runtime/human-input-contract');
  const stopped = { ...request, status: 'submitted' as const, runs: [{ runId: 'run', versionId: 'v', status: 'STOPPED' }] };
  const failed = { ...stopped, runs: [{ runId: 'run', versionId: 'v', status: 'FAILED' }] };
  expect(humanRequestNeedsAttention(stopped)).toBe(false); expect(humanRequestNeedsAttention(failed)).toBe(true);
  expect(humanRequestNeedsAttention({ ...failed, dismissedAt: 1 })).toBe(false);
  const urls: string[] = []; let refreshes = 0;
  const http = createHostTransport((async (url) => { urls.push(String(url)); return Response.json({ request: { ...failed, dismissedAt: 1 } }); }) as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputForm request={stopped} http={http} changed={async () => {}} />));
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Dismiss')).toBe(false);
  await React.act(async () => root.render(<Forms.HumanInputForm request={failed} http={http} changed={async () => { refreshes++; }} />));
  await click('Dismiss'); expect(urls.at(-1)).toContain('/api/workflow-inputs/test-request/dismiss'); expect(refreshes).toBe(1);
  expect(host.textContent).toContain('no longer needs you');
  await React.act(async () => root.render(<Forms.HumanInputForm request={{ ...failed, runs: [{ runId: 'run-2', versionId: 'v', status: 'RUNNING' }, ...failed.runs] }} http={http} changed={async () => {}} />));
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Dismiss')).toBe(false);
});
test('a dismissed request with a kept draft no longer counts, and an answered one drops its stale draft', async () => {
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: 'Kept after withdrawal' }));
  const withdrawn = { ...request, status: 'cancelled' as const, closureReason: 'workflow_changed' as const };
  expect(Forms.hasLocalDraft(withdrawn)).toBe(true); expect(Forms.hasLocalDraft({ ...withdrawn, dismissedAt: 1 })).toBe(false);
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputForm request={{ ...request, status: 'submitted', runs: [{ runId: 'run', versionId: 'v', status: 'SUCCEEDED' }] }} http={http} changed={async () => {}} />));
  expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toBeNull();
});

test('a submitted answer held by global pause explains why it has not continued', async () => {
  const { EmergencyStatusContext } = await import('./EmergencyStatus');
  const http = createHostTransport((async()=>{throw new Error('No write expected');}) as unknown as typeof fetch);
  const held = { ...request, status:'submitted' as const, runs:[{runId:'run',versionId:'version',status:'PAUSED'}] };
  await React.act(async()=>root.render(<EmergencyStatusContext.Provider value="paused"><Forms.HumanInputForm request={held} http={http} changed={async()=>{}} /></EmergencyStatusContext.Provider>));
  expect(host.textContent).toContain('Global emergency pause is holding this workflow');
  expect(host.textContent).toContain('Saved responses will continue');
  expect(host.querySelector('a')?.href).toContain('runId=run');
});

test('a queued continuation held by global pause says so, and reads as continuing once resumed', async () => {
  const { EmergencyStatusContext } = await import('./EmergencyStatus');
  const http = createHostTransport((async()=>{throw new Error('No write expected');}) as unknown as typeof fetch);
  const queued = { ...request, status:'submitted' as const, runs:[{runId:'run',versionId:'version',status:'QUEUED'}] };
  await React.act(async()=>root.render(<EmergencyStatusContext.Provider value="paused"><Forms.HumanInputForm request={queued} http={http} changed={async()=>{}} /></EmergencyStatusContext.Provider>));
  expect(host.textContent).toContain('Global emergency pause is holding this workflow');
  expect(host.textContent).not.toContain('Workflow is continuing.');
  await React.act(async()=>root.render(<EmergencyStatusContext.Provider value="normal"><Forms.HumanInputForm request={queued} http={http} changed={async()=>{}} /></EmergencyStatusContext.Provider>));
  expect(host.textContent).toContain('Workflow is continuing.');
  expect(host.textContent).not.toContain('Global emergency pause');
});
