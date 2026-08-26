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
  createBeatsSession,
  currentBeat,
  executeBeatTool,
  goalsBrief,
  type BeatDeps,
  type BeatProposal,
  type BeatsSession,
  type RoomBeat,
  type WorkflowProposal,
} from './beats.ts';

type Recorder = {
  deps: BeatDeps;
  rooms: string[];
  refreshed: string[];
  proposals: (BeatProposal | null)[];
  landed: { beat: RoomBeat; summary: string }[];
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
    rooms: [], refreshed: [], proposals: [], landed: [], completed: [],
    brief: null, evening: null, authority: null, alwaysAsk: [], spawned: [],
    readerStarts: [], reader: { found: [], finished: false, summary: null },
    readerFails: false, finished: 0, workflowOk: true,
    deps: null as never,
  };
  r.deps = {
    now: clock,
    home: () => tmpHome,
    fuel: () => ({}),
    enterRoom: (beat) => { r.rooms.push(beat); },
    refreshRoom: (room) => { r.refreshed.push(room); },
    showProposal: (p) => { r.proposals.push(p); },
    proposalLanded: (beat, summary) => { r.landed.push({ beat, summary }); },
    beatComplete: (beat, detail) => { r.completed.push({ beat, detail }); },
    publishWorkflow: async (p: WorkflowProposal) =>
      r.workflowOk
        ? { ok: true as const, detail: `${p.steps.length} steps` }
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
    ...over,
  };
  return r;
}

/** An opened session, as it is the instant `conclude_opening` fires. */
function opened(): BeatsSession {
  const s = createBeatsSession();
  s.open = true;
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

async function walkTo(s: BeatsSession, r: Recorder, beat: RoomBeat): Promise<void> {
  const run = (n: string, a: Record<string, unknown> = {}) => executeBeatTool(s, n, a, r.deps);
  const upto = ROOM_BEATS.indexOf(beat);
  if (upto > 0) { await run('propose_goals', GOALS_ARGS); answers(s); await run('create_goals'); }
  if (upto > 1) { await run('propose_tasks', TASKS_ARGS); answers(s); await run('create_tasks'); }
  if (upto > 2) {
    await run('propose_daily_rhythm', { hour: 7, minute: 30, evening_hour: 19 });
    answers(s);
    await run('set_daily_rhythm');
  }
  if (upto > 3) {
    await run('propose_workflow', WORKFLOW_ARGS);
    answers(s);
    await run('publish_workflow');
    // D16.5 wants two, and the beat no longer closes on one.
    await run('no_second_workflow', { because: 'the rest of their week is one-offs' });
  }
  if (upto > 4) {
    await run('propose_authority', { always_ask: ['send_message'] });
    answers(s);
    await run('set_authority', {});
  }
  if (upto > 5) { await run('propose_reading', { folder: folder() }); answers(s); await run('start_reading'); }
  if (upto > 6) { await run('move_on', { because: 'not now' }); }
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
    expect(res!.message).toContain('goals');
    expect(r.proposals).toHaveLength(0);
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

  test('the order is D16, plus D42 and D43 between authority and the finale', () => {
    expect([...ROOM_BEATS]).toEqual([
      'goals', 'tasks', 'calendar', 'workflows', 'authority', 'files', 'workspace', 'agents',
    ]);
    // `memory` is not a stop (D16.1), and `agents` is still last (D15): the
    // finale is the only beat that keeps working after the talking ends.
    expect((ROOM_BEATS as readonly string[]).includes('memory')).toBe(false);
    expect(ROOM_BEATS[ROOM_BEATS.length - 1]).toBe('agents');
    // Reading their disk comes after the conversation about power, never before.
    expect(ROOM_BEATS.indexOf('files')).toBeGreaterThan(ROOM_BEATS.indexOf('authority'));
  });
});

/* ─────────────────────── propose, then commit ─────────────────────── */

describe('D18, nothing is written that they have not seen', () => {
  test('every commit refuses when nothing is on their screen', async () => {
    const s = opened();
    const r = recorder();
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
    const s = opened();
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
    const s = opened();
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
    const s = opened();
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
    const s = opened();
    const r = recorder();
    const res = await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    expect(findGoals({})).toHaveLength(0);
    expect(r.rooms).toEqual(['goals']);
    expect(r.proposals[0]).toMatchObject({ beat: 'goals', objective: GOALS_ARGS.objective });
    expect(res!.message).toContain('On their screen');
  });

  test('an objective with no key results is refused, not half-created', async () => {
    const s = opened();
    const r = recorder();
    const res = await executeBeatTool(s, 'propose_goals', { objective: 'Grow', key_results: [] }, r.deps);
    expect(res!.message).toContain('Error');
    expect(r.proposals).toHaveLength(0);
  });

  test('committing builds the real tree and hands the model the next beat', async () => {
    const s = opened();
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
  test('the agent is spawned on their own question and left running', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    const res = await executeBeatTool(s, 'spawn_research_agent', {
      question: 'How the three closest competitors price their onboarding',
      brief: 'Compare the published price and what is included.',
    }, r.deps);
    expect(r.spawned).toHaveLength(1);
    expect(s.agent?.agentId).toBe('agent-1');
    expect(s.finishedAt).toBeGreaterThanOrEqual(NOW);
    expect(r.finished).toBe(1);
    expect(res!.message).toContain('back shortly');
    expect(res!.message).not.toContain('propose');
  });

  test('a spawn that fails does not finish onboarding or claim an agent is running', async () => {
    const s = opened();
    const r = recorder({ spawnResearchAgent: async () => { throw new Error('no specialist installed'); } });
    await walkTo(s, r, 'agents');
    const res = await executeBeatTool(s, 'spawn_research_agent', { question: 'anything', brief: '' }, r.deps);
    expect(res!.message).toContain('Do not pretend it is running');
    expect(s.finishedAt).toBeNull();
    expect(r.finished).toBe(0);
  });

  test('the whole arc, in order, ends finished', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'spawn_research_agent', { question: 'q', brief: 'b' }, r.deps);
    expect(s.done).toEqual([...ROOM_BEATS]);
    expect(currentBeat(s)).toBeNull();
    expect(r.completed.map((c) => c.beat)).toEqual([...ROOM_BEATS]);
    // Every beat led them into its room, once each. `files` and `workspace`
    // share the memory room, and `enterRoom` is a no-op on an unchanged room,
    // so the pebble makes one gesture across the two of them rather than two.
    expect(r.rooms).toEqual(['goals', 'tasks', 'calendar', 'workflows', 'authority', 'files', 'agents']);
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
    const s = opened();
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
    const s = opened();
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
    const s = opened();
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
    const s = opened();
    const r = recorder();
    const first = await executeBeatTool(s, 'propose_goals', SHALLOW_GOALS_ARGS, r.deps);
    expect(first!.message).toContain('Still owed');
    // ...and stops saying so once the tree is whole.
    const whole = await executeBeatTool(s, 'propose_goals', GOALS_ARGS, r.deps);
    expect(whole!.message).not.toContain('Still owed');
    expect(whole!.message).toContain('whole tree');
  });

  test('the tree that lands has an end date, a baseline score and a first move', async () => {
    const s = opened();
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
    const s = opened();
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

/* ══════════════ D42 · reading their own files ══════════════ */

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
    expect((r.proposals.at(-1) as { as: string }).as).toBe('pitch — rewritten.md');
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
    // And the finale follows, because the workspace beat is done.
    expect(res!.message).toContain('spawn_research_agent');
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
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'propose_reading', { folder: folder() }, r.deps);
    const res = await executeBeatTool(s, 'move_on', { because: 'they would rather not' }, r.deps);

    expect(beatIsDone(s, 'files')).toBe(true);
    expect(s.files).toBeNull();
    expect(r.readerStarts).toHaveLength(0);
    expect(s.proposal).toBeNull();
    expect(r.proposals.at(-1)).toBeNull();
    // The brief for the NEXT beat, so the conversation has somewhere to go.
    expect(res!.message).toContain('propose_workspace');
    expect(res!.message).toContain('Do not raise it again');
  });

  test('the refusal is recorded as declined, not as done with them', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'move_on', { because: 'not comfortable with that' }, r.deps);
    const done = r.completed.at(-1)!;
    expect(done.beat).toBe('files');
    expect(done.detail).toMatchObject({ declined: true, because: 'not comfortable with that' });
  });

  test('declining both file beats still reaches the finale', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'files');
    await executeBeatTool(s, 'move_on', { because: 'no' }, r.deps);
    const second = await executeBeatTool(s, 'move_on', { because: 'no' }, r.deps);
    expect(second!.message).toContain('spawn_research_agent');
    expect(currentBeat(s)).toBe('agents');
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
    await walkTo(s, r, 'agents');
    await executeBeatTool(s, 'spawn_research_agent', { question: 'q', brief: 'b' }, r.deps);
    const res = await executeBeatTool(s, 'move_on', { because: 'x' }, r.deps);
    expect(res!.message).toContain('nothing left to set up');
  });
});
