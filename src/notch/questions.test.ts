import { describe, expect, test } from 'bun:test';
import type { HumanRequest, InputField } from '../workflows/runtime/human-input-contract.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import { attachNotchQuestions, notchQuestionShape, questionWords } from './questions.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

let n = 0;
function request(over: Partial<HumanRequest> = {}): HumanRequest {
  return {
    id: `q${++n}`, kind: 'approval', title: 'Send the 30 invoices', prompt: '', fields: [], requestKey: 'k', workflowName: 'Monthly invoices',
    flowId: 'f', runId: 'r', created: Date.now(), deadline: Date.now() + 3_600_000, status: 'pending', answers: null, generation: 0, ...over,
  };
}
const select = (options: string[], key = 'pick'): InputField => ({ key, label: 'Pick', type: 'select', required: true, options });

function harness() {
  const store = new Map<string, HumanRequest>();
  const answers: { id: string; input: Record<string, unknown> }[] = [];
  let refuse: { status: number; error?: string } | null = null;
  const pushed: NotchToPage[] = [];
  const logs: string[] = [];
  const opened: (string | null)[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  const inbox = new NotchInbox(surface, { log: (line) => logs.push(line) });
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const questions = attachNotchQuestions(inbox, {
    pending: () => [...store.values()],
    get: (id) => store.get(id) ?? null,
    answer: (id, input) => {
      if (refuse) return refuse;
      const current = store.get(id);
      if (!current || current.status !== 'pending') return { status: 409, error: 'This request is closed' };
      answers.push({ id, input });
      store.set(id, { ...current, status: input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'submitted' });
      return { status: 200 };
    },
    openDashboard: (from) => { opened.push(from); },
    log: (line) => logs.push(line),
  });
  const line = (): NotchLine | null => surface.current().line;
  return {
    store, answers, questions, logs, opened, line, inbox,
    refuse: (with_: { status: number; error?: string } | null) => { refuse = with_; },
    ask(q: HumanRequest): HumanRequest { store.set(q.id, q); return q; },
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    async sync(): Promise<void> { questions.sync(); await settle(); },
    async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> {
      fromPage({ type: 'answer', id: line()!.id, act, ...more });
      await settle();
    },
  };
}

describe('how a question can be asked on the notch', () => {
  test('approve or reject that fits one line is a yes', () => {
    expect(notchQuestionShape(request())).toEqual({ way: 'yes' });
  });

  test('one choice from a few short options is a row of choices; a yes-or-no field is two', () => {
    expect(notchQuestionShape(request({ kind: 'input', fields: [select(['Warm', 'Short', 'Formal'])] })))
      .toMatchObject({ way: 'choices', options: ['Warm', 'Short', 'Formal'] });
    expect(notchQuestionShape(request({ kind: 'input', fields: [{ key: 'ok', label: 'OK?', type: 'boolean', required: true }] })))
      .toMatchObject({ way: 'choices', options: ['Yes', 'No'], values: [true, false] });
  });

  test('whatever cannot be shown whole points at the dashboard', () => {
    const open = { way: 'open' } as const;
    expect(notchQuestionShape(request({ prompt: 'x'.repeat(200) }))).toEqual(open);
    expect(notchQuestionShape(request({ kind: 'input', fields: [{ key: 't', label: 'Why', type: 'text', required: true }] }))).toEqual(open);
    expect(notchQuestionShape(request({ kind: 'input', fields: [select(['A']), select(['B'], 'second')] }))).toEqual(open);
    expect(notchQuestionShape(request({ kind: 'input', fields: [select(['A', 'B', 'C', 'D', 'E'])] }))).toEqual(open);
    expect(notchQuestionShape(request({ kind: 'input', fields: [select(['A', 'an option far too long to be a button on the notch'])] }))).toEqual(open);
    expect(notchQuestionShape(request({ kind: 'input', fields: [select([])] }))).toEqual(open);
  });

  test('the words are the title, then the prompt when it adds something', () => {
    expect(questionWords({ title: 'Send the invoices', prompt: '' })).toBe('Send the invoices');
    expect(questionWords({ title: 'Send the invoices?', prompt: 'There are 30.' })).toBe('Send the invoices? There are 30.');
    expect(questionWords({ title: 'Send the invoices', prompt: 'There\nare 30.' })).toBe('Send the invoices. There are 30.');
    expect(questionWords({ title: 'Same', prompt: 'Same' })).toBe('Same');
  });
});

describe('a workflow asks', () => {
  test('approve or reject: one yes, a fuse, then the product\'s own answer function, once', async () => {
    const h = harness();
    const q = h.ask(request());
    await h.sync();
    expect(h.said()).toBe('Send the 30 invoices?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'approve', who: 'Monthly invoices', unasked: true });
    await h.answer('yes');
    expect(h.line()).toMatchObject({ kind: 'send' });
    expect(h.answers).toEqual([]);
    await h.answer('done');
    expect(h.answers).toEqual([{ id: q.id, input: { decision: 'approve', generation: 0 } }]);
    expect(h.said()).toBe('Answered. The workflow goes on.');
    await h.answer('done');
    await h.sync();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('the fuse can be taken back, and a line left alone is not a reject', async () => {
    const h = harness();
    h.ask(request());
    await h.sync();
    await h.answer('yes');
    await h.answer('undo');
    expect(h.line()).toMatchObject({ kind: 'offer' });
    await h.answer('fold');
    expect(h.answers).toEqual([]);
    expect(h.count()).toBe(1);
  });

  test('Esc on approve-or-reject rejects it through the same function, and it is gone', async () => {
    const h = harness();
    const q = h.ask(request());
    await h.sync();
    await h.answer('no');
    expect(h.answers).toEqual([{ id: q.id, input: { decision: 'reject', generation: 0 } }]);
    expect(h.store.get(q.id)!.status).toBe('rejected');
    expect(h.line()).toBeNull();
    await h.sync();
    expect(h.count()).toBe(0);
  });

  test('Esc on a choice has no "no" to give: it leaves the notch for good and still waits in the dashboard', async () => {
    const h = harness();
    const q = h.ask(request({ kind: 'input', title: 'Which tone for the reply?', fields: [select(['Warm', 'Short'], 'tone')] }));
    await h.sync();
    await h.answer('no');
    expect(h.answers).toEqual([]);
    expect(h.store.get(q.id)!.status).toBe('pending');
    expect(h.line()).toBeNull();
    // Looked at again and again: it does not come back.
    await h.sync();
    await h.sync();
    expect(h.count()).toBe(0);
    expect(h.line()).toBeNull();
  });

  test('Esc on one that only points at the dashboard takes it off the notch the same way', async () => {
    const h = harness();
    const q = h.ask(request({ kind: 'input', title: 'What should the subject line be?', fields: [{ key: 's', label: 'Subject', type: 'text', required: true }] }));
    await h.sync();
    await h.answer('no');
    await h.sync();
    expect(h.count()).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.store.get(q.id)!.status).toBe('pending');
  });

  test('a few options: the pick is submitted under the field\'s own key', async () => {
    const h = harness();
    const q = h.ask(request({ kind: 'input', title: 'Which tone for the reply?', fields: [select(['Warm', 'Short', 'Formal'], 'tone')] }));
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'offer', options: ['Warm', 'Short', 'Formal'] });
    await h.answer('pick', { option: 'Short', index: 1 });
    expect(h.said()).toBe('Answering Short…');
    await h.answer('done');
    expect(h.answers).toEqual([{ id: q.id, input: { decision: 'submit', generation: 0, answers: { tone: 'Short' } } }]);
  });

  test('a yes-or-no field is answered with true or false, not with a word', async () => {
    const h = harness();
    h.ask(request({ kind: 'input', title: 'Include the attachments?', fields: [{ key: 'attach', label: 'Attach', type: 'boolean', required: true }] }));
    await h.sync();
    await h.answer('pick', { option: 'No', index: 1 });
    await h.answer('done');
    expect(h.answers[0]!.input.answers).toEqual({ attach: false });
  });

  test('a pick that names no option is not an answer', async () => {
    const h = harness();
    h.ask(request({ kind: 'input', fields: [select(['A', 'B'])] }));
    await h.sync();
    await h.answer('pick', { option: 'Z', index: 7 });
    expect(h.answers).toEqual([]);
    expect(h.count()).toBe(1);
  });

  test('one that needs typing points at the dashboard, and yes opens it without answering', async () => {
    const h = harness();
    h.ask(request({ kind: 'input', title: 'What should the subject line be?', fields: [{ key: 's', label: 'Subject', type: 'text', required: true }] }));
    await h.sync();
    expect(h.said()).toBe('Needs an answer in the dashboard: What should the subject line be?');
    expect(h.line()).toMatchObject({ yes: 'open' });
    await h.answer('yes');
    expect(h.opened).toEqual(['pc']);
    expect(h.answers).toEqual([]);
  });

  test('answered in the dashboard while the notch shows it: the line leaves by itself', async () => {
    const h = harness();
    const q = h.ask(request());
    await h.sync();
    h.store.set(q.id, { ...q, status: 'approved' });
    await h.sync();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('answered elsewhere during the fuse: the notch says so, and does not answer a second time', async () => {
    const h = harness();
    const q = h.ask(request());
    await h.sync();
    await h.answer('yes');
    h.store.set(q.id, { ...q, status: 'rejected' });
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'send' });
    await h.answer('done');
    expect(h.said()).toBe('Already answered somewhere else.');
    expect(h.answers).toEqual([]);
  });

  test('an answer the product refuses is said, and the question still waits', async () => {
    const h = harness();
    h.ask(request());
    await h.sync();
    h.refuse({ status: 422, error: 'Check the highlighted answers' });
    await h.answer('yes');
    await h.answer('done');
    expect(h.said()).toBe('It did not take that answer. Open it in the dashboard.');
    expect(h.logs.some((l) => l.includes('refused the answer (422)'))).toBe(true);
    await h.answer('done');
    expect(h.count()).toBe(1);
  });

  test('a form reopened after it closed is a new question', async () => {
    const h = harness();
    const q = h.ask(request({ created: Date.now() - 600_000 }));
    await h.sync();
    expect(h.count()).toBe(1);
    h.store.set(q.id, { ...q, generation: 1, created: Date.now() });
    await h.sync();
    expect(h.inbox.waiting().map((i) => i.id)).toEqual([`question:${q.id}:1`]);
  });

  test('one that was already waiting when the notch came up joins the count quietly', async () => {
    const h = harness();
    h.ask(request({ created: Date.now() - 600_000 }));
    await h.sync();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });
});
