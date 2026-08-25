import { afterEach, describe, expect, test } from 'bun:test';
import type { WSMessage } from '../../comms/websocket.ts';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import {
  TRIAL_DURATION_MS,
  issueTrialEntitlement,
  readTrialEntitlement,
} from '../../trial/entitlement.ts';
import {
  CLOCK_TRANSCRIPT_GRACE_MS,
  TrialConductorManager,
  transcriptHasWords,
} from './conductor-manager.ts';

const T0 = 1_780_000_000_000;
/** Stand-in for a socket. The manager only ever uses it as a map key. */
type Sock = { id: string };

function harness(now = () => T0, clockGraceMs?: number) {
  const sent: Array<{ ws: Sock; msg: WSMessage }> = [];
  const broadcast: WSMessage[] = [];
  const actions = {
    workflows: [] as string[],
    brief: null as { hour: number; minute: number } | null,
    authority: null as number | null,
    spawned: [] as string[],
  };
  const manager = new TrialConductorManager<Sock>({
    send: (ws, msg) => sent.push({ ws, msg }),
    broadcast: (msg) => broadcast.push(msg),
    now,
    clockGraceMs,
    beatActions: {
      publishWorkflow: async (p) => { actions.workflows.push(p.name); return { ok: true as const, detail: 'built' }; },
      setMorningBrief: (hour, minute) => { actions.brief = { hour, minute }; },
      setAuthorityLevel: (level) => { actions.authority = level; return level; },
      spawnResearchAgent: async (question) => {
        actions.spawned.push(question);
        return { agentId: 'a1', taskId: 't1', agentName: 'Research Analyst' };
      },
    },
  });
  return { manager, sent, broadcast, actions, ws: { id: 'a' } as Sock };
}

describe('transcriptHasWords', () => {
  test('a cough, a click and a stray comma are not a spoken word', () => {
    expect(transcriptHasWords('')).toBe(false);
    expect(transcriptHasWords('   ')).toBe(false);
    expect(transcriptHasWords('...')).toBe(false);
    expect(transcriptHasWords('  , . -  ')).toBe(false);
  });

  test('words are, in any script', () => {
    expect(transcriptHasWords('So it is just me.')).toBe(true);
    expect(transcriptHasWords('7')).toBe(true);
    expect(transcriptHasWords('こんにちは')).toBe(true);
  });
});

describe('arming', () => {
  test('a socket is not the conductor until it asks to be', () => {
    const { manager, ws } = harness();
    expect(manager.isArmed(ws)).toBe(false);
    expect(manager.isRunning(ws)).toBe(false);
    manager.arm(ws);
    expect(manager.isArmed(ws)).toBe(true);
    // Arming alone does not start a session, the realtime starter does.
    expect(manager.isRunning(ws)).toBe(false);
  });

  test('end clears a socket that armed but never spoke', () => {
    const { manager, ws } = harness();
    manager.arm(ws);
    manager.end(ws);
    expect(manager.isArmed(ws)).toBe(false);
  });
});

describe('D9: the 48-hour clock starts at the founder\'s first spoken word', () => {
  afterEach(() => closeDb());

  function running(now: () => number) {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 - 60_000 });
    const h = harness(now);
    h.manager.arm(h.ws);
    h.manager.begin(h.ws);
    return h;
  }

  test('Jarvis speaking first does NOT start it', () => {
    const { manager, ws, broadcast } = running(() => T0);
    // This is the opening line of every trial, it arrives before the founder
    // has said a word, and it must not cost them a second of their 48 hours.
    manager.onTranscript(ws, 'assistant', 'I am Jarvis. From here on I am your co-founder.', true);
    expect(readTrialEntitlement()?.started_at).toBeNull();
    expect(broadcast.filter((m) => m.type === 'trial_status')).toHaveLength(0);
  });

  test('a partial transcript does not start it', () => {
    const { manager, ws } = running(() => T0);
    manager.onTranscript(ws, 'user', 'So it is', false);
    expect(readTrialEntitlement()?.started_at).toBeNull();
  });

  test('a transcript with no words in it does not start it', () => {
    const { manager, ws } = running(() => T0);
    manager.onTranscript(ws, 'user', '  ...  ', true);
    expect(readTrialEntitlement()?.started_at).toBeNull();
  });

  test('their first real sentence starts it, and announces the deadline', () => {
    const { manager, ws, broadcast } = running(() => T0);
    manager.onTranscript(ws, 'user', 'So it is just me, and Ana two days a week.', true);

    const e = readTrialEntitlement();
    expect(e?.started_at).toBe(T0);
    expect(e?.expires_at).toBe(T0 + TRIAL_DURATION_MS);

    const status = broadcast.find((m) => m.type === 'trial_status');
    expect(status).toBeDefined();
    expect((status!.payload as { state: string }).state).toBe('active');
  });

  test('everything they say after that leaves the deadline where it is', () => {
    let clock = T0;
    const { manager, ws, broadcast } = running(() => clock);
    manager.onTranscript(ws, 'user', 'So it is just me.', true);
    clock = T0 + 10 * 60_000;
    manager.onTranscript(ws, 'user', 'And Bowman renew in October.', true);

    expect(readTrialEntitlement()?.started_at).toBe(T0);
    expect(broadcast.filter((m) => m.type === 'trial_status')).toHaveLength(1);
  });
});

describe('the clock backstop when transcription never arrives', () => {
  afterEach(() => closeDb());

  test('a completed utterance arms a timer rather than starting the clock outright', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws } = harness(() => T0);
    manager.arm(ws);
    manager.begin(ws);

    manager.onUserSpeechStopped(ws);
    // Still unstarted: a real transcript is given its chance to win.
    expect(readTrialEntitlement()?.started_at).toBeNull();
    expect(CLOCK_TRANSCRIPT_GRACE_MS).toBeGreaterThan(1000);
  });

  test('a transcript inside the grace window wins, and disarms the backstop', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws } = harness(() => T0);
    manager.arm(ws);
    const session = manager.begin(ws);

    manager.onUserSpeechStopped(ws);
    manager.onTranscript(ws, 'user', 'It is a two-person company.', true);
    expect(session.firstSpeechAt).toBe(T0);
    expect(readTrialEntitlement()?.started_at).toBe(T0);
  });

  test('the timer fires when nothing ever transcribes, so a trial cannot run forever', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws } = harness(() => T0, 1);
    manager.arm(ws);
    manager.begin(ws);

    manager.onUserSpeechStopped(ws);
    await Bun.sleep(10);
    expect(readTrialEntitlement()?.started_at).toBe(T0);
  });

  test('a session torn down inside the window does not start anyone\'s clock later', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws } = harness(() => T0, 5);
    manager.arm(ws);
    manager.begin(ws);

    manager.onUserSpeechStopped(ws);
    manager.end(ws);
    await Bun.sleep(20);
    expect(readTrialEntitlement()?.started_at).toBeNull();
  });
});

describe('live surfaces', () => {
  afterEach(() => closeDb());

  test('entities landing are broadcast, not sent to the conductor socket alone', async () => {
    // The memory room lives on the shell's own socket. A targeted send would
    // leave it waiting on its 8-second poll, which is not "in real time" (D22).
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws, broadcast, sent } = harness(() => T0);
    manager.arm(ws);
    manager.begin(ws);

    await manager.executeTool(ws, 'remember', { entities: [{ name: 'Kestrel', type: 'concept', role: 'company' }] });

    const memory = broadcast.find((m) => m.type === 'trial_memory');
    expect(memory).toBeDefined();
    expect((memory!.payload as { landed: Array<{ name: string }> }).landed[0]!.name).toBe('Kestrel');
    expect(sent.filter((s) => s.msg.type === 'trial_memory')).toHaveLength(0);
  });

  test('concluding stamps the seam on the entitlement and announces it', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws, broadcast } = harness(() => T0 + 1000);
    manager.arm(ws);
    manager.begin(ws);

    await manager.executeTool(ws, 'conclude_opening', { understanding: 'Two-person B2B SaaS.' });

    expect(readTrialEntitlement()?.opening_completed_at).toBe(T0 + 1000);
    const done = broadcast.find((m) => m.type === 'trial_opening_complete');
    expect(done).toBeDefined();
    expect((done!.payload as { understanding: string }).understanding).toBe('Two-person B2B SaaS.');
  });

  test('a tool call on a socket with no conductor session is not the conductor\'s', async () => {
    initDatabase(':memory:');
    const { manager, ws } = harness(() => T0);
    expect(await manager.executeTool(ws, 'remember', {})).toBeNull();
  });
});

/* ─────────────────── the seam, and the seven beats ─────────────────── */

describe('the join between the opening and the beats', () => {
  afterEach(() => closeDb());

  test('a beat tool is refused until the opening concludes, and works the moment it does', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws } = harness(() => T0);
    manager.arm(ws);
    manager.begin(ws);

    const early = await manager.executeTool(ws, 'propose_goals', {
      objective: 'x', key_results: [{ title: 'y' }],
    });
    expect(early).toContain('conclude_opening');
    expect(manager.beatsOf(ws)!.open).toBe(false);

    await manager.executeTool(ws, 'conclude_opening', { understanding: 'ok' });
    expect(manager.beatsOf(ws)!.open).toBe(true);

    const now = await manager.executeTool(ws, 'propose_goals', {
      objective: '40 paying customers by the end of Q3', key_results: [{ title: '12 demos a month' }],
    });
    expect(now).toContain('On their screen');
  });

  test('concluding does not end anything: no close, no handover, session still live', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws, broadcast } = harness(() => T0);
    manager.arm(ws);
    manager.begin(ws);
    await manager.executeTool(ws, 'conclude_opening', { understanding: 'ok' });

    expect(manager.isRunning(ws)).toBe(true);
    expect(manager.isArmed(ws)).toBe(true);
    // Nothing on the wire tells the founder the conversation changed gear.
    expect(broadcast.some((m) => m.type === 'realtime_status')).toBe(false);
    expect(broadcast.some((m) => m.type === 'tts_end')).toBe(false);
  });
});

describe('what the founder sees during a beat', () => {
  afterEach(() => closeDb());

  async function openedManager() {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const h = harness(() => T0);
    h.manager.arm(h.ws);
    h.manager.begin(h.ws);
    await h.manager.executeTool(h.ws, 'conclude_opening', { understanding: 'ok' });
    h.broadcast.length = 0;
    return h;
  }

  test('the pebble leads them to the room before the room opens (D21)', async () => {
    const { manager, ws, broadcast } = await openedManager();
    await manager.executeTool(ws, 'propose_goals', { objective: 'o', key_results: [{ title: 'k' }] });

    const point = broadcast.findIndex((m) => m.type === 'trial_point');
    const nav = broadcast.findIndex(
      (m) => m.type === 'notification' && (m.payload as { source?: string }).source === 'navigate_room',
    );
    expect(point).toBeGreaterThanOrEqual(0);
    expect(nav).toBeGreaterThan(point);
    expect((broadcast[point]!.payload as { target: string }).target).toBe('room:goals');
  });

  test('the pebble does not re-fly for a second proposal in the same room', async () => {
    const { manager, ws, broadcast } = await openedManager();
    await manager.executeTool(ws, 'propose_goals', { objective: 'o', key_results: [{ title: 'k' }] });
    const first = broadcast.filter((m) => m.type === 'trial_point').length;
    await manager.executeTool(ws, 'propose_goals', { objective: 'o2', key_results: [{ title: 'k2' }] });
    expect(broadcast.filter((m) => m.type === 'trial_point')).toHaveLength(first);
  });

  test('what lands is pushed into the room, not left to its poll (D22)', async () => {
    const { manager, ws, broadcast } = await openedManager();
    await manager.executeTool(ws, 'propose_goals', { objective: 'o', key_results: [{ title: 'k' }] });
    await manager.executeTool(ws, 'create_goals', {});

    const refresh = broadcast.find(
      (m) => m.type === 'notification'
        && (m.payload as { source?: string; action?: string }).source === 'room_action'
        && (m.payload as { action?: string }).action === 'refresh',
    );
    expect(refresh).toBeDefined();
    expect((refresh!.payload as { room: string }).room).toBe('goals');
    // And the card resolves rather than just vanishing.
    const landed = broadcast.filter((m) => m.type === 'trial_proposal').at(-1);
    expect((landed!.payload as { proposal: unknown; landed?: unknown }).proposal).toBeNull();
    expect((landed!.payload as { landed?: { beat: string } }).landed?.beat).toBe('goals');
  });

  test('the proposal is broadcast so it reaches the shell, not only the conductor socket', async () => {
    const { manager, ws, broadcast, sent } = await openedManager();
    sent.length = 0;
    await manager.executeTool(ws, 'propose_goals', { objective: 'o', key_results: [{ title: 'k' }] });
    expect(broadcast.some((m) => m.type === 'trial_proposal')).toBe(true);
    expect(sent.some((s) => s.msg.type === 'trial_proposal')).toBe(false);
  });
});

describe('the finale', () => {
  afterEach(() => closeDb());

  test('the whole arc runs on one session and ends with onboarding complete', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws, broadcast, actions } = harness(() => T0);
    manager.arm(ws);
    manager.begin(ws);
    const run = (n: string, a: Record<string, unknown> = {}) => manager.executeTool(ws, n, a);

    await run('conclude_opening', { understanding: 'Two-person B2B SaaS.' });
    await run('propose_goals', { objective: '40 customers by Q3', key_results: [{ title: '12 demos a month' }] });
    await run('create_goals');
    await run('propose_tasks', { tasks: [{ what: 'Send Bowman the quote' }] });
    await run('create_tasks');
    await run('propose_morning_brief', { hour: 7, minute: 30 });
    await run('set_morning_brief');
    await run('propose_workflow', { name: 'Monday pipeline review', runs_when: 'Mondays at 8', steps: ['Pull open deals'] });
    await run('publish_workflow');
    await run('propose_authority', {});
    await run('set_authority', {});
    await run('spawn_research_agent', { question: 'What the competitors charge', brief: 'Compare published prices.' });

    expect(actions.brief).toEqual({ hour: 7, minute: 30 });
    expect(actions.authority).toBe(5);
    expect(actions.workflows).toEqual(['Monday pipeline review']);
    expect(actions.spawned).toEqual(['What the competitors charge']);

    const done = broadcast.find((m) => m.type === 'trial_onboarding_complete');
    expect(done).toBeDefined();
    const payload = done!.payload as { beats: string[]; authorityLevel: number; agent: { agentId: string } };
    expect(payload.beats).toEqual(['goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents']);
    expect(payload.authorityLevel).toBe(5);
    expect(payload.agent.agentId).toBe('a1');

    // D17: onboarding finished, the conversation did not. Nothing closed it.
    expect(manager.isRunning(ws)).toBe(true);
    expect(manager.beatsOf(ws)!.finishedAt).toBe(T0);
  });

  test('an install with no beat actions wired refuses out loud instead of pretending', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const sent: Array<{ ws: Sock; msg: WSMessage }> = [];
    const broadcast: WSMessage[] = [];
    const manager = new TrialConductorManager<Sock>({
      send: (ws, msg) => sent.push({ ws, msg }),
      broadcast: (msg) => broadcast.push(msg),
      now: () => T0,
    });
    const ws: Sock = { id: 'a' };
    manager.arm(ws);
    manager.begin(ws);
    await manager.executeTool(ws, 'conclude_opening', { understanding: 'ok' });
    await manager.executeTool(ws, 'propose_goals', { objective: 'o', key_results: [{ title: 'k' }] });
    await manager.executeTool(ws, 'create_goals');
    await manager.executeTool(ws, 'propose_tasks', { tasks: [{ what: 'a' }] });
    await manager.executeTool(ws, 'create_tasks');
    await manager.executeTool(ws, 'propose_morning_brief', { hour: 8 });
    const res = await manager.executeTool(ws, 'set_morning_brief');
    expect(res).toContain('did not save');
    expect(manager.beatsOf(ws)!.briefAt).toBeNull();
  });
});
