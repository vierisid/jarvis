import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window, HTMLTextAreaElement } from 'happy-dom';
import { initWorkflowDb } from '../src/workflows/db/index.ts';
import { closeDb } from '../src/vault/schema.ts';
import { createSuggestion } from '../src/vault/awareness.ts';
import { getSuggestionLearning } from '../src/awareness/suggestion-feedback.ts';
import { createSuggestionFeedbackRoutes } from '../src/awareness/suggestion-feedback-routes.ts';
import { SuggestionComposer } from '../src/awareness/suggestion-composer.ts';

const html = await Bun.file(new URL('./overlay.html', import.meta.url)).text();
let window: Window;
let socket: any;
let suggestion: ReturnType<typeof createSuggestion>;
let worker: SuggestionComposer | undefined;
let sent: unknown[];
let failDismiss = false;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function mount() {
  if (window) await window.happyDOM.close();
  window = new Window({ url: 'http://localhost/overlay' });
  sent = [];
  (window as any).WebSocket = class {
    static OPEN = 1; readyState = 1; onmessage: any;
    constructor() { socket = this; }
    send(value: string) { sent.push(JSON.parse(value)); }
  };
  const routes = createSuggestionFeedbackRoutes(() => worker) as Record<string, Record<string, (req: any) => Promise<Response>>>;
  window.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.startsWith('/api/goals')) return Response.json([]);
    if (failDismiss && url.endsWith('/dismiss')) return Response.json({ error: 'Could not save dismissal' }, { status: 500 });
    const route = Object.keys(routes).find(key => key.replace(':id', suggestion.id) === url.split('?')[0]);
    if (!route) return Response.json({}, { status: 404 });
    const req = Object.assign(new Request(`http://localhost${url}`, options), { params: { id: suggestion.id } });
    return routes[route]![options.method ?? 'GET']!(req);
  }) as any;
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ''));
  // Execute the checked-in script with browser bindings, without replacing process globals.
  const bindings = { window, document: window.document, location: window.location,
    WebSocket: window.WebSocket, fetch: window.fetch, FormData: window.FormData,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window) };
  new Function(...Object.keys(bindings), html.match(/<script>([\s\S]*?)<\/script>/)![1]!)(...Object.values(bindings));
  await flush();
}
beforeEach(async () => {
  initWorkflowDb(); failDismiss = false;
  suggestion = createSuggestion({ type: 'automation', title: 'Review invoices', body: 'Invoice checks recur.',
    context: { opportunity: { patternKey: 'job-v1:invoice_review' } } });
  await mount();
});
afterEach(async () => { worker?.stop(); await worker?.idle(); worker = undefined; await window.happyDOM.close(); closeDb(); });
function emitSuggestion() {
  socket.onmessage({ data: JSON.stringify({ type: 'notification', payload: { source: 'awareness_event',
    event: { type: 'suggestion_ready', data: { id: suggestion.id, type: 'automation', title: suggestion.title, body: suggestion.body } } } }) });
}
function button(label: string) {
  const el = Array.from(window.document.querySelectorAll('button')).find(b => b.textContent === label);
  if (!el) throw new Error(`Missing button: ${label}. Page: ${window.document.body.textContent}`);
  return el;
}

test('chat notification copy preserves the suggestion ID; acceptance saves a job without sending a chat command', async () => {
  emitSuggestion();
  socket.onmessage({ data: JSON.stringify({ type: 'chat', priority: 'urgent', payload: { source: 'proactive',
    text: `**${suggestion.title}**\n${suggestion.body}` } }) });
  button('Draft a routine').click(); await flush();
  const form = window.document.querySelector('form')!;
  expect(form).not.toBeNull();
  form.querySelector<HTMLTextAreaElement>('[name="description"]')!.value = 'Collect invoices for review';
  form.querySelector<HTMLTextAreaElement>('[name="expectedOutcome"]')!.value = 'List invoices needing attention';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush();
  expect(getSuggestionLearning(suggestion.id).composition?.state).toBe('queued');
  expect(sent).toHaveLength(0);
  expect(window.document.body.textContent).toContain('request is saved');
});

test('failed composition survives reopening the overlay, can retry and opens the linked draft', async () => {
  emitSuggestion(); button('Draft a routine').click(); await flush();
  const form = window.document.querySelector('form')!;
  form.querySelector<HTMLTextAreaElement>('[name="description"]')!.value = 'Review invoices';
  form.querySelector<HTMLTextAreaElement>('[name="expectedOutcome"]')!.value = 'Review summary';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush();
  worker = new SuggestionComposer(async () => ({ ok: false, errors: ['Connect invoice service first'], rawResponse: null }));
  worker.start(); await worker.idle(); worker.stop();
  await mount();
  button('Review invoices: Needs attention').click(); await flush();
  expect(window.document.body.textContent).toContain('Connect invoice service');
  worker = new SuggestionComposer(async () => ({ ok: true, rawResponse: '',
    flow: { displayName: 'Review invoices', trigger: { type: 'EMPTY', name: 'trigger' } } }));
  worker.start(); await worker.idle();
  button('Retry composition').click(); await flush(); await worker.idle();
  await mount(); button('Review invoices: Draft ready').click(); await flush();
  let opened = '';
  window.open = ((url: string) => { opened = url; }) as any;
  button('Review draft').click(); await flush();
  expect(opened).toContain(getSuggestionLearning(suggestion.id).composition!.workflowId!);
  expect(opened).toContain('#/_room_workflows');
});

test('a failed dismissal stays visible and a successful retry records its reason', async () => {
  emitSuggestion(); failDismiss = true;
  (window as any).prompt = () => 'This job is already automated';
  button('Dismiss').click(); await flush();
  expect(window.document.body.textContent).toContain('Could not save dismissal');
  expect(getSuggestionLearning(suggestion.id).status).toBe('proposed');
  failDismiss = false; button('Dismiss').click(); await flush();
  expect(getSuggestionLearning(suggestion.id).feedback[0]?.reason).toBe('This job is already automated');
});
