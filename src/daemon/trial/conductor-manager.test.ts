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
import type { FoundEntities } from './reader-tools.ts';
import { TRIAL_FILES_SOURCE, TRIAL_VAULT_SOURCE } from './conductor.ts';
import { findEntities } from '../../vault/entities.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const T0 = 1_780_000_000_000;
/** Stand-in for a socket. The manager only ever uses it as a map key. */
type Sock = { id: string };

function harness(now = () => T0, clockGraceMs?: number, summonWaitMs = 25) {
  const sent: Array<{ ws: Sock; msg: WSMessage }> = [];
  const broadcast: WSMessage[] = [];
  const actions = {
    workflows: [] as string[],
    brief: null as { hour: number; minute: number } | null,
    evening: null as number | null,
    authority: null as number | null,
    alwaysAsk: [] as string[],
    spawned: [] as string[],
    readerStarts: [] as { folder: string; shortlist: string[]; about: string }[],
    readerFound: null as ((f: FoundEntities) => { landed: number; names: string[] }) | null,
    readerDone: null as ((summary: string | null) => void) | null,
  };
  const manager = new TrialConductorManager<Sock>({
    send: (ws, msg) => sent.push({ ws, msg }),
    broadcast: (msg) => broadcast.push(msg),
    now,
    clockGraceMs,
    summonWaitMs,
    beatActions: {
      publishWorkflow: async (p) => { actions.workflows.push(p.name); return { ok: true as const, detail: 'built' }; },
      setDailyRhythm: (morning, eveningHour) => { actions.brief = morning; actions.evening = eveningHour; },
      setAuthority: (level, alwaysAsk) => { actions.authority = level; actions.alwaysAsk = alwaysAsk; return { level, alwaysAsk }; },
      startFolderReader: async (opts) => {
        actions.readerStarts.push({ folder: opts.folder, shortlist: opts.shortlist, about: opts.about });
        actions.readerFound = opts.onFound;
        actions.readerDone = opts.onDone;
        return { agentId: 'reader-1', taskId: 'read-1' };
      },
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

/* ─────────────────── the seam, and the beats ─────────────────── */

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

    const seam = await manager.executeTool(ws, 'conclude_opening', { understanding: 'ok' });
    expect(manager.beatsOf(ws)!.open).toBe(true);
    // D44: the first thing on the other side of the seam is their files, not
    // their quarter. This is the whole reorder as the model experiences it.
    expect(seam).toContain('propose_reading');
    expect(seam).not.toContain('propose_goals');

    // And their quarter is refused until the file beats are closed one way or
    // the other, which is what makes "it already knows" true rather than a
    // sequencing accident.
    const tooSoon = await manager.executeTool(ws, 'propose_goals', {
      objective: '40 paying customers by the end of Q3', key_results: [{ title: '12 demos a month' }],
    });
    expect(tooSoon).toContain('Not yet');

    await manager.executeTool(ws, 'move_on', { because: 'they would rather not' });
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
    // A clock that moves, because the answered gate compares two moments.
    let t = T0;
    const h = harness(() => t++);
    h.manager.arm(h.ws);
    h.manager.begin(h.ws);
    await h.manager.executeTool(h.ws, 'conclude_opening', { understanding: 'ok' });
    // D44 put the two file beats in front of everything else, and these tests
    // are about what the founder SEES during a beat rather than about the
    // reading. Declining is the shortest honest way past both: one `move_on`
    // closes `files` and `workspace` together.
    await h.manager.executeTool(h.ws, 'move_on', { because: 'not now' });
    h.broadcast.length = 0;
    return h;
  }

  test('the pebble leads them to the room, and carries where it leads (D21)', async () => {
    const { manager, ws, broadcast } = await openedManager();
    await manager.executeTool(ws, 'propose_goals', { objective: 'o', key_results: [{ title: 'k' }] });

    const point = broadcast.find((m) => m.type === 'trial_point');
    expect(point).toBeDefined();
    const payload = point!.payload as { target: string; label: string; room: string };
    expect(payload.target).toBe('room:goals');
    expect(payload.room).toBe('goals');
    expect(payload.label).toBeTruthy();

    // Deliberately NOT the shell's `navigate_room` notification: from the home
    // thread that opens the room as an inline window inside the Thread, and
    // the Thread lives in the Talk panel the trial hides. The founder would
    // have watched nothing happen.
    expect(broadcast.some(
      (m) => m.type === 'notification' && (m.payload as { source?: string }).source === 'navigate_room',
    )).toBe(false);
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
    await manager.executeTool(ws, 'propose_goals', DEEP_GOALS);
    manager.onUserSpeechStopped(ws);
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

/** A goal tree deep enough for `create_goals` to write it: two key results,
 *  both with today's number, and the first move. See D41 in beats.ts. */
const DEEP_GOALS = {
  objective: '40 customers by Q3',
  deadline: '2026-09-30',
  key_results: [
    { title: '12 demos a month', target: '12', today: '4' },
    { title: 'Churn under 4%', target: '4%', today: '9%' },
  ],
  first_move: { what: 'Rewrite the pricing page', under: '12 demos a month', due: 'friday' },
};

describe('the finale', () => {
  afterEach(() => closeDb());

  test('the whole arc runs on one session and ends with onboarding complete', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    let t = T0;
    const { manager, ws, broadcast, actions } = harness(() => t++);
    manager.arm(ws);
    manager.begin(ws);
    const run = (n: string, a: Record<string, unknown> = {}) => manager.executeTool(ws, n, a);
    /** The founder answers. The VAD is what the server actually hears. */
    const yes = () => manager.onUserSpeechStopped(ws);

    const folder = mkdtempSync(join(tmpdir(), 'arc-files-'));
    writeFileSync(join(folder, 'pitch.md'), '# Acme\nWe sell to studios.', 'utf-8');

    await run('conclude_opening', { understanding: 'Two-person B2B SaaS.' });
    // D42 and D44: the folder is named and approved before anything is built.
    await run('propose_reading', { folder });
    yes();
    await run('start_reading');
    // D43: refusable, and a refusal does not stall the conversation.
    await run('move_on', { because: 'they would rather leave their files alone' });
    await run('propose_goals', DEEP_GOALS);
    yes();
    await run('create_goals');
    await run('propose_tasks', { tasks: [{ what: 'Send Bowman the quote', first: true }] });
    yes();
    await run('create_tasks');
    await run('propose_daily_rhythm', { hour: 7, minute: 30, evening_hour: 19 });
    yes();
    await run('set_daily_rhythm');
    await run('propose_workflow', {
      name: 'Monday pipeline review', runs_when: 'Mondays at 8',
      steps: ['Pull open deals'], never: 'email a client without you seeing it',
    });
    yes();
    await run('publish_workflow');
    await run('no_second_workflow', { because: 'the rest of their week is one-offs' });
    await run('propose_authority', { always_ask: ['send_message'] });
    yes();
    await run('set_authority', {});
    await run('propose_research', { question: 'What the competitors charge', brief: 'Compare published prices.' });
    yes();
    await run('spawn_research_agent', {});

    expect(actions.brief).toEqual({ hour: 7, minute: 30 });
    expect(actions.evening).toBe(19);
    expect(actions.authority).toBe(5);
    expect(actions.alwaysAsk).toEqual(['send_message']);
    expect(actions.workflows).toEqual(['Monday pipeline review']);
    expect(actions.readerStarts).toHaveLength(1);
    expect(actions.readerStarts[0]!.folder).toBe(folder);
    expect(actions.readerStarts[0]!.shortlist).toEqual(['pitch.md']);
    expect(actions.spawned).toEqual(['What the competitors charge']);

    const done = broadcast.find((m) => m.type === 'trial_onboarding_complete');
    expect(done).toBeDefined();
    const payload = done!.payload as { beats: string[]; authorityLevel: number; agent: { agentId: string } };
    expect(payload.beats).toEqual([
      'files', 'workspace', 'goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents',
    ]);
    expect(payload.authorityLevel).toBe(5);
    expect(payload.agent.agentId).toBe('a1');
    rmSync(folder, { recursive: true, force: true });

    // D17: onboarding finished, the conversation did not. Nothing closed it.
    expect(manager.isRunning(ws)).toBe(true);
    expect(manager.beatsOf(ws)!.finishedAt).toBeGreaterThanOrEqual(T0);
  });

  test('a commit that arrives before the founder has said anything is refused', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    let t = T0;
    const { manager, ws } = harness(() => t++);
    manager.arm(ws);
    manager.begin(ws);
    await manager.executeTool(ws, 'conclude_opening', { understanding: 'ok' });
    await manager.executeTool(ws, 'move_on', { because: 'not now' });
    await manager.executeTool(ws, 'propose_goals', DEEP_GOALS);

    expect(await manager.executeTool(ws, 'create_goals')).toContain('have not answered yet');
    // The founder speaks. A transcript and the VAD both count; this is the
    // transcript path, and it also starts the clock, which is why it is here.
    manager.onTranscript(ws, 'user', 'Yeah. Do it.', true);
    expect(await manager.executeTool(ws, 'create_goals')).toContain('Created');
  });

  test('an install with no beat actions wired refuses out loud instead of pretending', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const sent: Array<{ ws: Sock; msg: WSMessage }> = [];
    const broadcast: WSMessage[] = [];
    let t = T0;
    const manager = new TrialConductorManager<Sock>({
      send: (ws, msg) => sent.push({ ws, msg }),
      broadcast: (msg) => broadcast.push(msg),
      now: () => t++,
    });
    const ws: Sock = { id: 'a' };
    manager.arm(ws);
    manager.begin(ws);
    await manager.executeTool(ws, 'conclude_opening', { understanding: 'ok' });
    await manager.executeTool(ws, 'move_on', { because: 'not now' });
    await manager.executeTool(ws, 'propose_goals', DEEP_GOALS);
    manager.onUserSpeechStopped(ws);
    await manager.executeTool(ws, 'create_goals');
    await manager.executeTool(ws, 'propose_tasks', { tasks: [{ what: 'a', first: true }] });
    manager.onUserSpeechStopped(ws);
    await manager.executeTool(ws, 'create_tasks');
    await manager.executeTool(ws, 'propose_daily_rhythm', { hour: 8, evening_hour: 19 });
    manager.onUserSpeechStopped(ws);
    const res = await manager.executeTool(ws, 'set_daily_rhythm');
    expect(res).toContain('did not save');
    expect(manager.beatsOf(ws)!.briefAt).toBeNull();
  });
});

/* ══════════ D42 · what the reader finds, on its way to the founder ══════════ */

describe('the reader lands its findings through the conversation, not beside it', () => {
  afterEach(() => closeDb());

  async function readingManager() {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    let t = T0;
    const h = harness(() => t++);
    h.manager.arm(h.ws);
    h.manager.begin(h.ws);
    const run = (n: string, a: Record<string, unknown> = {}) => h.manager.executeTool(h.ws, n, a);
    const yes = () => h.manager.onUserSpeechStopped(h.ws);

    const folder = mkdtempSync(join(tmpdir(), 'reader-land-'));
    writeFileSync(join(folder, 'pitch.md'), '# Acme', 'utf-8');

    await run('conclude_opening', { understanding: 'ok' });
    await run('propose_reading', { folder }); yes(); await run('start_reading');
    return { ...h, run, folder };
  }

  test('D44: the reader is never sent in blind, even when no fuel was captured', async () => {
    const { actions } = await readingManager();
    // `conclude_opening`'s own summary stands in for the `company` fuel the
    // model may never have called `capture_fuel` for. Under D44 the reading is
    // the FIRST beat, so there is no later turn in which to notice the gap.
    expect(actions.readerStarts[0]!.about).toBe('ok');
  });

  test('a finding lands in the vault and reaches the founder as a memory push (D22)', async () => {
    const { manager, ws, broadcast, actions, folder } = await readingManager();
    broadcast.length = 0;
    const result = actions.readerFound!({
      entities: [{ name: 'Bowman & Co', type: 'project', role: 'client' }],
      facts: [{ about: 'Bowman & Co', detail: 'Renews in October.' }],
    });
    expect(result.landed).toBe(1);
    expect(result.names).toEqual(['Bowman & Co (client)']);

    // The same broadcast the conversation's own `remember` makes, so the
    // founder watches one ticker rather than two sources of truth.
    const memory = broadcast.find((m) => m.type === 'trial_memory');
    expect(memory).toBeDefined();
    expect((memory!.payload as { landed: { name: string }[] }).landed[0]!.name).toBe('Bowman & Co');

    // And it is in the vault, stamped as something it READ rather than
    // something they said, so the debrief can tell the two apart.
    const entity = findEntities({ name: 'Bowman & Co' })[0]!;
    expect(entity.source).toBe(TRIAL_FILES_SOURCE);
    expect(entity.source).not.toBe(TRIAL_VAULT_SOURCE);
    rmSync(folder, { recursive: true, force: true });
    void manager; void ws;
  });

  test('a fact about a name they already gave you comes back as the fact, not just the name', async () => {
    const { run, actions, folder } = await readingManager();
    // They mentioned Ana in the conversation. The reader finds out what she does.
    actions.readerFound!({ entities: [{ name: 'Ana', type: 'person', role: 'co-founder' }] });
    actions.readerFound!({ facts: [{ about: 'Ana', detail: 'Runs the front end two days a week.' }] });
    const res = await run('reading_so_far');
    expect(res).toContain('Ana (co-founder): Runs the front end two days a week.');
    rmSync(folder, { recursive: true, force: true });
  });

  test('the same name in three documents lands once', async () => {
    const { actions, folder } = await readingManager();
    for (let i = 0; i < 3; i++) {
      actions.readerFound!({ entities: [{ name: 'Ana', type: 'person', role: 'co-founder' }] });
    }
    expect(findEntities({ name: 'Ana' })).toHaveLength(1);
    rmSync(folder, { recursive: true, force: true });
  });

  test('`reading_so_far` reports what the reader has actually landed, and only that', async () => {
    const { run, actions, folder } = await readingManager();
    expect(await run('reading_so_far')).toContain('Say NOTHING about it');

    actions.readerFound!({ entities: [{ name: 'Bowman & Co', type: 'project', role: 'client' }] });
    const some = await run('reading_so_far');
    expect(some).toContain('Bowman & Co (client)');
    expect(some).toContain('still reading');

    actions.readerDone!('A three-person design studio in Milan.');
    const done = await run('reading_so_far');
    expect(done).toContain('it has finished');
    expect(done).toContain('A three-person design studio in Milan.');
    rmSync(folder, { recursive: true, force: true });
  });

  test('a reader that fell over reports as finished with nothing, never as silence', async () => {
    const { run, actions, folder } = await readingManager();
    actions.readerDone!(null);
    const res = await run('reading_so_far');
    expect(res).toContain('found nothing about the company');
    expect(res).toContain('without inventing a finding');
    rmSync(folder, { recursive: true, force: true });
  });
});

/* ══════════ beat 13 · the keystroke, and the end of the conducted hour ══════════ */

describe('the summon, and the stand-down it performs', () => {
  afterEach(() => closeDb());

  /** An arc walked to the point where the handover is the only thing left. */
  async function readyToHandOver() {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    let t = T0;
    const h = harness(() => t++);
    h.manager.arm(h.ws);
    h.manager.begin(h.ws);
    const run = (n: string, a: Record<string, unknown> = {}) => h.manager.executeTool(h.ws, n, a);
    const yes = () => h.manager.onUserSpeechStopped(h.ws);
    const folder = mkdtempSync(join(tmpdir(), 'handover-'));
    writeFileSync(join(folder, 'pitch.md'), '# Acme', 'utf-8');

    await run('conclude_opening', { understanding: 'ok' });
    await run('propose_reading', { folder }); yes(); await run('start_reading');
    await run('move_on', { because: 'no' });
    await run('propose_goals', DEEP_GOALS); yes(); await run('create_goals');
    await run('propose_tasks', { tasks: [{ what: 'a', first: true }] }); yes(); await run('create_tasks');
    await run('propose_daily_rhythm', { hour: 7, minute: 30, evening_hour: 19 }); yes(); await run('set_daily_rhythm');
    await run('propose_workflow', { name: 'f', runs_when: 'mondays', steps: ['x'], never: 'send anything on its own' });
    yes(); await run('publish_workflow');
    await run('no_second_workflow', { because: 'one thing' });
    await run('propose_authority', { always_ask: ['send_message'] }); yes(); await run('set_authority', {});
    await run('propose_research', { question: 'q', brief: 'b' }); yes(); await run('spawn_research_agent');
    rmSync(folder, { recursive: true, force: true });
    return { ...h, run };
  }

  test('a press that arrives before the model waits for it still counts', async () => {
    // The founder is allowed to be faster than the model. `teach_summon` puts
    // the card up, they press it while the next tool call is still being
    // emitted, and the latch is what stops that press being lost.
    const { manager, ws, run } = await readyToHandOver();
    await run('teach_summon');
    manager.onSummonPressed(ws);
    const res = await run('await_summon');
    expect(res).toContain('pressed it');
    expect(manager.beatsOf(ws)!.summonPressed).toBe(true);
  });

  test('a press that arrives while the model is waiting resolves the wait', async () => {
    const { manager, ws, run } = await readyToHandOver();
    await run('teach_summon');
    const waiting = run('await_summon');
    // Let the promise reach the waiter before the keystroke lands.
    await new Promise((r) => setTimeout(r, 5));
    manager.onSummonPressed(ws);
    expect(await waiting).toContain('pressed it');
  });

  test('the stand-down is broadcast, and the TRIAL is untouched by it', async () => {
    const { manager, ws, run, broadcast } = await readyToHandOver();
    const before = readTrialEntitlement()!;
    await run('teach_summon');
    manager.onSummonPressed(ws);
    await run('await_summon');

    const stand = broadcast.find((m) => m.type === 'trial_standdown');
    expect(stand).toBeDefined();
    expect((stand!.payload as { pressed: boolean }).pressed).toBe(true);

    // What it persists, and what it deliberately does not. This is the whole
    // contract of the handover: the conducted hour finished, the 48 did not.
    const after = readTrialEntitlement()!;
    expect(after.conductor_finished_at).not.toBeNull();
    expect(after.state).toBe(before.state);
    expect(after.started_at).toBe(before.started_at);
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.realtime).toEqual(before.realtime);
    expect(after.duration_ms).toBe(TRIAL_DURATION_MS);

    // And the conversation is still live: nothing here ends it (D17).
    expect(manager.isRunning(ws)).toBe(true);
  });

  test('a founder who never presses it still gets their shell back', async () => {
    const { manager, ws, run, broadcast } = await readyToHandOver();
    await run('teach_summon');
    // Nobody presses anything. The wait times out; the beat still finishes.
    const res = await run('await_summon');
    expect(res).toContain('did not press it');
    expect(broadcast.some((m) => m.type === 'trial_standdown')).toBe(true);
    expect(readTrialEntitlement()!.conductor_finished_at).not.toBeNull();
    expect(manager.beatsOf(ws)!.summonPressed).toBe(false);
  });

  test('a socket that goes away mid-wait does not leave a promise hanging', async () => {
    const { manager, ws, run } = await readyToHandOver();
    await run('teach_summon');
    const waiting = run('await_summon');
    await new Promise((r) => setTimeout(r, 5));
    manager.end(ws);
    expect(await waiting).toContain('did not press it');
  });

  test('pressing on a socket with no conductor is a no-op', () => {
    initDatabase(':memory:');
    const { manager, broadcast } = harness();
    manager.onSummonPressed({ id: 'nobody' });
    expect(broadcast).toHaveLength(0);
  });
});

/* ══════════ D41 · what the two rooms are told to do ══════════ */

describe('the rooms that explain themselves', () => {
  afterEach(() => closeDb());

  test('the goals beat drives the room over the bus every room already has', async () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    let t = T0;
    const { manager, ws, broadcast } = harness(() => t++);
    manager.arm(ws);
    manager.begin(ws);
    await manager.executeTool(ws, 'conclude_opening', { understanding: 'ok' });
    await manager.executeTool(ws, 'move_on', { because: 'not now' });
    await manager.executeTool(ws, 'propose_goals', DEEP_GOALS);
    manager.onUserSpeechStopped(ws);
    await manager.executeTool(ws, 'create_goals');

    // Ordinary room actions, in the ordinary envelope: no room learns anything
    // about the trial from this.
    const focus = broadcast.find(
      (m) => m.type === 'notification'
        && (m.payload as { action?: string }).action === 'focus_goal',
    );
    expect(focus).toBeDefined();
    expect((focus!.payload as { source: string; room: string }).source).toBe('room_action');
    expect((focus!.payload as { room: string }).room).toBe('goals');

    const walk = broadcast.find((m) => m.type === 'trial_walk');
    expect(walk).toBeDefined();
    const parts = (walk!.payload as { parts: { anchor: string }[]; room: string }).parts;
    expect((walk!.payload as { room: string }).room).toBe('goals');
    expect(parts[0]!.anchor).toBe(`goal:${manager.beatsOf(ws)!.objective!.id}`);
  });
});
