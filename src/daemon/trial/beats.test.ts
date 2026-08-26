/**
 * The seven room beats, tested where they would break quietly.
 *
 * Not "does the tool return a string". The things that would ruin the session
 * without failing anything: a beat running out of order, a write landing that
 * the founder never saw, an authority level above the trial ceiling, a "late"
 * flag on a task that is not late, a failed compose being reported as live,
 * and the finale marking onboarding finished when nothing was spawned.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase } from '../../vault/schema.ts';
import { findGoals, getGoalChildren } from '../../vault/goals.ts';
import { findCommitments } from '../../vault/commitments.ts';
import {
  ROOM_BEATS,
  ROOM_BEAT_TOOLS,
  TRIAL_AUTHORITY_CEILING,
  TRIAL_AUTHORITY_PROPOSED,
  beatIsDone,
  beatIsOpen,
  clampAuthorityLevel,
  clampBriefHour,
  clampBriefMinute,
  baselineScore,
  closing,
  createBeatsSession,
  currentBeat,
  datedFindings,
  executeBeatTool,
  filesBrief,
  goalsBrief,
  tasksBrief,
  type BeatDeps,
  type BeatProposal,
  type BeatsSession,
  type FileFindings,
  type RoomBeat,
  type WorkflowProposal,
} from './beats.ts';
import { UNIX_HOST } from './host-paths.ts';

type Recorder = {
  deps: BeatDeps;
  rooms: string[];
  refreshed: string[];
  proposals: (BeatProposal | null)[];
  landed: { beat: RoomBeat; summary: string }[];
  marked: { beat: RoomBeat; label: string }[];
  completed: { beat: RoomBeat; detail: Record<string, unknown> }[];
  brief: { hour: number; minute: number } | null;
  evening: number | null;
  authority: number | null;
  alwaysAsk: string[];
  spawned: { question: string; brief: string }[];
  readerStarts: { folder: string; shortlist: string[]; about: string }[];
  reader: { found: string[]; finished: boolean; summary: string | null };
  readerFails: boolean;
  finished: number;
  workflowOk: boolean;
  /** Room actions the beats drove: `focus_goal`, `open_flow`, `refresh`. */
  actions: { room: string; action: string; args: Record<string, unknown> }[];
  /** The pebble walks, in order. */
  walks: { parts: { anchor: string; label?: string }[]; room?: string; kind?: string }[];
  /** What the founder did with the summon, and how many stand-downs happened. */
  summon: 'pressed' | 'timeout';
  stoodDown: { pressed: boolean; handedOverAt: number | null }[];
};

const NOW = 1_800_000_000_000;

/**
 * A clock that always moves forward, because the answered gate compares two
 * moments. Every tick is a millisecond, so the due-date arithmetic below is
 * unaffected and "did the founder speak after this went on screen" is a real
 * comparison rather than a tie.
 */
let step = 0;
const clock = () => NOW + step++;

/** The founder said something. That is all the server can ever know. */
function answers(s: BeatsSession): void {
  s.lastUserTurnAt = clock();
}

function recorder(over: Partial<BeatDeps> = {}): Recorder {
  const r: Recorder = {
    rooms: [], refreshed: [], proposals: [], landed: [], marked: [], completed: [],
    brief: null, evening: null, authority: null, alwaysAsk: [], spawned: [],
    readerStarts: [], reader: { found: [], finished: false, summary: null },
    readerFails: false, finished: 0, workflowOk: true,
    actions: [], walks: [], summon: 'pressed', stoodDown: [],
    deps: null as never,
  };
  r.deps = {
    now: clock,
    home: () => tmpHome,
    // Every test in this file is a Linux box unless it says otherwise, so
    // nothing here goes looking at whatever /mnt happens to hold on the
    // machine running the suite. The WSL behaviour has its own tests.
    host: () => UNIX_HOST,
    fuel: () => ({}),
    enterRoom: (beat) => { r.rooms.push(beat); },
    refreshRoom: (room) => { r.refreshed.push(room); },
    roomAction: (room, action, args) => { r.actions.push({ room, action, args }); },
    showParts: (parts, opts) => { r.walks.push({ parts, room: opts?.room, kind: opts?.kind }); },
    showProposal: (p) => { r.proposals.push(p); },
    proposalLanded: (beat, summary) => { r.landed.push({ beat, summary }); },
    roomIsTheirs: (beat, label) => { r.marked.push({ beat, label }); },
    beatComplete: (beat, detail) => { r.completed.push({ beat, detail }); },
    publishWorkflow: async (p: WorkflowProposal) =>
      r.workflowOk
        ? { ok: true as const, detail: `${p.steps.length} steps`, flowId: `flow-${p.name.toLowerCase().replace(/\W+/g, '-')}` }
        : { ok: false as const, detail: 'no piece for that' },
    setDailyRhythm: (morning, eveningHour) => { r.brief = morning; r.evening = eveningHour; },
    setAuthority: (level, alwaysAsk) => { r.authority = level; r.alwaysAsk = alwaysAsk; return { level, alwaysAsk }; },
    startFolderReader: async (opts) => {
      if (r.readerFails) throw new Error('sub-agents are not running on this install');
      r.readerStarts.push(opts);
      return { agentId: 'reader-1', taskId: 'read-1' };
    },
    readerProgress: () => ({ ...r.reader, found: [...r.reader.found] }),
    spawnResearchAgent: async (question, brief) => {
      r.spawned.push({ question, brief });
      return { agentId: 'agent-1', taskId: 'task-1', agentName: 'Research Analyst' };
    },
    onFinished: () => { r.finished++; },
    awaitSummon: async () => r.summon,
    standDown: (s) => { r.stoodDown.push({ pressed: s.summonPressed, handedOverAt: s.handedOverAt }); },
    ...over,
  };
  return r;
}

/** An opened session, as it is the instant `conclude_opening` fires. Under D44
 *  the beat it is standing in is `files`. */
function opened(): BeatsSession {
  const s = createBeatsSession();
  s.open = true;
  return s;
}

/**
 * An opened session standing at `beat`, with everything before it recorded as
 * done rather than performed.
 *
 * For the tests that are about one beat's own behaviour, where walking the
 * whole arc first would only add noise. D44 is what made this necessary:
 * `goals` used to be the first beat, so `opened()` was enough to be standing
 * in it, and now there are two beats in front of it.
 */
function standingAt(beat: RoomBeat): BeatsSession {
  const s = opened();
  for (const b of ROOM_BEATS) {
    if (b === beat) break;
    s.done.push(b);
  }
  return s;
}

/** A tree with the depth D41 requires: an end date, both numbers on every key
 *  result, and the first move underneath one of them. */
const GOALS_ARGS = {
  objective: '40 paying customers by the end of Q3',
  deadline: '2026-09-30',
  key_results: [
    { title: '12 booked demos a month', target: '12', today: '4' },
    { title: 'Month three churn under 4%', measure: 'under 4%', target: '4%', today: 'about 9%' },
  ],
  first_move: { what: 'Rewrite the pricing page', under: '12 booked demos a month', due: 'friday' },
};

/** The same tree as the model first says it, before the founder has been asked
 *  anything: one shape, no numbers, no move. This is what the beat used to
 *  accept and now refuses. */
const SHALLOW_GOALS_ARGS = {
  objective: '40 paying customers by the end of Q3',
  key_results: [
    { title: '12 booked demos a month' },
    { title: 'Month three churn under 4%', measure: 'under 4%' },
  ],
};

const TASKS_ARGS = {
  tasks: [
    { what: 'File the VAT return', due: new Date(NOW + 2 * 86_400_000).toISOString(), first: true },
    { what: 'Send Bowman the quote', due: 'friday', toward: '12 booked demos a month' },
  ],
};

const WORKFLOW_ARGS = {
  name: 'Monday pipeline review',
  runs_when: 'Mondays at 8',
  steps: ['Pull open deals', 'Flag stale ones'],
  never: 'email a client without you seeing it',
};

/** A real folder on disk with a couple of readable files in it, because
 *  `propose_reading` surveys for real and refuses anything it cannot see. */
let tmpHome: string;
let tmpFolder: string;
function folder(): string { return tmpFolder; }

/**
 * Walk the session up to `beat`, doing every beat before it for real.
 *
 * Written against ROOM_BEATS by name rather than by index since D44 moved the
 * file beats to the front: an index-shaped version of this helper is a thing
 * that keeps compiling and silently walks the wrong distance the next time
 * somebody reorders the list.
 */
async function walkTo(s: BeatsSession, r: Recorder, beat: RoomBeat): Promise<string> {
  let last = '';
  const run = async (n: string, a: Record<string, unknown> = {}) => {
    const res = await executeBeatTool(s, n, a, r.deps);
    if (res) last = res.message;
    return res;
  };
  const upto = ROOM_BEATS.indexOf(beat);
  // Skip anything already done, so a test can set a beat up by hand and then
  // walk the rest of the arc on top of it without doing the first part twice.
  const todo = (b: RoomBeat) => upto > ROOM_BEATS.indexOf(b) && !beatIsDone(s, b);

  if (todo('files')) { await run('propose_reading', { folder: folder() }); answers(s); await run('start_reading'); }
  if (todo('workspace')) { await run('move_on', { because: 'not now' }); }
  if (todo('goals')) { await run('propose_goals', GOALS_ARGS); answers(s); await run('create_goals'); }
  if (todo('tasks')) { await run('propose_tasks', TASKS_ARGS); answers(s); await run('create_tasks'); }
  if (todo('calendar')) {
    await run('propose_daily_rhythm', { hour: 7, minute: 30, evening_hour: 19 });
    answers(s);
    await run('set_daily_rhythm');
  }
  if (todo('workflows')) {
    await run('propose_workflow', WORKFLOW_ARGS);
    answers(s);
    await run('publish_workflow');
    // D16.5 wants two, and the beat no longer closes on one.
    await run('no_second_workflow', { because: 'the rest of their week is one-offs' });
  }
  if (todo('authority')) {
    await run('propose_authority', { always_ask: ['send_message'] });
    answers(s);
    await run('set_authority', {});
  }
  if (todo('agents')) {
    await run('propose_research', { question: 'q', brief: 'b' });
    answers(s);
    await run('spawn_research_agent');
  }
  // The last thing a commit hands back IS the next beat's brief: that is the
  // whole "what happens next" mechanism, so a test that wants to see the brief
  // for `beat` reads it here rather than calling the brief function.
  return last;
}

beforeEach(() => {
  initDatabase(':memory:');
  tmpHome = mkdtempSync(join(tmpdir(), 'beats-home-'));
  tmpFolder = join(tmpHome, 'Acme');
  mkdirSync(tmpFolder, { recursive: true });
  writeFileSync(join(tmpFolder, 'pitch.md'), '# Acme\nWe sell things to studios.', 'utf-8');
  writeFileSync(join(tmpFolder, 'numbers.csv'), 'month,revenue\nJul,4100', 'utf-8');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/* ─────────────────────── the order, D16 ─────────────────────── */

describe('D16, the order the beats happen in', () => {
  test('nothing opens while the opening is still running', async () => {
    const s = createBeatsSession();
    const r = recorder();
    const res = await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    expect(res!.message).toContain('conclude_opening');
    expect(r.proposals).toHaveLength(0);
    expect(findGoals({})).toHaveLength(0);
  });

  test('a beat cannot be skipped ahead to, and the refusal names where they are', async () => {
    const s = opened();
    const r = recorder();
    const res = await executeBeatTool(s, 'propose_workflow', {
      name: 'x', runs_when: 'mondays', steps: ['a'],
    }, r.deps);
    // D44: the beat they are standing in the instant the opening concludes is
    // `files`, so that is the one the refusal has to name.
    expect(res!.message).toContain('files');
    expect(r.proposals).toHaveLength(0);
  });

  test('reaching for their quarter while the reader is still working says what to do instead', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);
    expect(currentBeat(s)).toBe('workspace');

    const res = await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    // Not just "not yet". A model told only that stalls, and under D44 it
    // stalls three minutes into the session.
    expect(res!.message).toContain('reading_so_far');
    expect(res!.message).toContain('Keep talking');
    expect(findGoals({})).toHaveLength(0);
  });

  test('a finished beat stays open, so a task remembered later still lands', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'calendar');
    expect(currentBeat(s)).toBe('calendar');
    // They are standing in the calendar and remember another deadline.
    expect(beatIsOpen(s, 'tasks')).toBe(true);
    const res = await executeBeatTool(s, 'propose_tasks', { tasks: [{ what: 'Call the accountant' }] }, r.deps);
    expect(res!.message).toContain('On their screen');
  });

  test('D44: the two file beats come first, and the finale is still the finale', () => {
    expect([...ROOM_BEATS]).toEqual([
      'files', 'workspace', 'goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents',
      'handover',
    ]);
    // `memory` is not a stop (D16.1), and `agents` is still the last beat in
    // which anything is BUILT (D15): the finale is the only one that keeps
    // working after the talking ends. `handover` sits after it and builds
    // nothing at all; what it does is give the founder back the shell.
    expect((ROOM_BEATS as readonly string[]).includes('memory')).toBe(false);
    expect(ROOM_BEATS[ROOM_BEATS.length - 2]).toBe('agents');
    expect(ROOM_BEATS[ROOM_BEATS.length - 1]).toBe('handover');
    // D44's whole point: everything the two of them build is built AFTER the
    // real material has been read, not before it.
    for (const built of ['goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents'] as const) {
      expect(ROOM_BEATS.indexOf(built)).toBeGreaterThan(ROOM_BEATS.indexOf('files'));
    }
    // And the organised copy still comes straight off the back of the read.
    expect(ROOM_BEATS.indexOf('workspace')).toBe(ROOM_BEATS.indexOf('files') + 1);
  });
});

/* ─────────────────────── propose, then commit ─────────────────────── */

describe('D18, nothing is written that they have not seen', () => {
  test('every commit refuses when nothing is on their screen', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'goals');
    const first = await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(first!.message).toContain('propose');
    expect(findGoals({})).toHaveLength(0);

    await walkTo(s, r, 'tasks');
    r.proposals.length = 0;
    const tasks = await executeBeatTool(s, 'create_tasks', {}, r.deps);
    expect(tasks!.message).toContain('propose');
    expect(findCommitments({})).toHaveLength(0);
  });

  test('a commit refuses when they have not said anything since it went up', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    // Proposed and committed in the same breath, which is the drift this gate
    // exists to stop: the founder watching their quarter appear while Jarvis
    // is still asking whether to make it.
    const res = await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(res!.message).toContain('have not answered yet');
    expect(findGoals({})).toHaveLength(0);

    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(findGoals({ level: 'objective' })).toHaveLength(1);
  });

  test('every one of the commits is behind that gate, not just the first', async () => {
    const r = recorder();
    const cases: [RoomBeat, string, string, Record<string, unknown>][] = [
      ['goals', 'propose_goals', 'create_goals', GOALS_ARGS],
      ['tasks', 'propose_tasks', 'create_tasks', { tasks: [{ what: 'a', first: true }] }],
      ['calendar', 'propose_daily_rhythm', 'set_daily_rhythm', { hour: 8, evening_hour: 19 }],
      ['workflows', 'propose_workflow', 'publish_workflow', WORKFLOW_ARGS],
      ['authority', 'propose_authority', 'set_authority', { always_ask: ['send_message'] }],
      ['files', 'propose_reading', 'start_reading', {}],
    ];
    for (const [beat, propose, commit, args] of cases) {
      initDatabase(':memory:');
      const s = opened();
      await walkTo(s, r, beat);
      await executeBeatTool(s, propose, beat === 'files' ? { folder: folder() } : args, r.deps);
      const res = await executeBeatTool(s, commit, {}, r.deps);
      expect(res!.message).toContain('have not answered yet');
      expect(beatIsDone(s, beat)).toBe(false);
    }
  });

  test('the gate is satisfied by the VAD alone, so a failed transcription cannot end the trial', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    // No transcript ever arrives; only `input_audio_buffer.speech_stopped`
    // does. The conductor manager writes the same field from both.
    s.lastUserTurnAt = clock();
    const res = await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(res!.message).not.toContain('have not answered yet');
  });

  test('a retry after a failed publish does not make them say yes twice', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    await executeBeatTool(s, 'propose_workflow', WORKFLOW_ARGS, r.deps);
    answers(s);
    r.workflowOk = false;
    await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    r.workflowOk = true;
    const res = await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    expect(res!.message).not.toContain('have not answered yet');
    expect(s.workflowsPublished).toEqual(['Monday pipeline review']);
  });

  test('a commit cannot be handed different content from what was proposed', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    answers(s);
    // create_goals takes no arguments at all: whatever a model invents here is
    // ignored and the thing on their screen is what lands.
    await executeBeatTool(s, 'create_goals', { objective: 'Something else entirely' }, r.deps);
    const objectives = findGoals({ level: 'objective' });
    expect(objectives).toHaveLength(1);
    expect(objectives[0]!.title).toBe('40 paying customers by the end of Q3');
  });
});

/* ─────────────────────── beat 07 · goals ─────────────────────── */

describe('beat 07, goals', () => {
  test('proposing writes nothing and puts it on their screen', async () => {
    const s = standingAt('goals');
    const r = recorder();
    const res = await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    expect(findGoals({})).toHaveLength(0);
    expect(r.rooms).toEqual(['goals']);
    expect(r.proposals[0]).toMatchObject({ beat: 'goals', objective: GOALS_ARGS.objective });
    expect(res!.message).toContain('On their screen');
  });

  test('an objective with no key results is refused, not half-created', async () => {
    const s = standingAt('goals');
    const r = recorder();
    const res = await executeBeatTool(s, 'propose_goals', { objective: 'Grow', key_results: [] }, r.deps);
    expect(res!.message).toContain('Error');
    expect(r.proposals).toHaveLength(0);
  });

  test('committing builds the real tree and hands the model the next beat', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_goals', {}, r.deps);

    const objectives = findGoals({ level: 'objective' });
    expect(objectives).toHaveLength(1);
    expect(getGoalChildren(objectives[0]!.id)).toHaveLength(2);
    expect(objectives[0]!.status).toBe('active');
    expect(r.refreshed).toContain('goals');
    expect(r.landed[0]!.beat).toBe('goals');
    expect(s.proposal).toBeNull();
    // The seam to beat 08 is the tool result itself, and nothing else.
    expect(res!.message).toContain('propose_tasks');
  });
});

/* ─────────────────────── beat 08 · tasks ─────────────────────── */

describe('beat 08, tasks', () => {
  test('a due date in the past is late whatever the model said', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    const past = new Date(NOW - 3 * 86_400_000).toISOString();
    await executeBeatTool(s, 'propose_tasks', {
      tasks: [{ what: 'File the Q2 VAT return', due: past, late: false }],
    }, r.deps);
    expect((r.proposals.at(-1) as { tasks: { late: boolean }[] }).tasks[0]!.late).toBe(true);
  });

  test('a due date in the future is not late even when the model says it is', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    const future = new Date(NOW + 2 * 86_400_000).toISOString();
    await executeBeatTool(s, 'propose_tasks', {
      tasks: [{ what: 'Send the revised quote', due: future, late: true }],
    }, r.deps);
    expect((r.proposals.at(-1) as { tasks: { late: boolean }[] }).tasks[0]!.late).toBe(false);
  });

  test('plain language they actually said resolves to a real date', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    await executeBeatTool(s, 'propose_tasks', { tasks: [{ what: 'Write the launch page', due: 'tomorrow' }] }, r.deps);
    const due = (r.proposals.at(-1) as { tasks: { due: number | null }[] }).tasks[0]!.due;
    expect(due).not.toBeNull();
    expect(due! > NOW).toBe(true);
  });

  test('committing puts them on the board with their dates', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    await executeBeatTool(s, 'propose_tasks', {
      tasks: [
        { what: 'File the Q2 VAT return', due: new Date(NOW - 86_400_000).toISOString(), priority: 'critical', first: true },
        { what: 'Send Bowman the quote', due: new Date(NOW + 86_400_000).toISOString(), priority: 'high' },
      ],
    }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_tasks', {}, r.deps);
    const tasks = findCommitments({});
    expect(tasks).toHaveLength(2);
    expect(tasks.some((t) => t.priority === 'critical')).toBe(true);
    expect(res!.message).toContain('read_week');
  });
});

/* ─────────────────────── beat 09 · calendar ─────────────────────── */

describe('beat 09, calendar', () => {
  test('the week that is read back is the real one', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'calendar');
    const res = await executeBeatTool(s, 'read_week', {}, r.deps);
    expect(r.rooms).toContain('calendar');
    expect(res!.message).toContain('File the VAT return');
  });

  test('the hour they agree to is the hour that is written', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'calendar');
    await executeBeatTool(s, 'propose_daily_rhythm', {
      hour: 7, minute: 30, evening_hour: 19, because: 'you are at the desk by eight',
    }, r.deps);
    expect(r.brief).toBeNull();
    answers(s);
    const res = await executeBeatTool(s, 'set_daily_rhythm', {}, r.deps);
    expect(r.brief).toEqual({ hour: 7, minute: 30 });
    expect(r.evening).toBe(19);
    expect(s.briefAt).toEqual({ hour: 7, minute: 30 });
    expect(s.eveningHour).toBe(19);
    expect(res!.message).toContain('07:30');
    expect(res!.message).toContain('19:00');
  });

  test('an impossible hour is clamped rather than scheduled', () => {
    expect(clampBriefHour(25)).toBe(23);
    expect(clampBriefHour(-3)).toBe(0);
    expect(clampBriefHour('half seven')).toBe(7);
    expect(clampBriefMinute(90)).toBe(59);
    expect(clampBriefMinute(undefined)).toBe(0);
  });
});

/* ─────────────────────── beat 10 · workflows ─────────────────────── */

describe('beat 10, workflows', () => {
  test('a flow that fails to build is never reported as live', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    r.workflowOk = false;
    await executeBeatTool(s, 'propose_workflow', WORKFLOW_ARGS, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    expect(res!.message).toContain('Do not claim it is live');
    expect(s.workflowsPublished).toHaveLength(0);
    // The beat is NOT done, and the proposal stays on their screen: they are
    // still looking at a flow that was promised to them.
    expect(currentBeat(s)).toBe('workflows');
    expect(s.proposal).not.toBeNull();
  });

  test('the card says it is building, so the silence is legible', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    await executeBeatTool(s, 'propose_workflow', WORKFLOW_ARGS, r.deps);
    answers(s);
    r.proposals.length = 0;
    await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    expect((r.proposals[0] as WorkflowProposal).building).toBe(true);
  });

  test('D16.5: the beat does NOT close on one flow, so the second one happens', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    await executeBeatTool(s, 'propose_workflow', WORKFLOW_ARGS, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    expect(res!.message).toContain('That is one');
    // The old version handed over the authority brief here, which is exactly
    // why a second flow never happened: the model had its yes and moved on.
    expect(res!.message).not.toContain('propose_authority');
    expect(beatIsDone(s, 'workflows')).toBe(false);
    expect(beatIsOpen(s, 'authority')).toBe(false);

    // A second flow closes it, and only then does authority open.
    await executeBeatTool(s, 'propose_workflow', {
      ...WORKFLOW_ARGS, name: 'Friday goal check-in', runs_when: 'Fridays at 5',
    }, r.deps);
    answers(s);
    const second = await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    expect(s.workflowsPublished).toEqual(['Monday pipeline review', 'Friday goal check-in']);
    expect(beatIsDone(s, 'workflows')).toBe(true);
    expect(second!.message).toContain('propose_authority');
  });

  test('a founder whose week has one recurring thing is not given an invented second', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    await executeBeatTool(s, 'propose_workflow', WORKFLOW_ARGS, r.deps);
    answers(s);
    await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    const res = await executeBeatTool(s, 'no_second_workflow', { because: 'the rest is one-offs' }, r.deps);
    expect(s.onlyOneWorkflow).toBe(true);
    expect(beatIsDone(s, 'workflows')).toBe(true);
    expect(res!.message).toContain('propose_authority');
  });

  test('a flow with no line it must never cross is refused', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_workflow', {
      name: 'Monday pipeline review', runs_when: 'Mondays at 8', steps: ['Pull open deals'],
    }, r.deps);
    expect(res!.message).toContain('never cross');
    expect(r.proposals).toHaveLength(0);
  });

  test('`no_second_workflow` before anything was published is refused', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    const res = await executeBeatTool(s, 'no_second_workflow', { because: 'nothing' }, r.deps);
    expect(res!.message).toContain('Nothing has been published');
    expect(beatIsDone(s, 'workflows')).toBe(false);
  });
});

/* ─────────────────────── beat 11 · authority ─────────────────────── */

describe('beat 11, authority', () => {
  test('it asks for five', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', {}, r.deps);
    expect((r.proposals.at(-1) as { level: number }).level).toBe(TRIAL_AUTHORITY_PROPOSED);
  });

  test('the founder can pull it down and that is what lands', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', { always_ask: ['send_message'] }, r.deps);
    answers(s);
    await executeBeatTool(s, 'set_authority', { level: 3 }, r.deps);
    expect(r.authority).toBe(3);
    expect(s.authorityLevel).toBe(3);
  });

  test('D32, a founder who offers seven does not get seven, and is told so', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', { always_ask: ['send_message'] }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'set_authority', { level: 9 }, r.deps);
    expect(r.authority).toBe(TRIAL_AUTHORITY_CEILING);
    expect(res!.message).toContain('seven and above is not on the table');
  });

  test('the ceiling holds against anything a microphone could produce', () => {
    expect(clampAuthorityLevel(10)).toBe(TRIAL_AUTHORITY_CEILING);
    expect(clampAuthorityLevel(7)).toBe(TRIAL_AUTHORITY_CEILING);
    expect(clampAuthorityLevel(0)).toBe(1);
    expect(clampAuthorityLevel(-4)).toBe(1);
    expect(clampAuthorityLevel('ten')).toBe(TRIAL_AUTHORITY_PROPOSED);
    expect(clampAuthorityLevel(Infinity)).toBe(TRIAL_AUTHORITY_PROPOSED);
    expect(clampAuthorityLevel(null)).toBe(1);
  });
});

/* ─────────────────────── beat 12 · the finale ─────────────────────── */

describe('beat 12, the finale', () => {
  const QUESTION = 'How the three closest competitors price their onboarding';
  const BRIEF = 'Compare the published price and what is included.';

  test('the question goes on their screen before anyone is sent off with it', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_research', { question: QUESTION, brief: BRIEF }, r.deps);
    // Nothing spawned, and the founder is standing in the agents room looking
    // at an empty one when it does.
    expect(r.spawned).toHaveLength(0);
    expect(r.rooms.at(-1)).toBe('agents');
    expect(r.proposals.at(-1)).toMatchObject({ beat: 'agents', question: QUESTION, running: false });
    expect(res!.message).toContain('spawn_research_agent');
  });

  test('nothing is spawned before they have answered, or without a proposal', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    const cold = await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);
    expect(cold!.message).toContain('propose_research');
    expect(r.spawned).toHaveLength(0);

    await executeBeatTool(s, 'propose_research', { question: QUESTION, brief: BRIEF }, r.deps);
    const early = await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);
    expect(early!.message).toContain('They have not answered yet');
    expect(r.spawned).toHaveLength(0);
  });

  test('the agent is spawned on their own question and left visible, running', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'propose_research', { question: QUESTION, brief: BRIEF }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);
    expect(r.spawned).toEqual([{ question: QUESTION, brief: BRIEF }]);
    expect(s.agent?.agentId).toBe('agent-1');
    expect(s.finishedAt).toBeGreaterThanOrEqual(NOW);
    expect(r.finished).toBe(1);
    expect(r.refreshed).toContain('agents');
    // D22: the card stays and becomes the running thing, rather than
    // dissolving. It is the last surface of the session.
    expect(r.proposals.at(-1)).toMatchObject({ beat: 'agents', running: true, agentName: 'Research Analyst' });
    expect(s.proposal).toMatchObject({ beat: 'agents', running: true });
    expect(res!.message).toContain('Research Analyst is on it');
  });

  test('the close says what IT is doing next, and never hands the founder a job', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'propose_research', { question: QUESTION, brief: BRIEF }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);
    const m = res!.message;
    // The thing the second live run got wrong, in Vieri's words: "he just
    // said, oh go and post... it just seems like I have to go and do it."
    expect(m).toContain('what YOU are doing next, never what they should be doing next');
    expect(m).toContain('go and do their day');   // as a prohibition
    expect(m).not.toContain('they should go and do their day');
    // Built out of the ledger, so it is what is actually running.
    expect(m).toContain('Research Analyst is working on');
    expect(m).toContain('runs on its own from now on');
    expect(m).toContain('07:30');
    expect(m).toContain('19:00');
    expect(m).toContain('level 5');
  });

  test('a spawn that fails does not finish onboarding or claim an agent is running', async () => {
    const s = opened();
    const r = recorder({ spawnResearchAgent: async () => { throw new Error('no specialist installed'); } });
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'propose_research', { question: 'anything', brief: 'something' }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);
    expect(res!.message).toContain('Do not pretend it is running');
    expect(s.finishedAt).toBeNull();
    expect(r.finished).toBe(0);
  });

  test('the whole arc, in order, ends finished', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    await executeBeatTool(s, 'await_summon', {}, r.deps);
    expect(s.done).toEqual([...ROOM_BEATS]);
    expect(currentBeat(s)).toBeNull();
    expect(r.completed.map((c) => c.beat)).toEqual([...ROOM_BEATS]);
    // Every beat led them into its room, once each, and under D44 the first
    // room the founder is ever led into is the one their own documents land
    // in. `workspace` is declined on this walk, so it never enters anything;
    // it shares the memory room with `files` in any case, and `enterRoom` is a
    // no-op on an unchanged room.
    expect(r.rooms).toEqual(['files', 'goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents']);
  });
});

/* ─────────────────────── the briefs, D12 and D17 ─────────────────────── */

describe('the briefs the model reads between beats', () => {
  test('none of them tells the founder anything, or names a step', async () => {
    const s = opened();
    const r = recorder();
    const messages: string[] = [];
    const run = async (n: string, a: Record<string, unknown> = {}) => {
      const res = await executeBeatTool(s, n, a, r.deps);
      if (res) messages.push(res.message);
    };
    await run('propose_goals', GOALS_ARGS);
    await run('create_goals');
    await run('propose_tasks', { tasks: [{ what: 'a' }] });
    await run('create_tasks');
    await run('propose_morning_brief', { hour: 8 });
    await run('set_morning_brief');
    await run('propose_workflow', { name: 'f', runs_when: 'mondays', steps: ['x'] });
    await run('publish_workflow');
    await run('propose_authority', {});
    await run('set_authority', {});
    await run('spawn_research_agent', { question: 'q', brief: 'b' });

    const all = messages.join('\n');
    for (const banned of ['onboarding', 'wizard', 'next question', 'walkthrough', 'setup flow']) {
      expect(all.toLowerCase()).not.toContain(banned);
    }
  });

  test('the first brief carries their own words, not a paraphrase of them', () => {
    const brief = goalsBrief({ goal: 'Forty paying customers by the end of Q3.' });
    expect(brief).toContain('Forty paying customers by the end of Q3.');
    expect(brief).toContain('Say nothing about this');
  });

  test('a brief with no captured fuel is still a usable instruction', () => {
    const brief = goalsBrief({});
    expect(brief).toContain('propose_goals');
    expect(brief).not.toContain('undefined');
  });
});

/* ─────────────────────── anything else ─────────────────────── */

describe('the tool surface', () => {
  test('every advertised tool is actually routed', async () => {
    // A tool in the schema with no case in the executor falls through to the
    // caller's "Not available yet", which the founder hears as a promise
    // quietly broken. Every name the model can see has to reach a beat.
    const s = opened();
    const r = recorder();
    for (const tool of ROOM_BEAT_TOOLS) {
      const res = await executeBeatTool(createBeatsSession(), tool.name, {}, r.deps);
      expect(res).not.toBeNull();
    }
    expect(s.open).toBe(true);
  });

  test('nothing in the surface can navigate, run a command or spend anything', () => {
    const names = ROOM_BEAT_TOOLS.map((t) => t.name).join(' ');
    for (const banned of ['open_dashboard', 'run_command', 'browser', 'email', 'delete', 'install']) {
      expect(names).not.toContain(banned);
    }
  });
});

describe('anything that is not a beat tool', () => {
  test('falls through so the caller can refuse it', async () => {
    const s = opened();
    const r = recorder();
    expect(await executeBeatTool(s, 'manage_goals', {}, r.deps)).toBeNull();
    expect(await executeBeatTool(s, 'open_dashboard_room', { room: 'goals' }, r.deps)).toBeNull();
    expect(await executeBeatTool(s, 'remember', {}, r.deps)).toBeNull();
  });
});

/* ══════════════ D41 · the depth gates, beat by beat ══════════════

   These are the tests for the thing D41 actually changed. Each one asserts
   that a beat cannot be finished on the strength of one nod, and that the
   refusal tells the model what to go and ask rather than reading as an error
   it should apologise for. */

describe('D41, goals: a tree is not a plan until it has a starting line', () => {
  test('a shape with no numbers and no first move is refused, and nothing is written', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', SHALLOW_GOALS_ARGS, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(findGoals({})).toHaveLength(0);
    expect(beatIsDone(s, 'goals')).toBe(false);
    expect(res!.message).toContain('stands TODAY');
    expect(res!.message).toContain('first actual move');
    // Written as work to do, not as a failure to report to the founder.
    expect(res!.message).toContain('Ask them');
    expect(res!.message).not.toContain('Error');
  });

  test('one key result is refused: an objective said twice is not a tree', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', {
      objective: 'Grow',
      key_results: [{ title: 'More customers', target: '40', today: '9' }],
      first_move: { what: 'x', under: 'More customers', due: 'friday' },
    }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(res!.message).toContain('A second key result');
    expect(findGoals({})).toHaveLength(0);
  });

  test("a founder who does not know their number still gets past it: any answer counts", async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', {
      ...SHALLOW_GOALS_ARGS,
      key_results: [
        { title: '12 booked demos a month', target: '12', today: 'no idea, maybe two' },
        { title: 'Churn under 4%', target: '4%', today: "haven't measured it" },
      ],
      first_move: { what: 'Count last month', under: '12 booked demos a month', due: 'friday' },
    }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(res!.message).toContain('Created');
    // The gate is "you asked them", not "they had a number to hand".
    expect(findGoals({ level: 'key_result' })).toHaveLength(2);
  });

  test('the propose result tells the model which pass it still owes', async () => {
    const s = standingAt('goals');
    const r = recorder();
    const first = await executeBeatTool(s, 'propose_goals', SHALLOW_GOALS_ARGS, r.deps);
    expect(first!.message).toContain('Still owed');
    // ...and stops saying so once the tree is whole.
    const whole = await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    expect(whole!.message).not.toContain('Still owed');
    expect(whole!.message).toContain('whole tree');
  });

  test('the tree that lands has an end date, a baseline score and a first move', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);

    const objective = findGoals({ level: 'objective' })[0]!;
    expect(objective.deadline).toBe(Date.parse('2026-09-30'));

    const krs = getGoalChildren(objective.id);
    expect(krs).toHaveLength(2);
    // 4 of 12 is a third of the way, and that is where the key result opens.
    const demos = krs.find((g) => g.title.startsWith('12 booked'))!;
    expect(demos.score).toBeCloseTo(4 / 12, 5);
    expect(demos.score_reason).toContain('4 today');

    // The first move is a milestone under the key result they named.
    const milestone = getGoalChildren(demos.id);
    expect(milestone).toHaveLength(1);
    expect(milestone[0]!.title).toBe('Rewrite the pricing page');
    expect(milestone[0]!.level).toBe('milestone');
    expect(milestone[0]!.deadline).not.toBeNull();
  });

  test('a first move under a key result nobody can find still lands, under the objective', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', {
      ...GOALS_ARGS,
      first_move: { what: 'Rewrite the pricing page', under: 'something else entirely', due: 'friday' },
    }, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);
    const milestones = findGoals({ level: 'milestone' });
    expect(milestones).toHaveLength(1);
    expect(milestones[0]!.parent_id).toBe(findGoals({ level: 'objective' })[0]!.id);
  });

  test('a baseline that is not a number starts at zero rather than at a guess', async () => {
    expect(baselineScore({ title: 'x', target: '40', today: '10' })).toBe(0.25);
    expect(baselineScore({ title: 'x', target: '40', today: 'no idea' })).toBe(0);
    expect(baselineScore({ title: 'x', today: '10' })).toBe(0);
    // Already past it is 1.0, not 1.6.
    expect(baselineScore({ title: 'x', target: '40', today: '64' })).toBe(1);
  });

  test('a number to get UNDER is not scored as if it were a number to reach', async () => {
    // The one that matters: churn at 9% against a 4% target is a quarter of
    // the way there. Scored naively it reads 2.25, clamps to 1.0, and the
    // goals room tells the founder the hardest thing on their tree is done.
    expect(baselineScore({ title: 'Month three churn under 4%', target: '4%', today: 'about 9%' })).toBeCloseTo(4 / 9, 5);
    expect(baselineScore({ title: 'Month three churn under 4%', target: '4%', today: '3%' })).toBe(1);
    expect(baselineScore({ title: 'Burn below 15k a month', target: '15000', today: '18400' })).toBeCloseTo(15 / 18.4, 3);
    expect(baselineScore({ title: 'Reply in less than 2 hours', target: '2', today: '6' })).toBeCloseTo(1 / 3, 5);
    expect(baselineScore({ title: 'Cut the review cycle to 3 days', target: '3', today: '9' })).toBeCloseTo(1 / 3, 5);
    // And a growth target is still a growth target.
    expect(baselineScore({ title: '40 paying customers', target: '40', today: '64' })).toBe(1);
    expect(baselineScore({ title: '12 booked demos a month', target: '12', today: '4' })).toBeCloseTo(1 / 3, 5);
  });

  test('the churn key result lands in the vault with the honest score on it', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', {
      objective: 'Keep the customers we win',
      key_results: [
        { title: 'Month three churn under 4%', target: '4%', today: 'about 9%' },
        { title: 'Twelve reference calls done', target: '12', today: '3' },
      ],
      first_move: { what: 'Call the three who left', under: 'Month three churn under 4%', due: 'friday' },
    }, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);
    const churn = findGoals({ level: 'key_result' }).find((g) => g.title.startsWith('Month three'))!;
    expect(churn.score).toBeCloseTo(4 / 9, 5);
    expect(churn.score).toBeLessThan(1);
  });
});

describe('D41, tasks: the founder picks the one they do first', () => {
  test('a board with nothing chosen is refused', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    await executeBeatTool(s, 'propose_tasks', { tasks: [{ what: 'a' }, { what: 'b' }] }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_tasks', {}, r.deps);
    expect(res!.message).toContain('which single thing they do next');
    expect(res!.message).toContain('Do not choose it for them');
    expect(findCommitments({})).toHaveLength(0);
  });

  test('two marked first is the same as none, because it is', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    await executeBeatTool(s, 'propose_tasks', {
      tasks: [{ what: 'a', first: true }, { what: 'b', first: true }],
    }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_tasks', {}, r.deps);
    expect(res!.message).toContain('2 of these are marked first');
    expect(findCommitments({})).toHaveLength(0);
  });

  test('the chosen one goes on the board first and says so, and `toward` is on the row', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    await executeBeatTool(s, 'propose_tasks', {
      tasks: [
        { what: 'Answer the accountant' },
        { what: 'Rewrite the pricing page', first: true, toward: '12 booked demos a month' },
      ],
    }, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_tasks', {}, r.deps);
    const board = findCommitments({}).sort((a, b) => a.created_at - b.created_at);
    expect(board[0]!.what).toBe('Rewrite the pricing page');
    expect(board[0]!.context).toContain('first thing');
    expect(board[0]!.context).toContain('toward: 12 booked demos a month');
    expect(board[1]!.context).toBeNull();
  });

  test('the propose result says the ratio out loud, including when it is none', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'tasks');
    const none = await executeBeatTool(s, 'propose_tasks', {
      tasks: [{ what: 'a', first: true }, { what: 'b' }],
    }, r.deps);
    expect(none!.message).toContain('None of these 2 point at the quarter');
    const some = await executeBeatTool(s, 'propose_tasks', {
      tasks: [{ what: 'a', first: true, toward: 'demos' }, { what: 'b' }],
    }, r.deps);
    expect(some!.message).toContain('1 of 2 point at the quarter');
  });
});

describe('D41, calendar: both ends of the day or it is a notification', () => {
  test('the morning alone is refused and nothing is written', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'calendar');
    await executeBeatTool(s, 'propose_daily_rhythm', { hour: 7, minute: 30 }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'set_daily_rhythm', {}, r.deps);
    expect(res!.message).toContain('when they actually stop working');
    expect(r.brief).toBeNull();
    expect(beatIsDone(s, 'calendar')).toBe(false);
  });

  test('the propose result asks for the missing half rather than defaulting one', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'calendar');
    const res = await executeBeatTool(s, 'propose_daily_rhythm', { hour: 7 }, r.deps);
    expect(res!.message).toContain('no evening yet');
    expect((r.proposals.at(-1) as { eveningHour: number | null }).eveningHour).toBeNull();
  });

  test('read_week reads the quarter back alongside the week', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'calendar');
    const res = await executeBeatTool(s, 'read_week', {}, r.deps);
    expect(res!.message).toContain('What the quarter has dates on');
    expect(res!.message).toContain('40 paying customers by the end of Q3');
  });
});

describe('D41, authority: the number is half of it', () => {
  test('a level with no carve-out is refused, and the choices are named', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', {}, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'set_authority', {}, r.deps);
    expect(res!.message).toContain('what still comes to them first');
    expect(res!.message).toContain('execute_command');
    expect(r.authority).toBeNull();
    expect(beatIsDone(s, 'authority')).toBe(false);
  });

  test('only categories level 5 can actually reach are accepted', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', {
      always_ask: ['send_message', 'make_payment', 'nonsense', 'send_message'],
    }, r.deps);
    // `make_payment` is level 9 and `nonsense` is not a category: offering
    // either would be a choice about nothing.
    expect((r.proposals.at(-1) as { alwaysAsk: string[] }).alwaysAsk).toEqual(['send_message']);
  });

  test('what they name at the moment of granting beats what was proposed', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', { always_ask: ['send_message'] }, r.deps);
    answers(s);
    await executeBeatTool(s, 'set_authority', { level: 5, always_ask: ['execute_command', 'write_data'] }, r.deps);
    expect(r.alwaysAsk).toEqual(['execute_command', 'write_data']);
    expect(s.alwaysAsk).toEqual(['execute_command', 'write_data']);
  });
});

describe('D41, the founder comes out knowing where things live', () => {
  test('every beat marks its room once the work in it is real, and not before', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    // The lead-in gesture has fired; the door has not been marked, because
    // nothing of theirs is in there yet.
    expect(r.rooms).toEqual(['goals']);
    expect(r.marked).toHaveLength(0);
    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(r.marked).toEqual([{ beat: 'goals', label: 'your quarter lives here' }]);
  });

  test('across the whole arc, each room is named for what it now holds', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'propose_research', { question: 'q', brief: 'b' }, r.deps);
    answers(s);
    await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);
    expect(r.marked.map((m) => m.beat)).toEqual([
      'files', 'goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents',
    ]);
    // In the founder's terms, never in feature names, and never a tour.
    for (const m of r.marked) {
      expect(m.label.length).toBeLessThan(40);
      expect(m.label).not.toMatch(/room|dashboard|onboarding|step|setup/i);
    }
  });

  test('a beat they declined does not claim its room is theirs', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    r.marked.length = 0;
    await executeBeatTool(s, 'move_on', { because: 'no' }, r.deps);
    expect(r.marked).toHaveLength(0);
  });
});

/* ══════════════ D42 · reading their own files ══════════════ */

/* ══════════ the founder's files are on Windows and the daemon is not ══════════

   The second live run: he named a folder, nothing was found, he asked what
   folders it had access to, and it could not name one. Both halves of that are
   tested here, on a WSL machine that is entirely made of temp directories, so
   these run identically on Linux, on macOS and in CI. */

describe('D42 on WSL: the path a founder actually says', () => {
  let drive: string;
  let winHome: string;
  let winDocs: string;
  let wsl: { kind: 'wsl'; driveRoot: string };
  let wslDeps: Recorder;

  beforeEach(() => {
    drive = mkdtempSync(join(tmpdir(), 'beats-drive-'));
    winHome = join(drive, 'c', 'Users', 'vieri');
    winDocs = join(winHome, 'Documents', 'Kestrel');
    mkdirSync(winDocs, { recursive: true });
    writeFileSync(join(winDocs, 'deck.md'), '# Kestrel\nWe sell to studios.', 'utf-8');
    writeFileSync(join(winDocs, 'pricing.md'), 'Starter 40 a seat.', 'utf-8');
    wsl = { kind: 'wsl', driveRoot: drive };
    wslDeps = recorder({ host: () => wsl });
  });

  afterEach(() => {
    rmSync(drive, { recursive: true, force: true });
  });

  test('THE BUG: C:\\Users\\... resolves to the real folder instead of vanishing', async () => {
    const s = opened();
    await walkTo(s, wslDeps, 'files');
    wslDeps.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_reading', { folder: 'C:\\Users\\vieri\\Documents\\Kestrel' }, wslDeps.deps);
    const card = wslDeps.proposals.at(-1) as { folder: string; says: string; willRead: number };
    expect(card.folder).toBe(winDocs);
    expect(card.willRead).toBe(2);
    // And it is said back to them in the spelling they used, never as /mnt.
    expect(card.says).toBe('C:\\Users\\vieri\\Documents\\Kestrel');
    expect(res!.message).toContain('C:\\Users\\vieri\\Documents\\Kestrel');
  });

  test('forward slashes work too, because half of them type it that way', async () => {
    const s = opened();
    await walkTo(s, wslDeps, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: 'C:/Users/vieri/Documents/Kestrel' }, wslDeps.deps);
    expect((wslDeps.proposals.at(-1) as { folder: string }).folder).toBe(winDocs);
  });

  test('a bare folder name is looked for on the Windows side as well', async () => {
    const s = opened();
    await walkTo(s, wslDeps, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: 'Documents/Kestrel' }, wslDeps.deps);
    expect((wslDeps.proposals.at(-1) as { folder: string }).folder).toBe(winDocs);
  });

  test('the Windows side of the fence: the drive, the Users folder and a profile are all too broad', async () => {
    const s = opened();
    await walkTo(s, wslDeps, 'files');
    wslDeps.proposals.length = 0;
    for (const [said, why] of [
      ['C:\\', 'the whole of that drive'],
      ['C:\\Users', 'every account on this machine'],
      ['C:\\Users\\vieri', 'your Windows home directory'],
      ['C:\\Windows\\System32', 'a system directory'],
    ] as const) {
      const res = await executeBeatTool(s, 'propose_reading', { folder: said }, wslDeps.deps);
      expect(res!.message).toContain(why);
    }
    expect(wslDeps.proposals).toHaveLength(0);
  });

  test('ON LINUX the same string is not translated, so nothing here changes for anyone else', async () => {
    const s = opened();
    const r = recorder();   // UNIX_HOST
    await walkTo(s, r, 'files');
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_reading', { folder: 'C:\\Users\\vieri\\Documents' }, r.deps);
    expect(res!.message).toContain('Not that');
    expect(r.proposals).toHaveLength(0);
  });
});

describe('"what folders do you have access to?" has an answer', () => {
  test('it offers real folders that exist and have something in them', async () => {
    const s = opened();
    const r = recorder();
    mkdirSync(join(tmpHome, 'Projects', 'kestrel'), { recursive: true });
    writeFileSync(join(tmpHome, 'Projects', 'kestrel', 'plan.md'), 'x', 'utf-8');
    const res = await executeBeatTool(s, 'folders_i_can_see', {}, r.deps);
    expect(res!.message).toContain('Projects');
    expect(res!.message).toContain('Acme');
    expect(res!.message).toContain('Nothing has been read');
  });

  test('it can be asked at any point after the opening, not only in the files beat', async () => {
    const s = opened();
    const r = recorder();
    // Standing in the goals beat, well past the one moment a folder is
    // actually asked for, which is where a founder is most likely to wonder
    // out loud what this thing can see.
    await walkTo(s, r, 'goals');
    expect(currentBeat(s)).toBe('goals');
    const res = await executeBeatTool(s, 'folders_i_can_see', {}, r.deps);
    expect(res!.message).not.toContain('Not yet');
    expect(res!.message).toContain('Acme');
  });

  test('before the opening concludes there is nothing to look at yet', async () => {
    const s = createBeatsSession();
    const r = recorder();
    const res = await executeBeatTool(s, 'folders_i_can_see', {}, r.deps);
    expect(res!.message).toContain('conclude_opening');
  });

  test('a folder that is not there comes back with what was tried and what IS there', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_reading', { folder: 'Kestrel' }, r.deps);
    expect(res!.message).toContain('Where this machine looked');
    expect(res!.message).toContain(join(tmpHome, 'Kestrel'));
    expect(res!.message).toContain('What IS on this machine');
    expect(res!.message).toContain('Acme');
    // The sentence that made the founder think it was blind, now banned.
    expect(res!.message).toContain('Do not tell them you have no access to their files');
    expect(r.proposals).toHaveLength(0);
  });

  test('a folder named with the wrong capitals still resolves', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    r.proposals.length = 0;
    await executeBeatTool(s, 'propose_reading', { folder: 'acme' }, r.deps);
    expect((r.proposals.at(-1) as { folder: string }).folder).toBe(tmpFolder);
  });
});

describe('D42, the approval names what will be read', () => {
  test('the card carries the folder, the counts and real filenames', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    const res = await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    const card = r.proposals.at(-1) as {
      beat: string; folder: string; willRead: number; total: number; sample: string[]; reading?: boolean;
    };
    expect(card.beat).toBe('files');
    expect(card.folder).toBe(tmpFolder);
    expect(card.total).toBe(2);
    expect(card.willRead).toBe(2);
    expect(card.sample.sort()).toEqual(['numbers.csv', 'pitch.md']);
    expect(card.reading).toBeUndefined();
    // And nothing has been read.
    expect(r.readerStarts).toHaveLength(0);
    expect(res!.message).toContain('Nothing is read until they answer');
  });

  test('proposing reads nothing: no agent, no vault write', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    expect(r.readerStarts).toHaveLength(0);
    expect(s.files).toBeNull();
    expect(beatIsDone(s, 'files')).toBe(false);
  });

  test('a start without a spoken answer since the card went up is refused', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    const res = await executeBeatTool(s, 'start_reading', {}, r.deps);
    expect(res!.message).toContain('have not answered yet');
    expect(r.readerStarts).toHaveLength(0);
  });

  test('an earlier yes to a DIFFERENT folder does not carry over', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    // The founder changes their mind and names another folder; the card is
    // replaced, and the answer they gave about the first one is not an answer
    // about the second.
    const other = join(tmpHome, 'Other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'notes.md'), 'notes', 'utf-8');
    await executeBeatTool(s, 'propose_reading', { folder: other }, r.deps);
    const res = await executeBeatTool(s, 'start_reading', {}, r.deps);
    expect(res!.message).toContain('have not answered yet');
    expect(r.readerStarts).toHaveLength(0);
  });

  test('what starts is exactly the shortlist they were shown', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);
    expect(r.readerStarts).toHaveLength(1);
    expect(r.readerStarts[0]!.folder).toBe(tmpFolder);
    expect(r.readerStarts[0]!.shortlist.sort()).toEqual(['numbers.csv', 'pitch.md']);
  });

  test('the home directory and the whole disk are refused, and nothing goes on screen', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    r.proposals.length = 0;
    for (const bad of [tmpHome, '/', '/etc']) {
      const res = await executeBeatTool(s, 'propose_reading', { folder: bad }, r.deps);
      expect(res!.message).toContain('Not that');
      expect(res!.message).toContain('Do not widen it');
    }
    expect(r.proposals).toHaveLength(0);
  });

  test('an empty folder is said out loud, not read', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    const empty = join(tmpHome, 'Empty');
    mkdirSync(empty, { recursive: true });
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_reading', { folder: empty }, r.deps);
    expect(res!.message).toContain('has nothing in it');
    expect(res!.message).toContain('Nothing has been read');
    expect(r.proposals).toHaveLength(0);
  });

  test('a folder of nothing but PDFs admits it cannot open them', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    const opaque = join(tmpHome, 'Decks');
    mkdirSync(opaque, { recursive: true });
    writeFileSync(join(opaque, 'deck.pdf'), '%PDF', 'utf-8');
    writeFileSync(join(opaque, 'brief.docx'), 'PK', 'utf-8');
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_reading', { folder: opaque }, r.deps);
    expect(res!.message).toContain('none that can be opened as text');
    expect(res!.message).toContain('Do not pretend to have read a PDF');
    expect(r.proposals).toHaveLength(0);
  });

  test('a reader that will not start does not claim anything is being read', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    r.readerFails = true;
    const res = await executeBeatTool(s, 'start_reading', {}, r.deps);
    expect(res!.message).toContain('do not claim anything is being read');
    expect(s.files).toBeNull();
    expect(beatIsDone(s, 'files')).toBe(false);
  });
});

describe('D42, it runs in the background and the founder is not made to watch', () => {
  test('the beat completes the moment it starts, so the conversation carries on (D17)', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'start_reading', {}, r.deps);
    expect(beatIsDone(s, 'files')).toBe(true);
    expect(res!.message).toContain('Do NOT wait for it');
    // And the card flips to reading rather than continuing to ask.
    expect((r.proposals.at(-1) as { reading?: boolean }).reading).toBe(true);
  });

  test('nothing found yet is silence, not an announcement', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workspace');
    const res = await executeBeatTool(s, 'reading_so_far', {}, r.deps);
    expect(res!.message).toContain('Say NOTHING about it');
  });

  test('what has landed comes back with what to do about it', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workspace');
    r.reader.found = ['Bowman & Co (client)', 'Ana (co-founder)'];
    const res = await executeBeatTool(s, 'reading_so_far', {}, r.deps);
    expect(res!.message).toContain('Bowman & Co (client)');
    expect(res!.message).toContain('still reading');
    expect(s.files!.found).toBe(2);
    // The card counts up with it, so the founder sees the same number.
    expect((r.proposals.at(-1) as { found?: number }).found).toBe(2);
  });

  test('finished and found nothing is said straight, and never invented', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workspace');
    r.reader = { found: [], finished: true, summary: 'It is a folder of holiday photos.' };
    const res = await executeBeatTool(s, 'reading_so_far', {}, r.deps);
    expect(res!.message).toContain('found nothing about the company');
    expect(res!.message).toContain('without inventing a finding');
    expect(res!.message).toContain('holiday photos');
  });

  test('`reading_so_far` with no reader running says nothing at all', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    const res = await executeBeatTool(s, 'reading_so_far', {}, r.deps);
    expect(res!.message).toContain('Nothing is being read');
  });
});

/* ══════════════ D43 · acting on what it read ══════════════ */

describe('D43, the organised folder', () => {
  async function readFiles(s: BeatsSession, r: Recorder): Promise<void> {
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);
    // The reader has to have actually found something before there is a
    // folder to organise. `propose_workspace` refuses otherwise, which is the
    // point: under D44 this beat starts three minutes in, and a model with
    // nothing else to do will happily invent a filing system for documents it
    // has not read.
    r.reader = { found: ['Acme (company)', 'Northwind (client)'], finished: true, summary: 'Sells to studios.' };
    await executeBeatTool(s, 'reading_so_far', {}, r.deps);
  }

  const SECTIONS = {
    title: 'Acme',
    sections: [
      { name: 'the pitch', about: 'what you tell people', files: ['pitch.md'] },
      { name: 'money', about: 'the numbers', files: ['numbers.csv'] },
    ],
  };

  test('it copies, and every original is exactly where it was', async () => {
    const s = opened();
    const r = recorder();
    await readFiles(s, r);
    await executeBeatTool(s, 'propose_workspace', SECTIONS, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_workspace', {}, r.deps);

    const dest = s.workspace!.destination;
    expect(s.workspace!.copied).toBe(2);
    expect(readFileSync(join(dest, 'the pitch', 'pitch.md'), 'utf-8')).toContain('We sell things');
    expect(readFileSync(join(tmpFolder, 'pitch.md'), 'utf-8')).toContain('We sell things');
    expect(readdirSync(tmpFolder).sort()).toEqual(['numbers.csv', 'pitch.md']);
    expect(readFileSync(join(dest, 'README.md'), 'utf-8')).toContain('Nothing was moved and nothing was deleted');
    expect(res!.message).toContain('Every original is untouched');
  });

  test('the folder goes beside their own, never inside it', async () => {
    const s = opened();
    const r = recorder();
    await readFiles(s, r);
    await executeBeatTool(s, 'propose_workspace', SECTIONS, r.deps);
    const card = r.proposals.at(-1) as { destination: string; source: string };
    expect(card.source).toBe(tmpFolder);
    expect(card.destination.startsWith(tmpFolder + '/')).toBe(false);
    expect(card.destination.startsWith(tmpHome)).toBe(true);
  });

  test('a destination with their work already in it is refused before anything is written', async () => {
    const s = opened();
    const r = recorder();
    await readFiles(s, r);
    const taken = join(tmpHome, 'Taken');
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'mine.md'), 'my work', 'utf-8');
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_workspace', { ...SECTIONS, destination: taken }, r.deps);
    expect(res!.message).toContain('already exists and has things in it');
    expect(r.proposals).toHaveLength(0);
    expect(readFileSync(join(taken, 'mine.md'), 'utf-8')).toBe('my work');
  });

  test('a destination that appears between the offer and the yes is caught at write time', async () => {
    const s = opened();
    const r = recorder();
    await readFiles(s, r);
    const dest = join(tmpHome, 'Later');
    await executeBeatTool(s, 'propose_workspace', { ...SECTIONS, destination: dest }, r.deps);
    // The founder is talking; something else creates the folder in the meantime.
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'theirs.md'), 'not yours', 'utf-8');
    answers(s);
    const res = await executeBeatTool(s, 'create_workspace', {}, r.deps);
    expect(res!.message).toContain('Stopped before writing anything');
    expect(readFileSync(join(dest, 'theirs.md'), 'utf-8')).toBe('not yours');
    expect(s.workspace).toBeNull();
  });

  test('offering to organise files that were never read is refused', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workspace');
    s.files = null;
    const res = await executeBeatTool(s, 'propose_workspace', SECTIONS, r.deps);
    expect(res!.message).toContain('no folder was ever read');
    expect(res!.message).toContain('move_on');
  });

  test('an empty scaffold is refused: sections with no files are not an improvement', async () => {
    const s = opened();
    const r = recorder();
    await readFiles(s, r);
    const res = await executeBeatTool(s, 'propose_workspace', {
      title: 'Acme', sections: [{ name: 'the pitch', about: 'x', files: [] }],
    }, r.deps);
    expect(res!.message).toContain('empty scaffold');
  });
});

describe('D43, one real piece of work', () => {
  async function upToWorkspace(s: BeatsSession, r: Recorder): Promise<void> {
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);
    r.reader = { found: ['Acme (company)'], finished: true, summary: 'Sells to studios.' };
    await executeBeatTool(s, 'reading_so_far', {}, r.deps);
    await executeBeatTool(s, 'propose_workspace', {
      title: 'Acme',
      sections: [{ name: 'the pitch', about: 'what you tell people', files: ['pitch.md'] }],
    }, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_workspace', {}, r.deps);
  }

  test('it can only offer to change a file that actually exists and can be read', async () => {
    const s = opened();
    const r = recorder();
    await upToWorkspace(s, r);
    r.proposals.length = 0;
    const missing = await executeBeatTool(s, 'propose_edit', {
      file: 'the-deck-i-imagined.md', change: 'make it better',
    }, r.deps);
    expect(missing!.message).toContain('Cannot offer that');
    expect(r.proposals).toHaveLength(0);

    const outside = await executeBeatTool(s, 'propose_edit', {
      file: '../secrets.txt', change: 'tidy it',
    }, r.deps);
    expect(outside!.message).toContain('outside the folder you were given');
    expect(r.proposals).toHaveLength(0);
  });

  test('the offer carries what is in the file today, so the model is not guessing', async () => {
    const s = opened();
    const r = recorder();
    await upToWorkspace(s, r);
    const res = await executeBeatTool(s, 'propose_edit', {
      file: 'pitch.md', change: 'it never says who it is for',
    }, r.deps);
    expect(res!.message).toContain('We sell things to studios');
    expect((r.proposals.at(-1) as { as: string }).as).toBe('pitch - rewritten.md');
  });

  test('the rewrite is a new file and theirs is byte-identical afterwards', async () => {
    const s = opened();
    const r = recorder();
    await upToWorkspace(s, r);
    const before = readFileSync(join(tmpFolder, 'pitch.md'), 'utf-8');
    await executeBeatTool(s, 'propose_edit', { file: 'pitch.md', change: 'say who it is for' }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'make_edit', { body: '# Acme\nFor studios of three to ten.' }, r.deps);

    expect(readFileSync(join(tmpFolder, 'pitch.md'), 'utf-8')).toBe(before);
    expect(readFileSync(s.edit!.path, 'utf-8')).toBe('# Acme\nFor studios of three to ten.');
    expect(s.edit!.path.startsWith(s.workspace!.destination)).toBe(true);
    expect(res!.message).toContain('is exactly as it was');
    // And their quarter follows, because the workspace beat is done and under
    // D44 everything the two of them build comes after the reading.
    expect(res!.message).toContain('propose_goals');
  });

  test('an empty rewrite is refused rather than blanking a file', async () => {
    const s = opened();
    const r = recorder();
    await upToWorkspace(s, r);
    await executeBeatTool(s, 'propose_edit', { file: 'pitch.md', change: 'x' }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'make_edit', { body: '   ' }, r.deps);
    expect(res!.message).toContain('Error');
    expect(s.edit).toBeNull();
  });
});

/* ══════════════ refusal is a first-class answer ══════════════ */

describe('move_on: an offer they turn down does not stall the conversation', () => {
  test('it closes the beat, writes nothing and hands over the next brief', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    const res = await executeBeatTool(s, 'move_on', { because: 'they would rather not' }, r.deps);

    expect(beatIsDone(s, 'files')).toBe(true);
    expect(s.files).toBeNull();
    expect(r.readerStarts).toHaveLength(0);
    expect(s.proposal).toBeNull();
    expect(r.proposals.at(-1)).toBeNull();
    // The brief for the next beat they can actually do, so the conversation
    // has somewhere to go.
    expect(res!.message).toContain('propose_goals');
    expect(res!.message).toContain('Do not raise it again');
  });

  test('the refusal is recorded as declined, not as done with them', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'move_on', { because: 'not comfortable with that' }, r.deps);
    const files = r.completed.find((c) => c.beat === 'files')!;
    expect(files.detail).toMatchObject({ declined: true, because: 'not comfortable with that' });
  });

  test('one no closes both file beats, so they are not asked the same thing twice', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    const res = await executeBeatTool(s, 'move_on', { because: 'no' }, r.deps);

    // D44's refusal path. `workspaceBrief` opens with "you have read their
    // files", so handing it to a model that has read nothing is the exact
    // failure this closes. It also spares the founder a second refusal ninety
    // seconds after the first.
    expect(beatIsDone(s, 'files')).toBe(true);
    expect(beatIsDone(s, 'workspace')).toBe(true);
    expect(currentBeat(s)).toBe('goals');
    const workspace = r.completed.find((c) => c.beat === 'workspace')!;
    expect(workspace.detail).toMatchObject({ skipped: true });
    expect(workspace.detail.declined).toBeUndefined();
    expect(res!.message).toContain('Do not offer to organise their folder either');
    // Nothing was written and nothing was read.
    expect(r.readerStarts).toHaveLength(0);
    expect(s.workspace).toBeNull();
  });

  test('a founder who says no at minute three still reaches the finale, whole', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'move_on', { because: 'no' }, r.deps);
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'propose_research', { question: 'q', brief: 'b' }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);

    // Every beat below the two they declined ran, wrote something real, and
    // finished. The refusal costs them the reading, not the trial.
    expect(s.objective).not.toBeNull();
    expect(findCommitments({}).length).toBeGreaterThan(0);
    expect(s.briefAt).not.toBeNull();
    expect(s.workflowsPublished).toHaveLength(1);
    expect(s.authorityLevel).toBe(TRIAL_AUTHORITY_PROPOSED);
    expect(s.agent).not.toBeNull();
    expect(s.finishedAt).not.toBeNull();
    expect(res!.message).toContain('teach_summon');
  });

  test('it cannot be used before the opening is done', async () => {
    const s = createBeatsSession();
    const r = recorder();
    const res = await executeBeatTool(s, 'move_on', { because: 'x' }, r.deps);
    expect(res!.message).toContain('conclude_opening');
    expect(s.done).toHaveLength(0);
  });

  test('after the last beat it is a no-op, not a crash', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    await executeBeatTool(s, 'await_summon', {}, r.deps);
    const res = await executeBeatTool(s, 'move_on', { because: 'x' }, r.deps);
    expect(res!.message).toContain('nothing left to set up');
  });
});

/* ══════════ beat 13 · the handover, and the end of the conducted hour ══════════

   The fault this beat exists to fix: on 26 August the conductor never stopped
   conducting. Its layer suppresses the shell's own pebble and Talk panel while
   it owns the conversation, nothing took that off, and the founder spent the
   other 47 hours of a 48-hour trial unable to use the product the first hour
   had just sold them.

   So the tests that matter here are the ones about it ALWAYS finishing. The
   founder presses the key: it finishes. The founder walks away: it finishes.
   The wait itself falls over: it finishes. */

describe('beat 13, the handover', () => {
  test('it is refused until the finale has actually happened', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    const res = await executeBeatTool(s, 'teach_summon', {}, r.deps);
    expect(res!.message).toContain('agents part of the work');
    expect(r.proposals).not.toContainEqual(expect.objectContaining({ beat: 'handover' }));
  });

  test('the finale hands the model straight into it, and says the trial is not over', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'propose_research', { question: 'q', brief: 'b' }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'spawn_research_agent', {}, r.deps);
    expect(res!.message).toContain('teach_summon');
    expect(res!.message).toContain('await_summon');
    expect(res!.message).toContain('rest of the 48 hours');
    // D28's card is the reference; D24's press is the lesson.
    expect(res!.message).toContain('hold control and press J');
  });

  test('teach_summon puts three keys up and marks exactly one to press', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);

    const card = s.proposal as { beat: string; keys: { chord: string; press?: boolean }[] };
    expect(card.beat).toBe('handover');
    expect(card.keys).toHaveLength(3);
    expect(card.keys.filter((k) => k.press)).toHaveLength(1);
    // The one they press is the one that works where they are standing.
    // ctrl+space is the OS sidecar's summon and a browser never sees it.
    expect(card.keys.find((k) => k.press)!.chord).toBe('mod+J');
    expect(card.keys.map((k) => k.chord)).toContain('ctrl+space');
    expect(card.keys.map((k) => k.chord)).toContain('mod+K');
  });

  test('await_summon refuses before anything is on their screen', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'handover');
    const res = await executeBeatTool(s, 'await_summon', {}, r.deps);
    expect(res!.message).toContain('teach_summon');
    expect(s.handedOverAt).toBeNull();
    expect(r.stoodDown).toHaveLength(0);
  });

  test('they press it: the conductor stands down and the card ticks', async () => {
    const s = opened();
    const r = recorder({});
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    const res = await executeBeatTool(s, 'await_summon', {}, r.deps);

    expect(s.summonPressed).toBe(true);
    expect(s.handedOverAt).not.toBeNull();
    expect(beatIsDone(s, 'handover')).toBe(true);
    expect(r.stoodDown).toEqual([{ pressed: true, handedOverAt: s.handedOverAt }]);
    const card = s.proposal as { pressed: boolean; handedOver: boolean };
    expect(card.pressed).toBe(true);
    expect(card.handedOver).toBe(true);
    expect(res!.message).toContain('pressed it');
    // And the model is told the relationship carries on (D17), not that the
    // trial has ended, because it has not.
    expect(res!.message).toContain('48 hours are still running');
  });

  test('THEY NEVER PRESS IT, and it stands down anyway', async () => {
    // The whole point. A founder who has wandered off must not come back to a
    // conductor still sitting on top of their product.
    const s = opened();
    const r = recorder();
    r.summon = 'timeout';
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    const res = await executeBeatTool(s, 'await_summon', {}, r.deps);

    expect(s.summonPressed).toBe(false);
    expect(beatIsDone(s, 'handover')).toBe(true);
    expect(r.stoodDown).toEqual([{ pressed: false, handedOverAt: s.handedOverAt }]);
    expect(res!.message).toContain('did not press it');
    expect(res!.message).toContain('do not ask them again');
  });

  test('the wait itself falling over does not keep the conductor up', async () => {
    const s = opened();
    const r = recorder({ awaitSummon: async () => { throw new Error('socket went away'); } });
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    const res = await executeBeatTool(s, 'await_summon', {}, r.deps);

    expect(beatIsDone(s, 'handover')).toBe(true);
    expect(r.stoodDown).toHaveLength(1);
    expect(res!.message).toContain('did not press it');
  });

  test('a stand-down listener that throws still finishes the beat', async () => {
    const s = opened();
    const r = recorder({ standDown: () => { throw new Error('broadcast failed'); } });
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    const res = await executeBeatTool(s, 'await_summon', {}, r.deps);
    expect(beatIsDone(s, 'handover')).toBe(true);
    expect(res!.message).toContain('pressed it');
  });

  test('it happens in no room, so nothing is opened and no door is marked', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'handover');
    const roomsBefore = [...r.rooms];
    const markedBefore = [...r.marked];
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    await executeBeatTool(s, 'await_summon', {}, r.deps);
    expect(r.rooms).toEqual(roomsBefore);
    expect(r.marked).toEqual(markedBefore);
  });

  test('the close stops asking for a handover once one has happened', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'handover');
    await executeBeatTool(s, 'teach_summon', {}, r.deps);
    await executeBeatTool(s, 'await_summon', {}, r.deps);
    // Anything that lands back in `closing` afterwards must not send the model
    // round the handover a second time.
    expect(closing(s)).not.toContain('teach_summon');
    expect(closing(s)).toContain('conversation carries on');
  });
});

/* ══════════ D41 · the two rooms that cannot explain themselves ══════════

   Vieri, on the third run: *"for the goals it sets it up but it never explains
   how goals work... it would be good if it would actually press into the
   workflow, this specific workflow that it creates, to showcase the different
   nodes and the actual workflow."*

   The test of "explanation, not tour" is whether the subject is THEIR object.
   Everything below asserts that it is: the anchors are the ids of the rows
   that were just written, and the flow that opens is the flow that was just
   built. */

describe('the goal tree explains itself, through their own tree', () => {
  test('their objective is opened and the pebble walks its three levels', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);

    const focus = r.actions.find((a) => a.action === 'focus_goal');
    expect(focus).toBeDefined();
    expect(focus!.room).toBe('goals');
    // By ID, not by name: the objective's title is a sentence the founder said
    // out loud, and matching on it is how you open the wrong thing.
    expect(focus!.args.id).toBe(s.objective!.id);

    const walk = r.walks.find((w) => w.room === 'goals');
    expect(walk).toBeDefined();
    const anchors = walk!.parts.map((p) => p.anchor);
    expect(anchors[0]).toBe(`goal:${s.objective!.id}`);
    expect(anchors[1]).toBe(`goal:${s.objective!.keyResults[0]!.id}`);
    expect(anchors).toHaveLength(3); // objective, a key result, the first move

    // The labels name the MECHANIC, on their own numbers. "12 booked demos a
    // month" is at 4 today, and that is what the pebble says.
    const labels = walk!.parts.map((p) => p.label);
    expect(labels[0]).toContain('the objective');
    expect(labels[1]).toContain('4 today');
    expect(labels[2]).toContain('the first move');
  });

  test('the walk comes before the door is marked, not after it', async () => {
    // Both are pebble gestures. Inside first, then the way back in: the door
    // is the last thing they see because it is the thing they will use next.
    const s = standingAt('goals');
    const r = recorder();
    const order: string[] = [];
    r.deps = {
      ...r.deps,
      showParts: (parts, opts) => { order.push('walk'); r.walks.push({ parts, room: opts?.room, kind: opts?.kind }); },
      roomIsTheirs: (beat, label) => { order.push('door'); r.marked.push({ beat, label }); },
    };
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(order).toEqual(['walk', 'door']);
  });

  test('the model is told to explain the mechanic, and NOT to read the tree out', async () => {
    const s = standingAt('goals');
    const r = recorder();
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'create_goals', {}, r.deps);
    expect(res!.message).toContain('ONE sentence');
    expect(res!.message).toContain('evening review');
    expect(res!.message).toContain('do not list its parts');
  });

  test('a tree with no first move still walks what there is', async () => {
    const s = standingAt('goals');
    const r = recorder();
    // Two key results with numbers, and a first move that lands under the
    // objective because its `under` matches nothing. It still exists, so it is
    // still walked; what must not happen is a walk with a hole in it.
    await executeBeatTool(s, 'propose_goals', { ...GOALS_ARGS, first_move: { what: 'x', due: 'friday', under: 'nothing that exists' } }, r.deps);
    answers(s);
    await executeBeatTool(s, 'create_goals', {}, r.deps);
    const walk = r.walks.find((w) => w.room === 'goals')!;
    expect(walk.parts.every((p) => p.anchor.startsWith('goal:'))).toBe(true);
    expect(walk.parts.every((p) => (p.label ?? '').length > 0)).toBe(true);
  });
});

describe('the workflow explains itself, by being opened', () => {
  async function publishOne(s: BeatsSession, r: Recorder, name: string) {
    await executeBeatTool(s, 'propose_workflow', { ...WORKFLOW_ARGS, name }, r.deps);
    answers(s);
    return executeBeatTool(s, 'publish_workflow', {}, r.deps);
  }

  test('the FIRST flow that builds is opened in the editor and its nodes are walked', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    const res = await publishOne(s, r, 'Monday pipeline review');

    const open = r.actions.find((a) => a.action === 'open_flow');
    expect(open).toBeDefined();
    expect(open!.room).toBe('workflows');
    expect(open!.args.id).toBe('flow-monday-pipeline-review');
    expect(s.firstFlow).toEqual({ id: 'flow-monday-pipeline-review', name: 'Monday pipeline review' });

    // No anchors from the daemon: the composer decided what the nodes are, so
    // the surface reads the real graph rather than a guess at it.
    const walk = r.walks.find((w) => w.kind === 'flow');
    expect(walk).toBeDefined();
    expect(walk!.parts).toEqual([]);
    expect(res!.message).toContain('OPEN on their screen');
    expect(res!.message).toContain('do not read the steps out');
  });

  test('the second flow does not do it again', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    await publishOne(s, r, 'Monday pipeline review');
    await publishOne(s, r, 'Friday check-in');
    expect(r.actions.filter((a) => a.action === 'open_flow')).toHaveLength(1);
    expect(r.walks.filter((w) => w.kind === 'flow')).toHaveLength(1);
    expect(s.firstFlow!.name).toBe('Monday pipeline review');
  });

  test('a flow that does not build opens nothing', async () => {
    const s = opened();
    const r = recorder();
    r.workflowOk = false;
    await walkTo(s, r, 'workflows');
    const res = await publishOne(s, r, 'Monday pipeline review');
    expect(res!.message).toContain('did not build');
    expect(r.actions.filter((a) => a.action === 'open_flow')).toHaveLength(0);
    expect(r.walks.filter((w) => w.kind === 'flow')).toHaveLength(0);
    expect(s.firstFlow).toBeNull();
  });

  test('a composer that returns no flow id publishes fine and opens nothing', async () => {
    // An install whose workflow tool answers without an id is not a broken
    // beat: the flow is live, the founder was told so, and the only thing
    // missing is the thing that cannot be done without an id.
    const s = opened();
    const r = recorder({ publishWorkflow: async (p) => ({ ok: true as const, detail: `${p.steps.length} steps` }) });
    await walkTo(s, r, 'workflows');
    const res = await publishOne(s, r, 'Monday pipeline review');
    expect(res!.message).toContain('is live');
    expect(res!.message).not.toContain('OPEN on their screen');
    expect(r.actions.filter((a) => a.action === 'open_flow')).toHaveLength(0);
    expect(s.workflowsPublished).toEqual(['Monday pipeline review']);
  });
});

/* ══════════ D44 · the reorder, and what the beats below it now say ══════════ */

describe('D44, the ask that has to earn itself three minutes in', () => {
  const brief = filesBrief({ company: 'Two-person B2B SaaS selling to studios.' });

  test('it names the trade, the fence and the way out, in that order', () => {
    // THE TRADE. The only argument that is actually true, and the founder can
    // check it against the two minutes they just spent describing themselves.
    expect(brief).toContain('That is the two-minute version');
    expect(brief).toContain('instead of an hour of them explaining');
    // THE FENCE, volunteered rather than extracted.
    expect(brief).toContain('One folder, the one they name');
    expect(brief).toContain('do not move, rename, change or delete');
    expect(brief).toContain('before a single file is opened');
    // THE WAY OUT, in the same breath as the ask. An ask that costs nothing to
    // refuse is a smaller ask, and it has to be offered by the one asking.
    expect(brief).toContain('WAY OUT IN THE SAME BREATH');
    expect(brief).toContain('do not ask a second time');
    expect(brief.indexOf('WAY OUT IN THE SAME BREATH')).toBeGreaterThan(brief.indexOf('WHAT YOU PROMISE'));
  });

  test('it says plainly that this is the biggest thing it will ask for', () => {
    expect(brief).toContain('biggest thing you will ask them for');
    expect(brief).toContain('Do not slide it in as a small favour');
  });

  test('it does not make the one promise that is not ours to make', () => {
    // The reader is a language model. "It never leaves your machine" is the
    // sentence a model reaches for under this much pressure, and it is false.
    expect(brief).not.toMatch(/never leaves|nothing is sent anywhere|nobody else sees/i);
    // And the prohibition is stated, because a model under this much pressure
    // will reach for that sentence if nothing stops it.
    expect(brief).toContain('Do not tell them where anything is processed');
    expect(brief).toContain('it is not yours to promise');
  });

  test('it still carries their own words, and still says nothing about a step', () => {
    expect(brief).toContain('Two-person B2B SaaS selling to studios.');
    expect(brief).toContain('Say nothing about this');
    expect(brief).not.toMatch(/onboarding|wizard|next question/i);
  });
});

describe('D44, the beats below the read use what was read', () => {
  const FOUND = [
    'Northwind (client)',
    'Rita Alvarez (contractor): does the front end two days a week',
    'Pricing: 240 a seat, under review since March',
    'Northwind: renews in October',
  ];

  /**
   * A session that has read a real folder and had real findings land, with the
   * organised copy turned down, so what is left is exactly the thing under
   * test: the beats below the read, holding what was read.
   *
   * Returns the tool result that closed the workspace beat, which IS the goals
   * brief. That is the whole "what happens next" mechanism.
   */
  async function afterReading(s: BeatsSession, r: Recorder): Promise<string> {
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);
    r.reader = { found: [...FOUND], finished: true, summary: 'A two-person studio tools business.' };
    await executeBeatTool(s, 'reading_so_far', {}, r.deps);
    const res = await executeBeatTool(s, 'move_on', { because: 'the folder is fine as it is' }, r.deps);
    return res!.message;
  }

  test('the goals brief arrives carrying their own documents, not a summary of them', async () => {
    const s = opened();
    const r = recorder();
    const goals = await afterReading(s, r);
    expect(currentBeat(s)).toBe('goals');
    for (const f of FOUND) expect(goals).toContain(f);
    expect(goals).toContain('A two-person studio tools business.');
    // And the instruction that makes it worth carrying: say the number, do not
    // ask for it. This is the failure D44 exists to prevent.
    expect(goals).toContain('WHERE A NUMBER IS ALREADY WRITTEN DOWN, SAY IT, do not ask for it');
    expect(goals).toContain('never ask them for something that is written in a document you have read');
  });

  test('tasks draws the dated commitments nobody says out loud', async () => {
    const s = opened();
    const r = recorder();
    await afterReading(s, r);
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    answers(s);
    const tasks = (await executeBeatTool(s, 'create_goals', {}, r.deps))!.message;
    expect(tasks).toContain('START FROM WHAT YOU READ');
    expect(tasks).toContain('already written down');
    expect(tasks).toContain('Northwind: renews in October');
  });

  test('calendar reads the dates out of their documents alongside their week', async () => {
    const s = opened();
    const r = recorder();
    await afterReading(s, r);
    await walkTo(s, r, 'calendar');
    const week = (await executeBeatTool(s, 'read_week', {}, r.deps))!.message;
    expect(week).toContain('Dates written in their own documents, which are on no calendar');
    expect(week).toContain('Northwind: renews in October');
    // A line with nothing dated in it is not dressed up as a deadline.
    expect(week).not.toContain('Rita Alvarez');
  });

  test('workflows is told to find the recurring work by its repetition, not by asking', async () => {
    const s = opened();
    const r = recorder();
    await afterReading(s, r);
    const flows = await walkTo(s, r, 'workflows');
    expect(flows).toContain('VISIBLE IN A FOLDER');
    expect(flows).toContain('in there twelve times');
  });

  test('authority stops being abstract, because they have watched it work in there', async () => {
    const s = opened();
    const r = recorder();
    await afterReading(s, r);
    const auth = await walkTo(s, r, 'authority');
    expect(auth).toContain('already watched you work in');
    expect(auth).toContain(s.files!.folder);
  });

  test('the finale is pointed at the contradiction the reader found', async () => {
    const s = opened();
    const r = recorder();
    await afterReading(s, r);
    const agents = await walkTo(s, r, 'agents');
    expect(agents).toContain('THE BEST QUESTION IN THIS SESSION IS ALMOST CERTAINLY ONE THEIR OWN FILES RAISED');
    expect(agents).toContain('Pricing: 240 a seat, under review since March');
  });

  test('their card says where it came from, and only for the beats that read', async () => {
    const s = opened();
    const r = recorder();
    await afterReading(s, r);
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    expect(r.proposals.at(-1)).toMatchObject({ beat: 'goals', fromFiles: true });

    // The authority card is about what Jarvis may do, not about their
    // documents, so it does not claim to have come out of them.
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', { always_ask: ['send_message'] }, r.deps);
    expect((r.proposals.at(-1) as { fromFiles?: boolean }).fromFiles).toBeUndefined();
  });
});

describe('D44, the founder who says no is not left in a worse trial', () => {
  test('every brief below has a second arm, and none of them sulks', () => {
    const none: FileFindings = { found: [], finished: false };
    for (const b of [goalsBrief({}, none), tasksBrief({}, none)]) {
      expect(b).toContain('everything here comes out of what they tell you');
      expect(b).toContain('never imply this would be better if they had said yes');
      expect(b).not.toContain('WHAT YOU READ IN THEIR OWN FILES');
    }
  });

  test('a declined read leaves the goals beat asking, not referring back', async () => {
    const s = opened();
    const r = recorder();
    const goals = (await executeBeatTool(s, 'move_on', { because: 'rather not' }, r.deps))!.message;
    expect(goals).toContain('Build it out of the sentences they actually said');
    expect(goals).toContain('do not refer back to the folder');
    expect(goals).not.toContain('WHERE A NUMBER IS ALREADY WRITTEN DOWN');
  });

  test('a card proposed with nothing read never claims their files are behind it', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'move_on', { because: 'rather not' }, r.deps);
    await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    expect((r.proposals.at(-1) as { fromFiles?: boolean }).fromFiles).toBeUndefined();
  });
});

describe('D44, the two minutes the reader takes', () => {
  test('start_reading hands over the conversation to have, not the beat it cannot do yet', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    const res = (await executeBeatTool(s, 'start_reading', {}, r.deps))!.message;

    // Not the workspace brief: there is nothing found to organise, and a model
    // handed a brief it can only follow by inventing will invent.
    expect(res).not.toContain('propose_workspace');
    expect(res).toContain('Carry on with them');
    // The four things the opening stopped going looking for (D44's resplit).
    expect(res).toContain('What this quarter is actually for');
    expect(res).toContain('What is eating their week');
    expect(res).toContain('capture_fuel');
  });

  test('what it suggests talking about is only what is not already known', async () => {
    const s = opened();
    const r = recorder({ fuel: () => ({ goal: 'Forty customers by Q3.', drowning: 'Invoices.' }) });
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    const res = (await executeBeatTool(s, 'start_reading', {}, r.deps))!.message;
    expect(res).not.toContain('What this quarter is actually for');
    expect(res).not.toContain('What is eating their week');
    expect(res).toContain('what is already late');
  });

  test('the workspace brief arrives when there is something to organise, exactly once', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);

    const quiet = (await executeBeatTool(s, 'reading_so_far', {}, r.deps))!.message;
    expect(quiet).toContain('Nothing has landed yet');
    expect(quiet).not.toContain('propose_workspace');

    r.reader = { found: ['Northwind (client)'], finished: false, summary: null };
    const first = (await executeBeatTool(s, 'reading_so_far', {}, r.deps))!.message;
    expect(first).toContain('Northwind (client)');
    expect(first).toContain('propose_workspace');

    // Called again a turn later, as the model is told to: progress, not a
    // second copy of the same beat.
    r.reader = { found: ['Northwind (client)', 'Rita (contractor)'], finished: true, summary: 'x' };
    const again = (await executeBeatTool(s, 'reading_so_far', {}, r.deps))!.message;
    expect(again).toContain('Rita (contractor)');
    expect(again).not.toContain('propose_workspace');
  });

  test('a folder that turns out to hold nothing does not leave a beat nobody can do', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);

    r.reader = { found: [], finished: true, summary: 'Nothing about the company in there.' };
    const res = (await executeBeatTool(s, 'reading_so_far', {}, r.deps))!.message;
    expect(res).toContain('without inventing a finding');
    expect(res).toContain('Do NOT offer to organise a folder you learned nothing from');
    // The workspace beat closes as empty rather than as declined by them, and
    // the conversation goes on to their quarter with the second arm.
    expect(beatIsDone(s, 'workspace')).toBe(true);
    const workspace = r.completed.find((c) => c.beat === 'workspace')!;
    expect(workspace.detail).toMatchObject({ skipped: true });
    expect(res).toContain('propose_goals');
    expect(res).toContain('everything here comes out of what they tell you');
  });

  test('the folder cannot be filed before it has been read', async () => {
    const s = opened();
    const r = recorder();
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    answers(s);
    await executeBeatTool(s, 'start_reading', {}, r.deps);
    r.proposals.length = 0;
    const res = await executeBeatTool(s, 'propose_workspace', {
      title: 'Acme', sections: [{ name: 'the pitch', about: 'x', files: ['pitch.md'] }],
    }, r.deps);
    expect(res!.message).toContain('you do not know what is in them');
    expect(r.proposals).toHaveLength(0);
  });
});

describe('datedFindings, the crude filter that is only allowed to be crude', () => {
  test('it keeps the lines with a date in them and drops the rest', () => {
    const found = [
      'Northwind: renews in October',
      'Rita Alvarez (contractor)',
      'Board pack due 14/09',
      'Q3 target is forty customers',
      'Raised in 2025',
    ];
    expect(datedFindings({ found, finished: true })).toEqual([
      '- Northwind: renews in October',
      '- Board pack due 14/09',
      '- Q3 target is forty customers',
      '- Raised in 2025',
    ]);
  });

  test('the words a founder actually writes are not mistaken for months', () => {
    // The first version of this matched month PREFIXES, so "market" was a date
    // through `mar` and "the deck" was a date through `dec`. Both are in every
    // founder's folder, and a Jarvis reading them back as deadlines is worse
    // than one that says nothing about dates at all.
    const found = [
      'The market is three thousand studios',
      'The deck undersells the pricing',
      'Junior engineer starting soon',
      'Decided against raising',
      'Margin is 62 per cent',
      'Separate repo for the website',
    ];
    expect(datedFindings({ found, finished: true })).toEqual([]);
  });

  test('nothing read is nothing dated', () => {
    expect(datedFindings({ found: [], finished: false })).toEqual([]);
  });
});
