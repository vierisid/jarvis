import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WSMessage } from '../../comms/websocket.ts';
import { classifyAgentFailure } from '../../agents/task-failure.ts';
import { DayOneDirector, RETURN_SETTLE_MS } from './day-one-director.ts';
import { AMBIENT_SETTLE_MS, emptyFoundation, type DayOneFoundation, type DayOneOffer } from './day-one.ts';

const HANDOVER = 5_000_000;

function foundation(over: Partial<DayOneFoundation> = {}): DayOneFoundation {
  return {
    ...emptyFoundation(),
    handedOverAt: HANDOVER,
    objective: { id: 'obj1', title: '40 paying customers by the end of Q3', keyResults: [{ id: 'kr1', title: 'Paying customers 11 to 40' }] },
    board: [{ id: 't1', what: 'Northwind deliverable', first: true }],
    workflows: ['Monthly investor update'],
    landed: ['Northwind'],
    authorityLevel: 5,
    agent: { agentId: 'a1', taskId: 'task-1', agentName: 'What do the other schedulers charge', question: 'What do the other studio schedulers charge a seat?' },
    eveningHour: 19,
    ...over,
  };
}

type Harness = {
  dir: DayOneDirector;
  sent: WSMessage[];
  spoken: string[];
  executed: DayOneOffer[];
  setNow: (n: number) => void;
  setSurfaces: (n: number) => void;
  statePath: string;
};

let tmp: string;
let live: DayOneDirector[] = [];

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'day-one-')); });
afterEach(() => {
  for (const d of live) d.stop();
  live = [];
  rmSync(tmp, { recursive: true, force: true });
});

function harness(opts: { trialRunning?: boolean; surfaces?: number; now?: number; statePath?: string } = {}): Harness {
  const sent: WSMessage[] = [];
  const spoken: string[] = [];
  const executed: DayOneOffer[] = [];
  let now = opts.now ?? HANDOVER;
  let surfaces = opts.surfaces ?? 1;
  const statePath = opts.statePath ?? join(tmp, 'trial-day-one.json');
  const dir = new DayOneDirector({
    broadcast: (m) => sent.push(m),
    speak: async (t) => { spoken.push(t); },
    trialRunning: () => opts.trialRunning ?? true,
    surfaceCount: () => surfaces,
    readFoundation: () => foundation(),
    execute: async (o) => { executed.push(o); return { ok: true, says: 'Taken.' }; },
    statePath,
    now: () => now,
  });
  live.push(dir);
  return { dir, sent, spoken, executed, setNow: (n) => { now = n; }, setSurfaces: (n) => { surfaces = n; }, statePath };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/* ─────────────────────── the seam and beat 14 ─────────────────────── */

describe('day one begins at the handover, not before it', () => {
  test('nothing at all happens until begin() is called', () => {
    const h = harness();
    expect(h.dir.running()).toBe(false);
    h.dir.onAgentSettled({ taskId: 'task-1', response: 'x', failure: null });
    expect(h.sent).toEqual([]);
  });

  test('begin is idempotent: a second call does not restart the day', () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.dir.begin(foundation(), HANDOVER + 60_000);
    expect(h.dir.running()).toBe(true);
    const saved = JSON.parse(readFileSync(h.statePath, 'utf-8')) as { handedOverAt: number };
    expect(saved.handedOverAt).toBe(HANDOVER);
  });

  test('an expired trial stops everything, quietly', () => {
    const h = harness({ trialRunning: false });
    h.dir.begin(foundation(), HANDOVER);
    expect(h.dir.running()).toBe(false);
    h.dir.onAgentSettled({ taskId: 'task-1', response: 'a real finding about pricing', failure: null });
    expect(h.sent).toEqual([]);
  });
});

describe('D26 path A: the agent comes back and the pebble goes to it', () => {
  test('the finding, the offers and the row to point at all arrive together', async () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + RETURN_SETTLE_MS + 1);
    h.dir.onAgentSettled({
      taskId: 'task-1',
      response: 'They charge between 180 and 320 a seat.',
      failure: null,
    });
    await tick();

    const msg = h.sent.find((m) => m.type === 'trial_day_one');
    expect(msg).toBeDefined();
    const p = msg!.payload as Record<string, unknown>;
    expect(p.kind).toBe('agent_back');
    expect(p.answered).toBe(true);
    expect(String(p.finding)).toContain('180');
    expect((p.offers as unknown[]).length).toBeGreaterThan(0);
    // The gesture is a TARGET, not a coordinate: the daemon says which row and
    // the surface knows where its own pebble and its own strip are.
    expect(p.gesture).toEqual({
      room: 'agent_strip', anchor: 'agent:task-1', label: 'here it is', holdMs: 4_000,
    });
    expect(p.permanentHome).toBe('agents');
    expect(h.spoken.length).toBe(1);
  });

  test('it only fires for the finale\'s own agent, not for any task that settles', async () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    expect(h.dir.claimsAgent('task-1')).toBe(true);
    expect(h.dir.claimsAgent('some-other-task')).toBe(false);
    h.dir.onAgentSettled({ taskId: 'some-other-task', response: 'x', failure: null });
    await tick();
    expect(h.sent.filter((m) => m.type === 'trial_day_one')).toEqual([]);
  });

  test('it fires once, however many times the task settles', async () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + RETURN_SETTLE_MS + 1);
    for (let i = 0; i < 3; i++) {
      h.dir.onAgentSettled({ taskId: 'task-1', response: 'a finding', failure: null });
    }
    await tick();
    expect(h.sent.filter((m) => m.type === 'trial_day_one').length).toBe(1);
  });

  test('a run that died still comes back, and says which way it died', async () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + RETURN_SETTLE_MS + 1);
    h.dir.onAgentSettled({
      taskId: 'task-1', response: null,
      failure: classifyAgentFailure('429 credit_balance_exhausted'),
    });
    await tick();
    const p = h.sent.find((m) => m.type === 'trial_day_one')!.payload as Record<string, unknown>;
    expect(p.answered).toBe(false);
    expect((p.failure as { kind: string }).kind).toBe('billing');
    expect(String(p.says)).toContain('billing');
    // The beat keeps its shape: there is still an offer.
    expect((p.offers as unknown[]).length).toBeGreaterThan(0);
    // And the pebble still goes to the row, because the row is where the
    // founder can see what happened for themselves.
    expect(p.gesture).not.toBeNull();
  });
});

describe('D26 path B: nothing chases a founder who is not there', () => {
  test('with no surface on, nothing is pushed and nothing is spoken', async () => {
    const h = harness({ surfaces: 0 });
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + RETURN_SETTLE_MS + 1);
    h.dir.onAgentSettled({ taskId: 'task-1', response: 'a real finding', failure: null });
    await tick();
    expect(h.sent.filter((m) => m.type === 'trial_day_one')).toEqual([]);
    expect(h.spoken).toEqual([]);
  });

  test('and the next time they open anything, it is the first thing said', async () => {
    const h = harness({ surfaces: 0 });
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + RETURN_SETTLE_MS + 1);
    h.dir.onAgentSettled({ taskId: 'task-1', response: 'a real finding about pricing', failure: null });
    await tick();

    h.setSurfaces(1);
    h.setNow(HANDOVER + 4 * 60 * 60_000);
    h.dir.onSurfaceOpened();
    await new Promise((r) => setTimeout(r, 1_700));

    const p = h.sent.find((m) => m.type === 'trial_day_one')!.payload as Record<string, unknown>;
    expect(p.via).toBe('on_open');
    expect(String(p.says).startsWith('While you were away')).toBe(true);
    expect(h.spoken[0]!.startsWith('While you were away')).toBe(true);
  }, 4_000);

  test('a founder who was there does not get told about it a second time', async () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + RETURN_SETTLE_MS + 1);
    h.dir.onAgentSettled({ taskId: 'task-1', response: 'a finding', failure: null });
    await tick();
    h.dir.onSurfaceOpened();
    await new Promise((r) => setTimeout(r, 1_700));
    expect(h.sent.filter((m) => m.type === 'trial_day_one').length).toBe(1);
  }, 4_000);
});

/* ───────────────────────────── D27 ───────────────────────────── */

describe('D27: the offer is taken', () => {
  test('the founder presses one and the daemon does it', async () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + RETURN_SETTLE_MS + 1);
    h.dir.onAgentSettled({ taskId: 'task-1', response: 'a finding about pricing', failure: null });
    await tick();

    const offers = (h.sent.find((m) => m.type === 'trial_day_one')!.payload as { offers: DayOneOffer[] }).offers;
    const out = await h.dir.acceptOffer(offers[0]!.id);
    expect(out.ok).toBe(true);
    expect(h.executed.length).toBe(1);
    expect(h.sent.some((m) =>
      m.type === 'trial_day_one' && (m.payload as { kind?: string }).kind === 'offer_done',
    )).toBe(true);
  });

  test('an offer nobody made is refused rather than silently ignored', async () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    const out = await h.dir.acceptOffer('nonsense');
    expect(out.ok).toBe(false);
    expect(h.executed).toEqual([]);
  });

  test('an executor that throws does not take the daemon with it', async () => {
    const sent: WSMessage[] = [];
    const dir = new DayOneDirector({
      broadcast: (m) => sent.push(m),
      speak: async () => {},
      trialRunning: () => true,
      surfaceCount: () => 1,
      readFoundation: () => foundation(),
      execute: async () => { throw new Error('disk full'); },
      statePath: join(tmp, 'throwing.json'),
      now: () => HANDOVER + RETURN_SETTLE_MS + 1,
    });
    live.push(dir);
    dir.begin(foundation(), HANDOVER);
    dir.onAgentSettled({ taskId: 'task-1', response: 'a finding', failure: null });
    await tick();
    const offers = (sent.find((m) => m.type === 'trial_day_one')!.payload as { offers: DayOneOffer[] }).offers;
    const out = await dir.acceptOffer(offers[0]!.id);
    expect(out.ok).toBe(false);
    expect(out.says).toContain('Nothing of yours changed');
  });
});

/* ───────────────────────────── D29 ───────────────────────────── */

const AMBIENT_OK = {
  type: 'error',
  title: 'Fix for error in Cursor',
  body: 'The Northwind deliverable script is throwing on a missing column.',
  wouldDo: 'apply the fix',
};

describe('D29: the governor', () => {
  test('outside day one it lets everything through, without reading anything', () => {
    const h = harness();
    // Never begun.
    expect(h.dir.allowAmbient({ type: 'break', title: 'x', body: 'y' })).toBe(true);
  });

  test('inside day one it spends the budget and then stops', () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.setNow(HANDOVER + AMBIENT_SETTLE_MS + 1);
    expect(h.dir.allowAmbient(AMBIENT_OK)).toBe(true);

    // Same instant, so the ninety-minute gap refuses it.
    expect(h.dir.allowAmbient({ ...AMBIENT_OK, body: 'the monthly investor update is late' })).toBe(false);

    // Later, on a different subject: the second of the two.
    h.setNow(HANDOVER + AMBIENT_SETTLE_MS + 3 * 60 * 60_000);
    expect(h.dir.allowAmbient({ ...AMBIENT_OK, title: 'flow', body: 'the monthly investor update is late', wouldDo: 'run it' })).toBe(true);

    // And the third is refused on budget, however good it is.
    h.setNow(HANDOVER + AMBIENT_SETTLE_MS + 9 * 60 * 60_000);
    expect(h.dir.allowAmbient({ ...AMBIENT_OK, title: 'q', body: 'paying customers are behind the plan', wouldDo: 'draft it' })).toBe(false);
  });

  test('a resume keeps the handover time it restored, so the windows do not move', () => {
    const path = join(tmp, 'resume.json');
    const first = harness({ statePath: path });
    first.dir.begin(foundation(), HANDOVER);
    first.dir.stop();

    // The resume passes the entitlement's `conductor_finished_at`, which for a
    // record written by an older daemon may differ by a second or two. The
    // ledger's copy wins, because everything already measured is measured
    // against it.
    const second = harness({ statePath: path, now: HANDOVER + 60_000 });
    second.dir.begin(foundation(), HANDOVER + 30_000);
    const saved = JSON.parse(readFileSync(path, 'utf-8')) as { handedOverAt: number };
    expect(saved.handedOverAt).toBe(HANDOVER);
  });

  test('the budget survives a daemon restart', () => {
    const path = join(tmp, 'shared.json');
    const first = harness({ statePath: path });
    first.dir.begin(foundation(), HANDOVER);
    first.setNow(HANDOVER + AMBIENT_SETTLE_MS + 1);
    expect(first.dir.allowAmbient(AMBIENT_OK)).toBe(true);
    first.dir.stop();

    // A new daemon, same ledger, hours later. Resumed the way ws-service
    // resumes it at start-up: the foundation is re-read and `begin` is called
    // again with the handover time off the entitlement.
    const second = harness({ statePath: path, now: HANDOVER + 6 * 60 * 60_000 });
    second.dir.begin(foundation(), HANDOVER);
    expect(second.dir.running()).toBe(true);
    expect(second.dir.allowAmbient({ ...AMBIENT_OK, body: 'the monthly investor update is late', wouldDo: 'run it' })).toBe(true);
    expect(second.dir.allowAmbient({ ...AMBIENT_OK, body: 'paying customers are behind plan', wouldDo: 'draft it' })).toBe(false);
  });

  test('a corrupt ledger starts clean rather than taking the daemon down', async () => {
    const path = join(tmp, 'corrupt.json');
    await Bun.write(path, '{not json at all');
    expect(() => harness({ statePath: path })).not.toThrow();
  });
});

/* ───────────────────────────── D30 ───────────────────────────── */

describe('D30: the close of day one', () => {
  test('the day is written down as it happens, not reconstructed at the end', () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.dir.noteDayLine({ at: HANDOVER + HOUR, topic: 'Rewriting the pricing page', minutes: 95, apps: ['Cursor'] });
    h.dir.noteDayLine({ at: HANDOVER + 3 * HOUR, topic: 'Northwind deliverable', minutes: 40, apps: ['Notion'] });
    const close = h.dir.previewClose();
    expect(close.summary.length).toBe(2);
    expect(close.summary[0]).toContain('Rewriting the pricing page');
    expect(close.offers.length).toBeGreaterThan(0);
  });

  test('and the lines survive a restart, because retention does not reach them', () => {
    const path = join(tmp, 'lines.json');
    const first = harness({ statePath: path });
    first.dir.begin(foundation(), HANDOVER);
    first.dir.noteDayLine({ at: 1, topic: 'Rewriting the pricing page', minutes: 95, apps: ['Cursor'] });
    first.dir.stop();

    const second = harness({ statePath: path });
    expect(second.dir.previewClose().summary[0]).toContain('Rewriting the pricing page');
  });

  test('closing broadcasts a proposal with offers on it, and speaks once', () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.dir.noteDayLine({ at: 1, topic: 'Rewriting the pricing page', minutes: 95, apps: ['Cursor'] });
    h.dir.closeDay();
    const msg = h.sent.find((m) => (m.payload as { kind?: string }).kind === 'day_close');
    expect(msg).toBeDefined();
    const p = msg!.payload as Record<string, unknown>;
    expect((p.offers as unknown[]).length).toBeGreaterThan(0);
    expect(String(p.says)).toContain('take one of them off you');
    expect(h.spoken.length).toBe(1);
  });

  test('it closes once, and day one is over afterwards', () => {
    const h = harness();
    h.dir.begin(foundation(), HANDOVER);
    h.dir.closeDay();
    h.dir.closeDay();
    expect(h.sent.filter((m) => (m.payload as { kind?: string }).kind === 'day_close').length).toBe(1);
    expect(h.dir.running()).toBe(false);
  });

  test('a close with nobody watching says nothing out loud, but the card is there when they come back', () => {
    const h = harness({ surfaces: 0 });
    h.dir.begin(foundation(), HANDOVER);
    h.dir.closeDay();
    expect(h.spoken).toEqual([]);
    expect(h.sent.some((m) => (m.payload as { kind?: string }).kind === 'day_close')).toBe(true);
  });
});

const HOUR = 60 * 60_000;
