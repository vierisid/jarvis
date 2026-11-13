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
  expect(writes).toEqual([{ decision: 'submit', generation: 0, answers: { progress: 'Fixture update', count: 0, blocked: false } }]); expect(refreshes).toBe(1);
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
  await click('Reject request'); expect(writes).toEqual([{ decision: 'reject', generation: 0 }]); expect(host.textContent).toContain('Response saved: rejected');
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
test('the queue reports loaded only after a successful read, so an unread queue is never counted as empty', async () => {
  let fail = true, loaded: boolean | undefined, refresh = async () => {};
  const http = createHostTransport((async () => fail ? new Response('down', { status: 500 }) : Response.json({ requests: [] })) as unknown as typeof fetch);
  function Probe() { const queue = Forms.useHumanInputQueue(http); loaded = queue.loaded; refresh = queue.refresh; return null; }
  await React.act(async () => root.render(<Probe />)); await React.act(async () => { await refresh(); }); expect(loaded).toBe(false);
  fail = false; await React.act(async () => { await refresh(); }); expect(loaded).toBe(true);
});
test('Today waits on input requests, unread workflow messages, voice confirmations and live approvals the decisions list does not show', () => {
  const live = { connected: true, inputsKnown: true, inputs: 0, stored: 0, clarifiers: 0, repeatBacks: 0, approvals: 0, decisionsListed: true };
  expect(Forms.ownerAttentionCount(live)).toBe(0);
  expect(Forms.ownerAttentionCount({ ...live, inputs: 1, stored: 1, clarifiers: 1, repeatBacks: 1 })).toBe(4);
  expect(Forms.ownerAttentionCount({ ...live, approvals: 2 })).toBe(0);
  expect(Forms.ownerAttentionCount({ ...live, approvals: 2, decisionsListed: false })).toBe(2);
  expect(Forms.ownerAttentionCount({ ...live, connected: false })).toBeNull();
  expect(Forms.ownerAttentionCount({ ...live, inputsKnown: false })).toBeNull();
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
  await click('Cancel this request'); expect(writes).toEqual([{ decision: 'cancel', generation: 0 }]);
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

test('reopening a shared request never prefills or submits the expired generation draft', async () => {
  const writes: any[] = [];
  const http = createHostTransport((async (_url, init) => { writes.push(JSON.parse(String(init?.body))); return Response.json({ request: { ...request, status: 'submitted' } }); }) as typeof fetch);
  const render = (value: HumanRequest) => root.render(<Forms.HumanInputInbox queue={{ requests: [value], error: '', refresh: async () => {} }} http={http} />);
  await React.act(async () => render(request)); await change('textarea', 'Old response');
  await React.act(async () => render({ ...request, status: 'expired' }));
  await React.act(async () => render({ ...request, generation: 1, runId: 'next-run' }));
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toContain('Old response');
  await change('textarea', 'New response'); await change('input[type="number"]', '0'); await change('select', 'false');
  await click('Submit update'); expect(writes).toEqual([{ decision: 'submit', generation: 1, answers: { progress: 'New response', count: 0, blocked: false } }]);
  expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toContain('Old response');
});

test('a submitted answer has a read-only copyable receipt with zero and false', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  const http = createHostTransport((async () => { throw Error('No write expected'); }) as unknown as typeof fetch);
  const receipt = { ...request, status: 'submitted' as const, answers: { progress: 'Accepted handover', count: 0, blocked: false } };
  await React.act(async () => root.render(<Forms.HumanInputForm request={receipt} http={http} changed={async () => {}} />));
  expect(host.textContent).toContain('Accepted handover'); expect(host.textContent).toContain('Submitted answers');
  await click('Copy submitted answers'); expect(copied).toContain('Count: 0'); expect(copied).toContain('Blocked: false');
  expect(host.querySelector('button[type="submit"]')).toBeNull();
});
test('an unsent answer survives leaving the recent list and a full UI remount', async () => {
  const http = createHostTransport((async () => Response.json({ request: { ...request, status: 'cancelled' } })) as unknown as typeof fetch);
  const render = (requests: HumanRequest[]) => root.render(<Forms.HumanInputInbox queue={{ requests, error: '', refresh: async () => {} }} http={http} />);
  await React.act(async () => render([request])); await change('textarea', 'Recover beyond history');
  await React.act(async () => render([{ ...request, status: 'cancelled' }]));
  await React.act(async () => render([]));
  expect((host.querySelector('textarea') as HTMLTextAreaElement)?.value).toBe('Recover beyond history');
  await React.act(async () => root.render(null)); await React.act(async () => render([]));
  expect((host.querySelector('textarea') as HTMLTextAreaElement)?.value).toBe('Recover beyond history');
  expect(host.querySelector('button[type="submit"]')).toBeNull();
});
test('a deep link loads a request outside recent history and older responses can be paged', async () => {
  const urls: string[] = [];
  const old = { ...request, id: 'old', status: 'submitted' as const, answers: { progress: 'Old accepted answer', count: 0, blocked: false } };
  const http = createHostTransport((async (url) => {
    urls.push(String(url));
    return Response.json(String(url).includes('/history?') ? { requests: [{ ...old, id: 'older' }], nextCursor: null } : { request: old });
  }) as typeof fetch);
  const render = () => root.render(<Forms.HumanInputInbox queue={{ requests: [], error: '', refresh: async () => {}, historyCursor: '[123,"last"]' }} http={http} focusId="old" />);
  await React.act(async () => render());
  expect(host.textContent).toContain('Old accepted answer'); expect(urls[0]).toBe('/api/workflow-inputs/old');
  expect(document.activeElement?.getAttribute('aria-labelledby')).toBe('human-title-old');
  // Each poll hands the inbox a new array; the linked request is not read again for it.
  await React.act(async () => render()); await React.act(async () => render());
  expect(urls.filter(url => url === '/api/workflow-inputs/old')).toHaveLength(1);
  await click('Load older responses'); expect(urls.at(-1)).toContain('/api/workflow-inputs/history?cursor=');
  expect(host.querySelectorAll('article')).toHaveLength(2);
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Load older responses')).toBe(false);
});
test('the queue fetches a locally saved draft beyond the recent page', async () => {
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: 'Beyond page one' }));
  const urls: string[] = [];
  const http = createHostTransport((async (url) => {
    urls.push(String(url));
    return Response.json(String(url).endsWith('/test-request') ? { request: { ...request, status: 'cancelled' } } : { requests: [], historyCursor: null });
  }) as typeof fetch);
  function Probe() { const queue = Forms.useHumanInputQueue(http); return <Forms.HumanInputInbox queue={queue} http={http} />; }
  await React.act(async () => root.render(<Probe />));
  expect(urls).toContain('/api/workflow-inputs/test-request'); expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Beyond page one');
  expect(host.querySelector('button[type="submit"]')).toBeNull();
});
test('a recovered earlier draft remains separate and copyable after a new generation is answered', async () => {
  const { rememberDraft } = await import('./human-input-drafts'); rememberDraft({ ...request, status: 'expired' });
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: 'Earlier unsent' }));
  const current = { ...request, generation: 1, status: 'submitted' as const, answers: { progress: 'New accepted', count: 0, blocked: false } };
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputInbox queue={{ requests: [current], error: '', refresh: async () => {} }} http={http} />));
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Earlier unsent');
  expect(host.textContent).toContain('New accepted'); expect(host.textContent).toContain('earlier or unavailable request');
  expect(host.querySelector('button[type="submit"]')).toBeNull();
  await click('Discard unsent answers'); expect(sessionStorage.getItem('jarvis:workflow-input:test-request')).toBeNull();
});
test('a superseded or unlisted request with nothing typed shows no unsent-answer card', async () => {
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  const render = (requests: HumanRequest[]) => root.render(<Forms.HumanInputInbox queue={{ requests, error: '', refresh: async () => {} }} http={http} />);
  await React.act(async () => render([request]));
  await React.act(async () => render([{ ...request, status: 'expired' }]));
  await React.act(async () => render([{ ...request, generation: 1, runId: 'next-run' }]));
  expect(host.querySelectorAll('article')).toHaveLength(1); expect(host.textContent).not.toContain('Unsent answer');
  // A pending request the server stops listing, with nothing typed, leaves no card either.
  await React.act(async () => render([]));
  expect(host.querySelector('article')).toBeNull();
});
test('answers held only in memory keep their card when browser storage lost them, until discarded', async () => {
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  const render = (requests: HumanRequest[]) => root.render(<Forms.HumanInputInbox queue={{ requests, error: '', refresh: async () => {} }} http={http} />);
  await React.act(async () => render([request])); await change('textarea', 'Only in memory');
  sessionStorage.clear();
  await React.act(async () => render([{ ...request, generation: 1, runId: 'next-run' }]));
  expect(host.textContent).toContain('Unsent answer');
  expect([...host.querySelectorAll('textarea')].map(t => (t as HTMLTextAreaElement).value)).toContain('Only in memory');
  await click('Discard unsent answers');
  expect(host.querySelectorAll('article')).toHaveLength(1); expect(host.textContent).not.toContain('Unsent answer');
});
test('a draft whose request is gone is read once, then stays copyable and discardable without polling for it', async () => {
  sessionStorage.setItem('jarvis:workflow-input:gone-request', JSON.stringify({ progress: 'Typed before it vanished' }));
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  const urls: string[] = [];
  const http = createHostTransport((async (url) => {
    urls.push(String(url));
    return String(url).endsWith('/gone-request') ? Response.json({ error: 'Request not found' }, { status: 404 }) : Response.json({ requests: [], historyCursor: null });
  }) as typeof fetch);
  let queue!: ReturnType<typeof Forms.useHumanInputQueue>;
  function Probe() { queue = Forms.useHumanInputQueue(http); return <Forms.HumanInputInbox queue={queue} http={http} />; }
  await React.act(async () => root.render(<Probe />));
  for (let i = 0; i < 3; i++) await React.act(async () => { await queue.refresh(); });
  expect(urls.filter(url => url.endsWith('/gone-request'))).toHaveLength(1);
  expect(urls.filter(url => url === '/api/workflow-inputs')).toHaveLength(4);
  expect(host.textContent).toContain('no longer available'); expect(host.querySelector('button[type="submit"]')).toBeNull();
  await click('Copy unsent answers'); expect(copied).toContain('Typed before it vanished');
  await click('Discard unsent answers');
  expect(sessionStorage.getItem('jarvis:workflow-input:gone-request')).toBeNull(); expect(host.querySelector('article')).toBeNull();
});
test('a draft request read once beyond the page is not read again on each poll', async () => {
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: 'Beyond page one' }));
  const urls: string[] = [];
  const http = createHostTransport((async (url) => {
    urls.push(String(url));
    return Response.json(String(url).endsWith('/test-request') ? { request: { ...request, status: 'cancelled' } } : { requests: [], historyCursor: null });
  }) as typeof fetch);
  let queue!: ReturnType<typeof Forms.useHumanInputQueue>;
  function Probe() { queue = Forms.useHumanInputQueue(http); return <Forms.HumanInputInbox queue={queue} http={http} />; }
  await React.act(async () => root.render(<Probe />));
  for (let i = 0; i < 3; i++) await React.act(async () => { await queue.refresh(); });
  expect(urls.filter(url => url.endsWith('/test-request'))).toHaveLength(1);
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Beyond page one');
});
test('a retained closed card leaves once its draft is discarded and the server stops listing it', async () => {
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  const render = (requests: HumanRequest[]) => root.render(<Forms.HumanInputInbox queue={{ requests, error: '', refresh: async () => {} }} http={http} />);
  await React.act(async () => render([request])); await change('textarea', 'Typed then discarded');
  await React.act(async () => render([{ ...request, status: 'expired' }]));
  await click('Discard unsent answers');
  await React.act(async () => render([]));
  expect(host.querySelector('article')).toBeNull();
});
test('a recovered card leaves as soon as its answers are discarded', async () => {
  const { rememberDraft } = await import('./human-input-drafts'); rememberDraft({ ...request, status: 'expired' });
  sessionStorage.setItem('jarvis:workflow-input:test-request', JSON.stringify({ progress: 'Recovered only' }));
  const http = createHostTransport((async () => Response.json({})) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputInbox queue={{ requests: [], error: '', refresh: async () => {} }} http={http} />));
  expect(host.textContent).toContain('Unsent answer');
  await click('Discard unsent answers');
  expect(host.querySelector('article')).toBeNull();
});
test('history keeps a response that a new close pushes off the recent page after older pages loaded', async () => {
  const closed = (id: string, closedAt: number) => ({ ...request, id, status: 'submitted' as const, answers: { progress: id }, closedAt, runs: [{ runId: 'run', versionId: 'v', status: 'SUCCEEDED' }] });
  const http = createHostTransport((async () => Response.json({ requests: [closed('c3', 3)], nextCursor: null })) as unknown as typeof fetch);
  const render = (requests: HumanRequest[]) => root.render(<Forms.HumanInputInbox queue={{ requests, error: '', refresh: async () => {}, historyCursor: '[3,"c3"]' }} http={http} />);
  await React.act(async () => render([closed('c5', 5), closed('c4', 4)]));
  await click('Load older responses');
  // c6 closes; the page now ends at c5 and c4 is neither on it nor on the loaded page.
  await React.act(async () => render([closed('c6', 6), closed('c5', 5)]));
  expect(host.querySelectorAll('article')).toHaveLength(4);
  expect(host.textContent).toContain('Response history (4)');
});
test('a deep link that is not found says so, and Check again reads it again', async () => {
  let reads = 0;
  const http = createHostTransport((async () => { reads++; return Response.json({ error: 'Request not found' }, { status: 404 }); }) as unknown as typeof fetch);
  await React.act(async () => root.render(<Forms.HumanInputInbox queue={{ requests: [], error: '', refresh: async () => {} }} http={http} focusId="missing" />));
  expect(host.textContent).toContain('was not found in this workspace'); expect(reads).toBe(1);
  await click('Check again'); expect(reads).toBe(2);
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
