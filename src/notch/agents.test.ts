import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  NOTCH_AGENT_GOOD_RUNS, NotchAgentStore, agentFull, agentKey, agentSentence, agentsListRequest, attachNotchAgents, type NotchAgentWorkflows,
} from './agents.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');

type Built = Awaited<ReturnType<NotchAgentWorkflows['build']>>;

function harness(options: { build?: (sentence: string) => Built | Promise<Built>; enable?: { ok: false; why: string }; paused?: () => boolean; db?: Database } = {}) {
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, _params) { void (_params as { message: NotchToPage }); return Promise.resolve({}); },
    onEvent(listener) { toSurface = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 1_000_000;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => toSurface('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  /** The workflows of the product, as far as an agent needs them. */
  const flows = new Map<string, { job: string; enabled: boolean; runs: { id: string; end: 'ok' | 'bad' | 'open'; at: number }[]; madeAt?: number; ready?: boolean; missing?: string }>();
  const did: string[] = [];
  let made = 0;
  const workflows: NotchAgentWorkflows = {
    async build(sentence) {
      did.push(`build ${sentence}`);
      const built = options.build ? await options.build(sentence) : { ok: true as const, flowId: `flow-${++made}`, job: sentence.replace(/\.$/, ''), ready: true, missing: '' };
      if (built.ok) flows.set(built.flowId, { job: built.job, enabled: false, runs: [], madeAt: now, ready: built.ready, missing: built.missing });
      return built;
    },
    enable(flowId) { did.push(`enable ${flowId}`); if (options.enable) return options.enable; flows.get(flowId)!.enabled = true; return { ok: true }; },
    pause(flowId, paused) { did.push(`${paused ? 'pause' : 'resume'} ${flowId}`); flows.get(flowId)!.enabled = !paused; return true; },
    run(flowId) { did.push(`run ${flowId}`); return { ok: true }; },
    async remove(flowId) { did.push(`remove ${flowId}`); flows.delete(flowId); return true; },
    look(flowId) { const flow = flows.get(flowId); return flow ? { job: flow.job, enabled: flow.enabled } : null; },
    runs(flowId, limit) { return (flows.get(flowId)?.runs ?? []).slice(0, limit); },
    madeSince(at) {
      return [...flows.entries()].filter(([, flow]) => (flow.madeAt ?? 0) >= at).sort((a, b) => (b[1].madeAt ?? 0) - (a[1].madeAt ?? 0))
        .map(([flowId, flow]) => ({ flowId, job: flow.job, ready: flow.ready !== false, missing: flow.missing ?? '', enabled: flow.enabled }));
    },
  };
  /** The assistant builds something in a turn, as it does when the words were not taken as the notch's own. */
  const assistantBuilds = (job: string, more: { ready?: boolean; missing?: string; enabled?: boolean } = {}): { flowId: string; since: number } => {
    const since = now;
    now += 20_000;
    const flowId = `flow-a${flows.size + 1}`;
    flows.set(flowId, { job, enabled: more.enabled === true, runs: [], madeAt: now, ready: more.ready !== false, missing: more.missing ?? '' });
    now += 5000;
    return { flowId, since };
  };
  const logs: string[] = [];
  const agents = attachNotchAgents({ inbox, db: options.db ?? new Database(':memory:'), workflows, paused: options.paused, now: () => now, log: (line) => logs.push(line) });
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  const pass = async (ms: number): Promise<void> => {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now) { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); timer.fn(); }
    await settle();
  };
  const speak = async (words: string): Promise<string | null> => {
    const route = agents.route(words);
    route?.run();
    await settle();
    return route?.did ?? null;
  };
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await settle();
  };
  /** A run of an agent's workflow that has ended. */
  const ran = (flowId: string, end: 'ok' | 'bad' | 'open' = 'ok'): void => {
    now += 60_000;
    const flow = flows.get(flowId)!;
    flow.runs.unshift({ id: `run-${flow.runs.length + 1}`, end, at: now });
  };
  /** Makes an agent from a sentence, with a yes. */
  const makes = async (sentence = 'Every Monday at 9, send Sam the numbers'): Promise<void> => {
    await speak(sentence);
    await reply('yes');
    await pass(9000);
  };
  /** A yes at rest: the first thing that waits is opened. */
  const opens = async (): Promise<void> => { fromPage({ type: 'open' }); await settle(); };
  return { agents, inbox, did, logs, flows, line, said, pass, speak, reply, ran, makes, opens, assistantBuilds, advance: (ms: number) => { now += ms; } };
}

describe('a sentence that asks for an agent', () => {
  test('"every Monday…" is one, with the schedule it names and the job without it', () => {
    expect(agentSentence('Every Monday send Sam the numbers')).toEqual({ when: 'Monday at 9:00', job: 'send Sam the numbers' });
    expect(agentSentence('every friday at 16:30, post the week in the channel.')).toEqual({ when: 'Friday at 16:30', job: 'post the week in the channel' });
    expect(agentSentence('Every day at 8am check my calendar for clashes')).toEqual({ when: 'day at 8:00', job: 'check my calendar for clashes' });
    expect(agentSentence('Every morning tell me what changed overnight')).toEqual({ when: 'day at 9:00', job: 'tell me what changed overnight' });
    expect(agentSentence('each evening file the receipts of the day')).toEqual({ when: 'day at 18:00', job: 'file the receipts of the day' });
    expect(agentSentence('Daily, send Sam the numbers')).toEqual({ when: 'day at 9:00', job: 'send Sam the numbers' });
    // In "an agent that sends…" the schedule may stand anywhere, and what it does is read back as what to do.
    expect(agentSentence('Make an agent that sends Sam the numbers every week')).toEqual({ when: 'Monday at 9:00', job: 'send Sam the numbers' });
    expect(agentSentence('make me an agent to file my invoices every Friday')).toEqual({ when: 'Friday at 9:00', job: 'file my invoices' });
    expect(agentSentence('Create a workflow to every Friday at 4pm send Anna the report')).toEqual({ when: 'Friday at 16:00', job: 'send Anna the report' });
  });

  // The owner's first agent, 17 November 2026: "Can you make an agent that every day at 5.10 sends me a
  // notification…". It was not taken as one, went to the assistant, and came back as a workflow that was
  // switched off, had no name, and could only be switched on in the dashboard.
  test('however it is put, asking for an agent is asking the notch', () => {
    const news = { when: 'day at 17:10', job: 'send me a notification with the latest AI news' };
    for (const said of [
      'Can you make an agent that every day at 5.10 sends me a notification with the latest AI news',
      'Can you make an agent that every day at 5.10 sends me a notification with the latest AI news?',
      'could you please create an agent which sends me a notification with the latest AI news every day at 5:10 pm',
      'I want an agent that sends me a notification with the latest AI news daily at 17.10',
      'Hey Jarvis, set up a new workflow that every day at 17:10 sends me a notification with the latest AI news.',
      'New agent: every day at 5.10pm send me a notification with the latest AI news',
    ]) expect(agentSentence(said)).toEqual(news);
    // With no "am", an hour from one to six is the afternoon. With one, it is what was said.
    expect(agentSentence('every day at 5.10 am send me the news')).toEqual({ when: 'day at 5:10', job: 'send me the news' });
    expect(agentSentence('every day at 9 send me the news')).toEqual({ when: 'day at 9:00', job: 'send me the news' });
    expect(agentSentence('every day at 3 send me the news')).toEqual({ when: 'day at 15:00', job: 'send me the news' });
    // Asked for as an agent with no schedule: it is one all the same, and is read back as one.
    expect(agentSentence('I want an agent that replies to new leads')).toEqual({ when: null, job: 'replies to new leads', agent: true });
    expect(agentFull({ when: null, job: 'replies to new leads', agent: true })).toBe('An agent that replies to new leads.');
    expect(agentSentence('Can you build me an agent to keep my inbox at zero?')).toEqual({ when: null, job: 'to keep my inbox at zero', agent: true });
    expect(agentFull({ when: null, job: 'to keep my inbox at zero', agent: true })).toBe('An agent to keep my inbox at zero.');
    expect(agentFull(agentSentence('make an agent for my unpaid invoices')!)).toBe('An agent for my unpaid invoices.');
    // "Can you", with a schedule and no word agent, is one too.
    expect(agentSentence('Can you every Monday at 9 send Sam the numbers?')).toEqual({ when: 'Monday at 9:00', job: 'send Sam the numbers' });
  });

  test('one that waits for something to happen has no schedule to read back', () => {
    expect(agentSentence('When an invoice is 7 days late, chase it politely')).toEqual({ when: null, job: 'When an invoice is 7 days late, chase it politely' });
    expect(agentSentence('Before every call, prepare notes')).toEqual({ when: null, job: 'Before every call, prepare notes' });
    expect(agentSentence('Whenever a lead writes in reply within the hour')).toEqual({ when: null, job: 'Whenever a lead writes in reply within the hour' });
  });

  test('a question is not one, nor is something that only sounds like one', () => {
    for (const no of [
      'When is my next call?', 'when does Sam arrive', 'Every time', 'every invoice', 'Every 5 minutes check the build',
      'Make me a coffee', 'What do I do every Monday?', 'Tell me when Sam replies', "Get Sam's answer by Friday", 'When done', '',
      // Said of oneself, with a schedule somewhere in it: not something to take over.
      'I go to the gym every day at 6', 'Can you tell me what I do every Monday?', 'What is an agent?', 'Can you make this shorter?',
    ]) expect(agentSentence(no)).toBeNull();
  });

  test('the list is asked for by name', () => {
    for (const yes of ['Show my agents', 'my agents', 'Show me my agents.', 'list the agents']) expect(agentsListRequest(yes)).toBe(true);
    for (const no of ['Make an agent that files invoices', 'what are agents', 'agents']) expect(agentsListRequest(no)).toBe(false);
  });

  test('two sentences are the same when their words are', () => {
    expect(agentKey('Every Monday at 9:00, send Sam the numbers.')).toBe(agentKey('every monday at 9:00 send sam the numbers'));
    expect(agentKey(agentFull({ when: 'Monday at 9:00', job: 'send Sam the numbers' }))).not.toBe(agentKey(agentFull({ when: 'Friday at 16:00', job: 'send Sam the numbers' })));
  });
});

describe('make an agent', () => {
  // The plan's test, step 3: "Say an agent sentence. It is read back. Yes. It is listed and enabled, and its first run asks first."
  test('the sentence is read back with its schedule lit, one yes builds it and switches it on, and it asks first', async () => {
    const h = harness();
    expect(await h.speak('Every Monday send Sam the numbers')).toBe('Make an agent from a sentence.');
    expect(h.said()).toBe('Every Monday at 9:00, send Sam the numbers.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'make agent' });
    // Nothing is built before the yes.
    expect(h.did).toEqual([]);
    // The schedule is a word that can be changed, and what is built is what the line says then.
    await h.reply('word', { word: 'when', value: 'Friday at 16:00' });
    expect(h.said()).toBe('Every Friday at 16:00, send Sam the numbers.');
    await h.reply('yes');
    expect(h.did).toEqual(['build Every Friday at 16:00, send Sam the numbers.', 'enable flow-1']);
    expect(h.said()).toBe('Meet Tony, a new agent. The first time, it shows you before it acts.');
    expect(h.agents.store.list()).toMatchObject([{ flowId: 'flow-1', name: 'Tony', rung: 'asks first', sentence: 'Every Friday at 16:00, send Sam the numbers.' }]);
    // What the product asks before every step of that workflow.
    expect(h.agents.store.rung('flow-1')).toBe('asks first');
    expect(h.agents.store.rung('some-other-workflow')).toBeNull();
    expect(h.agents.row()).toEqual({ kind: 'row', id: 'agents', go: true, say: [{ em: '1 agent' }, ' on duty.'] });
  });

  test('while it is being built the notch says so', async () => {
    let done: (built: Built) => void = () => {};
    const h = harness({ build: () => new Promise<Built>((resolve) => { done = resolve; }) });
    await h.speak('Every Monday send Sam the numbers');
    await h.reply('yes');
    expect(h.line()).toMatchObject({ kind: 'work' });
    expect(h.said()).toBe('Building it. This can take a couple of minutes.');
    done({ ok: true, flowId: 'flow-9', job: 'Send Sam the numbers', ready: true, missing: '' });
    await settle();
    expect(h.said()).toBe('Meet Tony, a new agent. The first time, it shows you before it acts.');
  });

  // The plan's test, step 4: "Say the same sentence again. It refuses."
  test('the same sentence twice is refused, and nothing is built for it', async () => {
    const h = harness();
    await h.makes();
    await h.speak('every monday at 9:00 send Sam the numbers');
    await h.reply('yes');
    expect(h.said()).toBe('You already have an agent for that: Tony.');
    expect(h.did.filter((line) => line.startsWith('build'))).toHaveLength(1);
    // Another job is another agent, with the next name.
    await h.pass(5000);
    await h.makes('Every Friday at 16:00, post the week in the channel');
    expect(h.agents.store.list().map((agent) => agent.name)).toEqual(['Tony', 'Mara']);
  });

  test('Esc builds nothing', async () => {
    const h = harness();
    await h.speak('Every Monday send Sam the numbers');
    await h.reply('no');
    expect(h.did).toEqual([]);
    expect(h.agents.store.list()).toEqual([]);
    expect(h.agents.row()).toBeNull();
  });

  test('what cannot be built, or cannot run yet, is said, and is no agent', async () => {
    const failed = harness({ build: () => ({ ok: false, why: 'it needs a connector that is not installed: Slack.' }) });
    await failed.speak('Every Monday post the numbers in Slack');
    await failed.reply('yes');
    expect(failed.said()).toBe('I could not build that: it needs a connector that is not installed: Slack. Nothing was set up.');
    expect(failed.agents.store.list()).toEqual([]);

    const unready = harness({ build: () => ({ ok: true, flowId: 'flow-1', job: 'Send Sam the numbers', ready: false, missing: 'A Gmail account is not chosen for the step that sends.' }) });
    await unready.speak('Every Monday send Sam the numbers');
    await unready.reply('yes');
    expect(unready.said()).toBe('I built Send Sam the numbers, but it cannot run yet: A Gmail account is not chosen for the step that sends. It is in the dashboard, switched off.');
    // Not switched on, and not called an agent.
    expect(unready.did).toEqual(['build Every Monday at 9:00, send Sam the numbers.']);
    expect(unready.agents.store.list()).toEqual([]);

    const refused = harness({ enable: { ok: false, why: 'the schedule has no time' } });
    await refused.speak('Every Monday send Sam the numbers');
    await refused.reply('yes');
    expect(refused.said()).toBe('I built Every Monday at 9:00, send Sam the numbers, but could not switch it on: the schedule has no time. It is in the dashboard, switched off.');
    expect(refused.agents.store.list()).toEqual([]);
  });

  test('with everything stopped no agent is made', async () => {
    const h = harness({ paused: () => true });
    await h.speak('Every Monday send Sam the numbers');
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
    expect(h.did).toEqual([]);
  });
});

describe('your agents', () => {
  const sheet = (h: ReturnType<typeof harness>) => h.line() as Extract<NotchLine, { kind: 'sheet' }>;
  const rowOf = (h: ReturnType<typeof harness>, at = 0) => sheet(h).blocks[at] as Extract<NotchBlock, { kind: 'row' }>;

  test('each has its name, what it does, how free it is, and its switches', async () => {
    const h = harness();
    await h.makes();
    expect(await h.speak('Show my agents')).toBe('Show the agents.');
    expect(h.said()).toBe('Your agents');
    expect(rowOf(h)).toMatchObject({
      kind: 'row', id: 'flow-1', lead: 'Tony',
      buttons: [{ id: 'run', label: 'Run now' }, { id: 'pause', label: 'Pause', quiet: true }, { id: 'go', label: 'Let go', quiet: true }],
    });
    expect(text(rowOf(h).say)).toBe('Every Monday at 9:00, send Sam the numbers. asks first');
    expect(rowOf(h).say[1]).toMatchObject({ word: { value: 'asks first', options: ['asks first', 'tells you after', 'acts alone'], label: 'Freedom' } });
    expect(text((sheet(h).blocks[1] as { say: NotchPart[] }).say)).toContain('Money always asks.');
  });

  test('the rung is a word the owner can set by hand, up or down', async () => {
    const h = harness();
    await h.makes();
    await h.speak('my agents');
    await h.reply('word', { word: 'rung:flow-1', value: 'acts alone' });
    expect(h.agents.store.rung('flow-1')).toBe('acts alone');
    expect(text(rowOf(h).say)).toContain('acts alone');
    await h.reply('word', { word: 'rung:flow-1', value: 'asks first' });
    expect(h.agents.store.rung('flow-1')).toBe('asks first');
    // A word that is no rung, or for a workflow that is no agent, changes nothing.
    await h.reply('word', { word: 'rung:flow-1', value: 'does anything' });
    await h.reply('word', { word: 'rung:flow-77', value: 'acts alone' });
    expect(h.agents.store.rung('flow-1')).toBe('asks first');
    expect(h.agents.store.rung('flow-77')).toBeNull();
  });

  test('Run now, Pause and Resume do what they say', async () => {
    const h = harness();
    await h.makes();
    await h.speak('my agents');
    await h.reply('button', { row: 'flow-1', button: 'pause' });
    expect(h.did.at(-1)).toBe('pause flow-1');
    expect(rowOf(h)).toMatchObject({ small: 'Paused', buttons: [{ id: 'run' }, { id: 'pause', label: 'Resume' }, { id: 'go' }] });
    await h.reply('button', { row: 'flow-1', button: 'pause' });
    expect(h.did.at(-1)).toBe('resume flow-1');
    await h.reply('button', { row: 'flow-1', button: 'run' });
    expect(h.did.at(-1)).toBe('run flow-1');
    expect(h.said()).toBe('Tony is running.');
  });

  test('Let go asks first, and deletes the workflow too', async () => {
    const h = harness();
    await h.makes();
    await h.speak('my agents');
    await h.reply('button', { row: 'flow-1', button: 'go' });
    expect(h.said()).toBe('Let Tony go? It is deleted for good.');
    await h.reply('no');
    expect(h.agents.store.list()).toHaveLength(1);
    await h.reply('button', { row: 'flow-1', button: 'go' });
    await h.reply('yes');
    expect(h.did.at(-1)).toBe('remove flow-1');
    expect(h.agents.store.list()).toEqual([]);
    expect(h.agents.store.rung('flow-1')).toBeNull();
    expect(text((sheet(h).blocks[0] as { say: NotchPart[] }).say)).toContain('No agents yet.');
  });

  test('an agent whose workflow was deleted elsewhere is no agent any more', async () => {
    const h = harness();
    await h.makes();
    h.flows.delete('flow-1');
    expect(h.agents.row()).toMatchObject({ say: [{ em: '1 agent' }, ' on duty.'] });
    h.agents.tick();
    expect(h.agents.store.list()).toEqual([]);
    expect(h.agents.store.rung('flow-1')).toBeNull();
  });
});

describe('the next rung is offered from results', () => {
  // The plan's test, step 5: "After five good runs it offers the next rung. Say no. It stays."
  test('after five runs in a row that went well it offers the next rung; a no leaves it where it is', async () => {
    const h = harness();
    await h.makes();
    for (let i = 0; i < NOTCH_AGENT_GOOD_RUNS - 1; i++) h.ran('flow-1');
    h.agents.tick();
    await settle();
    expect(h.line()).toBeNull();
    h.ran('flow-1');
    h.agents.tick();
    await settle();
    expect(h.said()).toBe("Tony's last 5 runs went well. Let Tony tell you after?");
    expect((h.line()!.say[2] as { word: { options: string[] } }).word.options).toEqual(['tell you after', 'keep asking']);
    await h.reply('no');
    expect(h.agents.store.rung('flow-1')).toBe('asks first');
    // Not asked again for the same runs, nor at the next one.
    h.ran('flow-1');
    h.agents.tick();
    await settle();
    expect(h.line()).toBeNull();
    // Five more, and it is offered again.
    for (let i = 0; i < 4; i++) h.ran('flow-1');
    h.agents.tick();
    await settle();
    expect(h.said()).toBe("Tony's last 5 runs went well. Let Tony tell you after?");
    await h.reply('yes');
    expect(h.said()).toBe('Tony now tells you after. Change it any time.');
    expect(h.agents.store.rung('flow-1')).toBe('tells you after');
  });

  test('a run that went badly starts the count again, and a run still under way is not counted', async () => {
    const h = harness();
    await h.makes();
    for (let i = 0; i < 3; i++) h.ran('flow-1');
    h.ran('flow-1', 'bad');
    for (let i = 0; i < 4; i++) h.ran('flow-1');
    h.ran('flow-1', 'open');
    h.agents.tick();
    await settle();
    expect(h.line()).toBeNull();
    h.ran('flow-1');
    h.agents.tick();
    await settle();
    expect(h.said()).toBe("Tony's last 5 runs went well. Let Tony tell you after?");
  });

  test('"keep asking" on the word, then yes, keeps it and says so', async () => {
    const h = harness();
    await h.makes();
    for (let i = 0; i < 5; i++) h.ran('flow-1');
    h.agents.tick();
    await settle();
    await h.reply('word', { word: 'how', value: 'keep asking' });
    await h.reply('yes');
    expect(h.said()).toBe('Tony keeps asking you, every time.');
    expect(h.agents.store.rung('flow-1')).toBe('asks first');
  });

  test('from "tells you after" the next is "acts alone", each good run is told once, and at the top nothing more is offered', async () => {
    const h = harness();
    await h.makes();
    h.agents.store.setRung('flow-1', 'tells you after', 1_000_000);
    h.advance(1000);
    h.ran('flow-1');
    h.agents.tick();
    await settle();
    // The first run it sees is where it starts counting from: it was not told of what came before it looked.
    expect(h.line()).toBeNull();
    h.ran('flow-1');
    h.agents.tick();
    await settle();
    expect(h.said()).toBe('Tony did its job: Every Monday at 9:00, send Sam the numbers.');
    await h.pass(7000);
    h.agents.tick();
    await settle();
    // Told once.
    expect(h.line()).toBeNull();
    for (let i = 0; i < 3; i++) { h.ran('flow-1'); h.agents.tick(); await settle(); await h.pass(7000); }
    await settle();
    // It came while the notch was telling of a run: it waits in the count, and is there when the count is opened.
    expect(h.inbox.waiting().map((item) => item.id)).toEqual(['agent-rung-flow-1']);
    await h.opens();
    expect(h.said()).toBe("Tony's last 5 runs went well. Let Tony act alone?");
    await h.reply('yes');
    expect(h.agents.store.rung('flow-1')).toBe('acts alone');
    await h.pass(5000);
    for (let i = 0; i < 6; i++) h.ran('flow-1');
    h.agents.tick();
    await settle();
    // Alone: nothing is said of a run that went well, and there is no rung above.
    expect(h.line()).toBeNull();
  });

  test('with everything stopped nothing is counted or offered', async () => {
    let paused = false;
    const h = harness({ paused: () => paused });
    await h.makes();
    for (let i = 0; i < 5; i++) h.ran('flow-1');
    paused = true;
    h.agents.tick();
    await settle();
    expect(h.line()).toBeNull();
  });
});

describe('where the agents are kept', () => {
  test('an agent, and its rung, outlive a restart', async () => {
    const db = new Database(':memory:');
    const before = harness({ db });
    await before.makes();
    before.agents.store.setRung('flow-1', 'tells you after', 5);
    before.agents.stop();
    const store = new NotchAgentStore(db);
    expect(store.rung('flow-1')).toBe('tells you after');
    expect(store.list()).toMatchObject([{ name: 'Tony', rung: 'tells you after' }]);
  });

  test('a rung that is no rung reads as the first one: a table that was tampered with can only tighten', () => {
    const db = new Database(':memory:');
    const store = new NotchAgentStore(db);
    store.add({ flowId: 'flow-1', name: 'Tony', rung: 'asks first', sentence: 'x', madeAt: 1, rungAt: 1, askedAt: 0, toldRun: '' });
    db.run("UPDATE notch_agents SET rung = 'does anything' WHERE flow_id = 'flow-1'");
    expect(store.rung('flow-1')).toBe('asks first');
    expect(store.list()[0]!.rung).toBe('asks first');
  });
});

// The owner, 17 November 2026: "the only way for me to enable it is to go to the dashboard, so it
// doesn't give me a name. Also keeps on calling workflow. I'd like to make fully that switch to
// agents with their own name."
describe('what the assistant builds is an agent like any other', () => {
  test('after its turn the notch offers to switch it on, and a yes gives it its name', async () => {
    const h = harness();
    const built = h.assistantBuilds('Daily AI news briefing');
    h.agents.adopt(built.since);
    await settle();
    expect(h.said()).toBe('Switch Daily AI news briefing on as an agent?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'switch on' });
    // Nothing is switched on before the yes.
    expect(h.did).toEqual([]);
    await h.reply('yes');
    expect(h.did).toEqual([`enable ${built.flowId}`]);
    expect(h.said()).toBe('Meet Tony, a new agent. The first time, it shows you before it acts.');
    expect(h.agents.store.rung(built.flowId)).toBe('asks first');
    expect(h.agents.row()).toMatchObject({ say: [{ em: '1 agent' }, ' on duty.'] });
    // Once: the same turn looked at again offers nothing more.
    await h.pass(9000);
    h.agents.adopt(built.since);
    await settle();
    expect(h.line()).toBeNull();
  });

  test('a no leaves it switched off, and it waits in the list, where it can be switched on or discarded', async () => {
    const h = harness();
    const built = h.assistantBuilds('Daily AI news briefing');
    h.agents.adopt(built.since);
    await settle();
    await h.reply('no');
    expect(h.did).toEqual([]);
    expect(h.agents.store.list()).toEqual([]);
    // Home says so, and leads to it.
    expect(h.agents.row()).toEqual({ kind: 'row', id: 'agents', go: true, say: [{ em: '1 agent' }, ' built, not switched on.'] });
    await h.speak('my agents');
    const blocks = (h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks;
    expect(blocks[0]).toEqual({
      kind: 'row', id: built.flowId, lead: 'New', say: ['Daily AI news briefing.'], small: 'Not switched on',
      buttons: [{ id: 'on', label: 'Switch on' }, { id: 'drop', label: 'Discard', quiet: true }],
    });
    await h.reply('button', { row: built.flowId, button: 'on' });
    expect(h.said()).toBe('Meet Tony, a new agent. The first time, it shows you before it acts.');
    expect(h.agents.store.list()).toMatchObject([{ flowId: built.flowId, name: 'Tony' }]);
  });

  test('Discard deletes what was built and never switched on', async () => {
    const h = harness();
    const built = h.assistantBuilds('Daily AI news briefing');
    await h.speak('my agents');
    await h.reply('button', { row: built.flowId, button: 'drop' });
    expect(h.did).toEqual([`remove ${built.flowId}`]);
    expect(h.agents.row()).toBeNull();
  });

  test('one that cannot run yet is said once, and is not offered to be switched on', async () => {
    const h = harness();
    const built = h.assistantBuilds('Mail Sam the numbers', { ready: false, missing: 'A Gmail account is not chosen for the step that sends.' });
    h.agents.adopt(built.since);
    await settle();
    expect(h.said()).toBe('Mail Sam the numbers is built, but cannot run yet: A Gmail account is not chosen for the step that sends.');
    await h.pass(9000);
    await h.speak('my agents');
    expect((h.line() as Extract<NotchLine, { kind: 'sheet' }>).blocks[0]).toMatchObject({ lead: 'New', small: 'Needs setting up', buttons: [{ id: 'drop' }] });
  });

  test('one the assistant switched on itself is named, and asks first from then on', async () => {
    const h = harness();
    const built = h.assistantBuilds('Daily AI news briefing', { enabled: true });
    h.agents.adopt(built.since);
    await settle();
    expect(h.said()).toBe('Meet Tony, a new agent. The first time, it shows you before it acts.');
    expect(h.did).toEqual([]);
    expect(h.agents.store.rung(built.flowId)).toBe('asks first');
  });

  test('a turn that built nothing changes nothing, and an agent made on the notch is not offered again', async () => {
    const h = harness();
    await h.makes();
    h.agents.adopt(0);
    await settle();
    expect(h.line()).toBeNull();
    expect(h.agents.store.list()).toHaveLength(1);
  });

  test('nothing the notch says about an agent calls it a workflow', async () => {
    const h = harness();
    const built = h.assistantBuilds('Daily AI news briefing');
    const seen: string[] = [];
    const note = (): void => { const line = h.line(); if (line) seen.push(JSON.stringify(line)); };
    h.agents.adopt(built.since);
    await settle(); note();
    await h.reply('yes'); note();
    await h.pass(9000);
    await h.speak('my agents'); note();
    await h.reply('button', { row: built.flowId, button: 'go' }); note();
    await h.reply('yes'); note();
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.join(' ').toLowerCase()).not.toContain('workflow');
  });
});
