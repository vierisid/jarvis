/**
 * The seven room beats, tested where they would break quietly.
 *
 * Not "does the tool return a string". The things that would ruin the session
 * without failing anything: a beat running out of order, a write landing that
 * the founder never saw, an authority level above the trial ceiling, a "late"
 * flag on a task that is not late, a failed compose being reported as live,
 * and the finale marking onboarding finished when nothing was spawned.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
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
  authority: number | null;
  spawned: { question: string; brief: string }[];
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
    brief: null, authority: null, spawned: [], finished: 0, workflowOk: true,
    deps: null as never,
  };
  r.deps = {
    now: clock,
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
    setMorningBrief: (hour, minute) => { r.brief = { hour, minute }; },
    setAuthorityLevel: (level) => { r.authority = level; return level; },
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

const GOALS_ARGS = {
  objective: '40 paying customers by the end of Q3',
  key_results: [
    { title: '12 booked demos a month' },
    { title: 'Month three churn under 4%', measure: 'under 4%' },
  ],
};

async function walkTo(s: BeatsSession, r: Recorder, beat: RoomBeat): Promise<void> {
  const run = (n: string, a: Record<string, unknown> = {}) => executeBeatTool(s, n, a, r.deps);
  const upto = ROOM_BEATS.indexOf(beat);
  if (upto > 0) { await run('propose_goals', GOALS_ARGS); answers(s); await run('create_goals'); }
  if (upto > 1) {
    await run('propose_tasks', {
      tasks: [{ what: 'File the VAT return', due: new Date(NOW + 2 * 86_400_000).toISOString() }],
    });
    answers(s);
    await run('create_tasks');
  }
  if (upto > 2) { await run('propose_morning_brief', { hour: 7, minute: 30 }); answers(s); await run('set_morning_brief'); }
  if (upto > 3) {
    await run('propose_workflow', { name: 'Monday pipeline review', runs_when: 'Mondays at 8', steps: ['Pull open deals', 'Flag stale ones'] });
    answers(s);
    await run('publish_workflow');
  }
  if (upto > 4) { await run('propose_authority', {}); answers(s); await run('set_authority', {}); }
}

beforeEach(() => {
  initDatabase(':memory:');
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

  test('the order is exactly D16, minus memory which is not a stop', () => {
    expect([...ROOM_BEATS]).toEqual(['goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents']);
    expect((ROOM_BEATS as readonly string[]).includes('memory')).toBe(false);
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

  test('every one of the five commits is behind that gate, not just the first', async () => {
    const r = recorder();
    const cases: [RoomBeat, string, string, Record<string, unknown>][] = [
      ['goals', 'propose_goals', 'create_goals', GOALS_ARGS],
      ['tasks', 'propose_tasks', 'create_tasks', { tasks: [{ what: 'a' }] }],
      ['calendar', 'propose_morning_brief', 'set_morning_brief', { hour: 8 }],
      ['workflows', 'propose_workflow', 'publish_workflow', { name: 'f', runs_when: 'mondays', steps: ['x'] }],
      ['authority', 'propose_authority', 'set_authority', {}],
    ];
    for (const [beat, propose, commit, args] of cases) {
      initDatabase(':memory:');
      const s = opened();
      await walkTo(s, r, beat);
      await executeBeatTool(s, propose, args, r.deps);
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
    await executeBeatTool(s, 'propose_workflow', {
      name: 'Monday pipeline review', runs_when: 'Mondays at 8', steps: ['Pull open deals'],
    }, r.deps);
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
    expect(res!.message).toContain('ask them');
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
        { what: 'File the Q2 VAT return', due: new Date(NOW - 86_400_000).toISOString(), priority: 'critical' },
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
    await executeBeatTool(s, 'propose_morning_brief', { hour: 7, minute: 30, because: 'you are at the desk by eight' }, r.deps);
    expect(r.brief).toBeNull();
    answers(s);
    const res = await executeBeatTool(s, 'set_morning_brief', {}, r.deps);
    expect(r.brief).toEqual({ hour: 7, minute: 30 });
    expect(s.briefAt).toEqual({ hour: 7, minute: 30 });
    expect(res!.message).toContain('07:30');
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
    await executeBeatTool(s, 'propose_workflow', {
      name: 'Monday pipeline review', runs_when: 'Mondays at 8', steps: ['Pull open deals'],
    }, r.deps);
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
    await executeBeatTool(s, 'propose_workflow', {
      name: 'Monday pipeline review', runs_when: 'Mondays at 8', steps: ['Pull open deals'],
    }, r.deps);
    answers(s);
    r.proposals.length = 0;
    await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    expect((r.proposals[0] as WorkflowProposal).building).toBe(true);
  });

  test('the first publish opens authority but still asks for a second flow', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'workflows');
    await executeBeatTool(s, 'propose_workflow', {
      name: 'Monday pipeline review', runs_when: 'Mondays at 8', steps: ['Pull open deals'],
    }, r.deps);
    answers(s);
    const res = await executeBeatTool(s, 'publish_workflow', {}, r.deps);
    expect(res!.message).toContain('second');
    expect(res!.message).toContain('propose_authority');
    expect(beatIsOpen(s, 'authority')).toBe(true);
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
    await executeBeatTool(s, 'propose_authority', {}, r.deps);
    answers(s);
    await executeBeatTool(s, 'set_authority', { level: 3 }, r.deps);
    expect(r.authority).toBe(3);
    expect(s.authorityLevel).toBe(3);
  });

  test('D32, a founder who offers seven does not get seven, and is told so', async () => {
    const s = opened();
    const r = recorder();
    await walkTo(s, r, 'authority');
    await executeBeatTool(s, 'propose_authority', {}, r.deps);
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
    // Every beat led them into its room, once each.
    expect(r.rooms).toEqual(['goals', 'tasks', 'calendar', 'workflows', 'authority', 'agents']);
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
