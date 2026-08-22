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
  const manager = new TrialConductorManager<Sock>({
    send: (ws, msg) => sent.push({ ws, msg }),
    broadcast: (msg) => broadcast.push(msg),
    now,
    clockGraceMs,
  });
  return { manager, sent, broadcast, ws: { id: 'a' } as Sock };
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

  test('entities landing are broadcast, not sent to the conductor socket alone', () => {
    // The memory room lives on the shell's own socket. A targeted send would
    // leave it waiting on its 8-second poll, which is not "in real time" (D22).
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws, broadcast, sent } = harness(() => T0);
    manager.arm(ws);
    manager.begin(ws);

    manager.executeTool(ws, 'remember', { entities: [{ name: 'Kestrel', type: 'concept', role: 'company' }] });

    const memory = broadcast.find((m) => m.type === 'trial_memory');
    expect(memory).toBeDefined();
    expect((memory!.payload as { landed: Array<{ name: string }> }).landed[0]!.name).toBe('Kestrel');
    expect(sent.filter((s) => s.msg.type === 'trial_memory')).toHaveLength(0);
  });

  test('concluding stamps the seam on the entitlement and announces it', () => {
    initDatabase(':memory:');
    issueTrialEntitlement({ now: T0 });
    const { manager, ws, broadcast } = harness(() => T0 + 1000);
    manager.arm(ws);
    manager.begin(ws);

    manager.executeTool(ws, 'conclude_opening', { understanding: 'Two-person B2B SaaS.' });

    expect(readTrialEntitlement()?.opening_completed_at).toBe(T0 + 1000);
    const done = broadcast.find((m) => m.type === 'trial_opening_complete');
    expect(done).toBeDefined();
    expect((done!.payload as { understanding: string }).understanding).toBe('Two-person B2B SaaS.');
  });

  test('a tool call on a socket with no conductor session is not the conductor\'s', () => {
    initDatabase(':memory:');
    const { manager, ws } = harness(() => T0);
    expect(manager.executeTool(ws, 'remember', {})).toBeNull();
  });
});
