import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb } from '../vault/schema.ts';
import { initWorkflowDb } from '../workflows/db/index.ts';
import { DEFAULT_IDS } from '../workflows/db/schema.ts';
import * as goals from '../vault/goals.ts';
import { createCommitment, updateCommitmentStatus } from '../vault/commitments.ts';
import { createFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version.ts';
import { createFlowRun, updateRun } from '../workflows/db/repos/flow-run.ts';
import { createWaitpoint, type WaitpointType } from '../workflows/db/repos/waitpoint.ts';
import { getGoalApplication } from './application-service.ts';
import { checkWorkResult, createWorkItem, decideWorkItem } from './work-items.ts';
import { nextAction, observeNextAction, PLAN_TTL, planNextAction, PLANNER, type NextActionPlan } from './next-action.ts';
import { SCENARIO_NOW, SCENARIO_SET, scenarioMisses, scenarioSnapshot, type NextActionScenario } from './next-action-scenarios.ts';

const DAY = 86_400_000;
const scenario = (id: string): NextActionScenario => SCENARIO_SET.scenarios.find(s => s.id === id)!;
const plan = (id: string) => planNextAction(scenarioSnapshot(scenario(id)));
/** A snapshot from scenario fixtures that are not part of the founder set. */
const snap = (fixture: Partial<NextActionScenario>) => scenarioSnapshot({ id: 'test', situation: '', why: '', goals: [], expect: { outcome: 'none' }, ...fixture });
const recommended = (p: NextActionPlan) => { if (p.outcome !== 'recommend') throw new Error(`expected a recommendation, got ${p.outcome}`); return p.action; };
const asked = (p: NextActionPlan) => { if (p.outcome !== 'ask') throw new Error(`expected a question, got ${p.outcome}`); return p.question; };
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

describe('founder-review scenarios', () => {
  for (const s of SCENARIO_SET.scenarios) {
    test(`${s.id}: ${s.situation}`, () => {
      expect(scenarioMisses(s, planNextAction(scenarioSnapshot(s)))).toEqual([]);
    });
  }

  test('the set covers the cases the card names, and the pass conditions', () => {
    const ids = SCENARIO_SET.scenarios.map(s => s.id);
    for (const id of ['already-done', 'done-long-ago', 'stale-goal', 'unavailable-integration', 'duplicate-commitment', 'blocked-by-dependency',
      'inherited-dependency', 'full-queue', 'no-concrete-step', 'last-attempt-failed', 'tie-between-goals', 'old-proposals', 'timer-wait']) expect(ids).toContain(id);
    expect(SCENARIO_SET.status).toBe('proposed');
  });
});

describe('next-action planner', () => {
  test('a recommendation names its goal and revision, its evidence, why it beats doing nothing and the runner-up, and when it expires', () => {
    const s = scenarioSnapshot(scenario('check-finished-run'));
    const p = planNextAction(s);
    const action = recommended(p);
    const goal = s.goals.find(g => g.id === 'g2')!;
    expect(action.goal).toEqual({ goalId: 'g2', revision: String(goal.updatedAt), path: ['Collect overdue invoices', 'Send invoice reminders'] });
    expect(action.workItemId).toBe('w1');
    expect(action.evidence.map(e => `${e.kind}:${e.id}`)).toEqual(['goal:g2', 'work_item:w1', 'run:r1']);
    expect(action.rationale).toEqual([
      'Its run finished, and only you can confirm the result; until then it counts for nothing.',
      'Serves: Collect overdue invoices > Send invoice reminders.',
      'Better than doing nothing new: it closes or moves open work.',
      'Ahead of the next option (Do "Draft the new pricing page"): checking finished work comes before continuing accepted work.',
    ]);
    expect(p.considered.map(c => `${c.outcome} ${c.kind}`)).toEqual(['chosen check_result', 'ranked_lower no_action', 'ranked_lower continue_work']);
    expect({ planner: p.planner, generatedAt: p.generatedAt, expiresAt: p.expiresAt, workload: p.workload, omitted: p.omitted })
      .toEqual({ planner: PLANNER, generatedAt: SCENARIO_NOW, expiresAt: SCENARIO_NOW + PLAN_TTL, workload: { open: 2, capacity: 5 }, omitted: { work: 0, considered: 0 } });
  });

  test('a deadline inside the window, the goal\'s or a parent\'s, brings the expiry forward', () => {
    const s = scenarioSnapshot(scenario('deadline-breaks-tie'));
    s.goals.find(g => g.id === 'g3')!.deadline = SCENARIO_NOW + 6 * 3_600_000;
    expect(planNextAction(s).expiresAt).toBe(SCENARIO_NOW + 6 * 3_600_000);
    const nested = scenarioSnapshot(scenario('parent-deadline'));
    nested.goals.find(g => g.id === 'g1')!.deadline = SCENARIO_NOW + 3 * 3_600_000;
    expect(planNextAction(nested).expiresAt).toBe(SCENARIO_NOW + 3 * 3_600_000);
  });

  test('the basis ignores the clock and changes with any input', () => {
    const s = scenarioSnapshot(scenario('continue-before-starting'));
    const first = planNextAction(s);
    expect(planNextAction({ ...s, now: s.now + 3_600_000 }).basis).toBe(first.basis);
    expect(planNextAction({ ...s, goals: s.goals.map(g => g.id === 'g3' ? { ...g, title: 'Update the pricing page' } : g) }).basis).not.toBe(first.basis);
    expect(planNextAction({ ...s, capacity: 4 }).basis).not.toBe(first.basis);
    expect(planNextAction({ ...s, dayStart: s.dayStart + DAY, dayEnd: s.dayEnd + DAY }).basis).not.toBe(first.basis);
  });

  test('excluded options say why they were left out', () => {
    expect(plan('duplicate-commitment').considered).toContainEqual(
      { kind: 'start_step', title: 'Call Ana about invoice 1042', outcome: 'excluded', why: 'Already committed as "call Ana about invoice 1042!".' });
    expect(plan('blocked-by-dependency').considered).toContainEqual({ kind: 'start_step', title: 'Send the new price list to customers',
      outcome: 'excluded', why: 'Not now: it waits on "Approve the new prices", which is active.' });
    expect(plan('duplicate-open-work').considered).toContainEqual({ kind: 'start_step', title: 'Draft the partner agreement',
      outcome: 'excluded', why: 'Already committed as "draft the partner agreement".' });
    expect(plan('accepted-work-waits-on-dependency').considered).toContainEqual({ kind: 'continue_work', title: 'Email the price list',
      outcome: 'excluded', why: 'Not now: it waits on "Approve the new prices", which is active.' });
    expect(plan('paused-parent').considered).toContainEqual({ kind: 'start_step', title: 'Draft the partner agreement',
      outcome: 'excluded', why: 'Not now: its parent "Launch the partner program" is paused.' });
    expect(plan('inherited-dependency').considered).toContainEqual({ kind: 'start_step', title: 'Email the price list to customers',
      outcome: 'excluded', why: 'Not now: its parent "Send the new price list" waits on "Approve the new prices", which is active.' });
    expect(plan('proposal-for-done-goal').considered).toContainEqual({ kind: 'decide_work', title: 'Work on: Send invoice reminders', outcome: 'excluded',
      why: 'Its goal looks done: its work "Send this week\'s invoice reminders" was checked done on 2026-10-03. Record that before adding work to it.' });
    expect(plan('approval-under-paused-goal').considered).toContainEqual({ kind: 'resolve_blocker', title: 'Send this week\'s invoice reminders',
      outcome: 'excluded', why: 'Not now: answering resumes it, and the goal is paused.' });
    const none = plan('full-queue');
    expect(none.outcome === 'none' && none.reason).toBe('5 items are already open, at your limit of 5. Finish or check some before adding more.');
  });

  test('a proposal is offered only when its goal could take it', () => {
    const held = planNextAction(snap({
      goals: [{ id: 'g2', title: 'Send the new price list to customers', deps: ['g3'] }, { id: 'g3', title: 'Approve the new prices', level: 'milestone' }],
      work: [{ id: 'w1', title: 'Email the price list', goal: 'g2', status: 'proposed' }],
    }));
    expect(held.considered).toContainEqual({ kind: 'decide_work', title: 'Email the price list', outcome: 'excluded',
      why: 'Not now: it waits on "Approve the new prices", which is active.' });
    const stale = planNextAction(snap({
      goals: [{ id: 'g2', title: 'Publish the monthly newsletter', created: -42 }],
      work: [{ id: 'w1', title: 'Work on: Publish the monthly newsletter', goal: 'g2', status: 'proposed' }],
    }));
    expect(recommended(stale)).toMatchObject({ kind: 'review_goal', goal: { goalId: 'g2' } });
    expect(stale.considered).toContainEqual({ kind: 'decide_work', title: 'Work on: Publish the monthly newsletter', outcome: 'excluded',
      why: 'Its goal needs a decision first: nothing has moved on it since 2026-08-24.' });
  });

  test('a proposal from before today is not open work and does not fill the day', () => {
    const p = plan('old-proposals');
    expect(p.workload.open).toBe(1);
    expect(p.considered.map(c => c.title).join('\n')).not.toContain('Work on:');
  });

  test('questions say what the answer unblocks', () => {
    expect(asked(plan('last-attempt-failed'))).toBe(
      'The last attempt at "Send invoice reminders" failed its check (Three reminders bounced). Try again as it was, or change the approach first?');
    expect(asked(plan('tie-between-goals'))).toBe(
      'Which should come first: "Update pricing page" or "Write the onboarding email"? Nothing in their deadlines, health or order separates them.');
    expect(asked(plan('no-concrete-step'))).toBe('What is the first concrete step toward "Reach 10 paying customers"?');
    const marked = snap({ goals: [{ id: 'g2', title: 'Send invoice reminders' }],
      work: [{ id: 'w1', title: 'Send this week\'s invoice reminders', goal: 'g2', status: 'ready', closed: ['failed', -1] }] });
    expect(asked(planNextAction(marked))).toBe(
      'The last attempt at "Send invoice reminders" was marked failed in Tasks on 2026-10-04. Try again as it was, or change the approach first?');
    const progressed = snap({ goals: [{ id: 'g1', title: 'Grow the newsletter to 1,000 readers', level: 'key_result' }],
      work: [{ id: 'w1', title: 'Write the launch post', goal: 'g1', status: 'verified', check: ['passed', 'Published', -2] }] });
    expect(asked(planNextAction(progressed))).toBe('What is the next concrete step toward "Grow the newsletter to 1,000 readers"?');
  });

  test('a question of its own is not replaced by a tie', () => {
    const p = planNextAction(snap({ goals: [{ id: 'g1', title: 'Reach 10 paying customers', level: 'objective' }, { id: 'g2', title: 'Update pricing page' }] }));
    expect(asked(p)).toBe('What is the first concrete step toward "Reach 10 paying customers"?');
  });

  test('steps you already ordered, at any level, are not asked about', () => {
    const p = planNextAction(snap({ goals: [
      { id: 'o', title: 'Grow the business', level: 'objective' },
      { id: 'k1', title: 'Win new customers', level: 'key_result', parent: 'o', sort: 1 },
      { id: 'k2', title: 'Cut costs', level: 'key_result', parent: 'o', sort: 0 },
      { id: 'm1', title: 'Run the outreach campaign', level: 'milestone', parent: 'k1' },
      { id: 'm2', title: 'Renegotiate contracts', level: 'milestone', parent: 'k2' },
      { id: 't1', title: 'Write the outreach email', parent: 'm1' },
      { id: 't2', title: 'List the contracts up for renewal', parent: 'm2' },
    ] }));
    expect(recommended(p)).toMatchObject({ kind: 'start_step', goal: { goalId: 't2' } });
    expect(recommended(p).rationale.at(-1)).toBe('Ahead of the next option (Start "Write the outreach email"): it comes earlier in your goal order.');
  });

  test('the rationale names what separated two options of one kind', () => {
    const deadline = recommended(plan('parent-deadline'));
    expect(deadline.rationale).toContain('Due 2026-10-06, through "Close the Q3 books".');
    expect(deadline.rationale.at(-1)).toBe('Ahead of the next option (Start "Update pricing page"): it has a sooner deadline.');
    expect(plan('parent-deadline').considered).toContainEqual({ kind: 'start_step', title: 'Start "Update pricing page"', outcome: 'ranked_lower',
      why: 'Ranked below: the chosen option has a sooner deadline.' });
    const goals = [{ id: 'g2', title: 'Send invoice reminders' }, { id: 'g3', title: 'Update pricing page' }];
    const older = planNextAction(snap({ goals, work: [
      { id: 'w1', title: 'Draft the reminder email', goal: 'g2', status: 'ready', created: -2 },
      { id: 'w2', title: 'Draft the pricing copy', goal: 'g3', status: 'ready', created: -1 }] }));
    expect(recommended(older).rationale.at(-1)).toBe('Ahead of the next option (Do "Draft the pricing copy"): it is older.');
    const linked = planNextAction(snap({ goals, work: [
      { id: 'w1', title: 'Call the printer', status: 'ready', created: -2 },
      { id: 'w2', title: 'Draft the pricing copy', goal: 'g3', status: 'ready', created: -1 }] }));
    expect(recommended(linked).rationale.at(-1)).toBe('Ahead of the next option (Do "Call the printer"): it serves a goal.');
    const health = planNextAction(snap({ goals: [{ id: 'g2', title: 'Send invoice reminders', level: 'milestone', health: 'behind' }, { id: 'g3', title: 'Update pricing page' },
      { id: 'g4', title: 'Draft the reminder email', parent: 'g2' }] }));
    expect(recommended(health).rationale.at(-1)).toBe('Ahead of the next option (Start "Update pricing page"): it serves a goal in worse health.');
  });

  test('an option that adds no work says why it beats doing nothing', () => {
    expect(recommended(plan('unavailable-integration')).rationale).toContain('Better than doing nothing new: it lets accepted work run.');
    expect(recommended(plan('already-done-only')).rationale).toContain('Better than doing nothing new: it settles a goal that looks done.');
    expect(recommended(plan('stale-goal')).rationale).toContain('Better than doing nothing new: it settles what further work is worth doing.');
  });

  test('a full day still offers what adds no work, and says what it held back', () => {
    const p = plan('full-day-closes-goal');
    expect(recommended(p).kind).toBe('close_goal');
    expect(p.considered).toContainEqual({ kind: 'start_step', title: 'Start "Update pricing page"', outcome: 'ranked_lower',
      why: 'It would add work to a full day (5 of 5 items open).' });
    // A review ranks below a new step, yet on a full day it is the option left.
    const review = planNextAction(snap({ goals: [{ id: 'g2', title: 'Update pricing page' }, { id: 'g3', title: 'Publish the monthly newsletter', created: -42 }],
      work: scenario('full-queue').work }));
    expect(recommended(review)).toMatchObject({ kind: 'review_goal', goal: { goalId: 'g3' } });
  });

  test('plain commitments fill the day only when due by its end, and back an abstention as evidence', () => {
    const goals = [{ id: 'g2', title: 'Update pricing page' }];
    const dueToday = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, what: `Commitment ${i}`, due: i ? 0.4 : -2 }));
    const full = planNextAction(snap({ goals, commitments: dueToday }));
    expect(full.outcome === 'none' && full.evidence.map(e => `${e.kind}:${e.id}`)).toEqual(dueToday.map(c => `source:commitment:${c.id}`));
    const later = planNextAction(snap({ goals, commitments: dueToday.map(c => ({ ...c, due: 3 })) }));
    expect(recommended(later).kind).toBe('start_step');
    expect(later.workload.open).toBe(0);
  });

  test('dates are written in the user\'s time zone', () => {
    const s = snap({ goals: [{ id: 'g2', title: 'Send the board update' }] });
    s.goals[0]!.deadline = Date.parse('2026-10-06T23:30:00Z');
    expect(recommended(planNextAction(s)).rationale).toContain('Due 2026-10-06.');
    expect(recommended(planNextAction({ ...s, timeZone: 'Europe/Rome' })).rationale).toContain('Due 2026-10-07.');
    expect(recommended(planNextAction({ ...s, timeZone: 'Not/AZone' })).rationale).toContain('Due 2026-10-06.');
  });

  test('a goal activated recently is not stale, however old it is', () => {
    const resumed = planNextAction(snap({ goals: [{ id: 'g2', title: 'Publish the monthly newsletter', created: -60, activated: -1 }] }));
    expect(recommended(resumed).kind).toBe('start_step');
    const idle = planNextAction(snap({ goals: [{ id: 'g2', title: 'Publish the monthly newsletter', created: -60 }] }));
    expect(recommended(idle).kind).toBe('review_goal');
  });

  test('a dependency that can never finish asks for a fix', () => {
    const review = (goals: NextActionScenario['goals']) => {
      const action = recommended(planNextAction(snap({ goals })));
      expect(action.kind).toBe('review_goal');
      return action.rationale[1];
    };
    expect(review([{ id: 'g2', title: 'Send the launch email', deps: ['gone'] }])).toBe('It cannot go ahead: it depends on a goal that no longer exists.');
    expect(review([{ id: 'g2', title: 'Send the launch email', deps: ['g2'] }])).toBe('It cannot go ahead: it depends on itself.');
    expect(review([{ id: 'g2', title: 'Send the launch email', deps: ['g3'] }, { id: 'g3', title: 'Run the private beta', deps: ['g2'] }]))
      .toBe('It cannot go ahead: it and "Run the private beta" wait on each other.');
    expect(review([{ id: 'g1', title: 'Launch', level: 'milestone' }, { id: 'g2', title: 'Send the launch email', parent: 'g1', deps: ['g1'] }]))
      .toBe('It cannot go ahead: it depends on its own parent "Launch".');
    // A parent waiting on its own step does not hold that step.
    const own = planNextAction(snap({ goals: [{ id: 'g1', title: 'Launch', level: 'milestone', deps: ['g2'] }, { id: 'g2', title: 'Send the launch email', parent: 'g1' }] }));
    expect(recommended(own)).toMatchObject({ kind: 'start_step', goal: { goalId: 'g2' } });
  });

  test('a wait that ends by itself or on an outside call is not offered, but counts toward the day', () => {
    expect(recommended(plan('timer-wait')).kind).toBe('start_step');
    const outside = planNextAction(snap({ goals: [{ id: 'g2', title: 'Collect the signed contract' }],
      work: [{ id: 'w1', title: 'Wait for the signature', goal: 'g2', status: 'blocked', run: 'r1', blocker: ['waitpoint', 'Waiting at signed', 'outside'] }] }));
    expect(outside.outcome === 'none' && outside.reason).toBe('Nothing is waiting on you: 1 item is running or waiting on a timer or an outside call.');
    expect(outside.workload.open).toBe(1);
    const yours = planNextAction(snap({ goals: [{ id: 'g2', title: 'Collect the signed contract' }],
      work: [{ id: 'w1', title: 'Approve the contract', goal: 'g2', status: 'blocked', run: 'r1', blocker: ['waitpoint', 'Waiting at approve', 'you'] }] }));
    expect(recommended(yours).title).toBe('Answer what "Approve the contract" is waiting for');
  });

  test('under a held goal, settling what happened goes on and moving forward waits', () => {
    const p = planNextAction(snap({ goals: [{ id: 'g2', title: 'Send invoice reminders', status: 'paused' }], work: [
      { id: 'w1', title: 'Reminder batch 1', goal: 'g2', status: 'failed', run: 'r1', blocker: ['run_failure', 'Gmail rejected the request'] },
      { id: 'w2', title: 'Reminder batch 2', goal: 'g2', status: 'needs_check', run: 'r2' },
      { id: 'w3', title: 'Reminder batch 3', goal: 'g2', status: 'blocked', blocker: ['manual', 'Waiting for the new template'] },
      { id: 'w4', title: 'Reminder batch 4', goal: 'g2', status: 'blocked', run: 'r4', blocker: ['missing_run', 'Linked run is unavailable'] }] }));
    expect(p.considered.map(c => `${c.outcome} ${c.title}`)).toEqual([
      'chosen Check the result of "Reminder batch 2"',
      'ranked_lower Do nothing new',
      'excluded Reminder batch 3',
      'ranked_lower Find out why "Reminder batch 1" failed and record the outcome',
      'ranked_lower Close "Reminder batch 4" in Tasks: its run no longer exists',
    ]);
    expect(p.considered[2]!.why).toBe('Not now: the goal is paused.');
  });

  test('the plan lists at most 20 alternatives, reasons first, and counts what it left out', () => {
    const s = snap({ goals: [
      ...Array.from({ length: 22 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, deadline: i + 1 })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `h${i}`, title: `Held ${i}`, deps: ['t0'] })),
    ] });
    const p = planNextAction({ ...s, omittedWork: 7 });
    expect(p.considered).toHaveLength(20);
    expect(p.considered.slice(0, 5).map(c => c.outcome)).toEqual(['chosen', 'ranked_lower', 'excluded', 'excluded', 'excluded']);
    expect(p.omitted).toEqual({ work: 7, considered: 6 });
  });

  test('across every scenario: nothing blocked is offered as doable, nothing repeats or duplicates work, and a full day gets no new work', () => {
    for (const s of SCENARIO_SET.scenarios) {
      const snapshot = scenarioSnapshot(s);
      const p = planNextAction(snapshot);
      if (p.outcome !== 'recommend') continue;
      const goal = snapshot.goals.find(g => g.id === p.action.goal?.goalId);
      const work = snapshot.work.find(w => w.id === p.action.workItemId);
      if (['start_step', 'continue_work', 'decide_work'].includes(p.action.kind)) {
        for (let g = goal; g; g = snapshot.goals.find(x => x.id === g!.parentId)) {
          expect(`${s.id}: ${g.status}`).toBe(`${s.id}: active`);
          const under = (id: string | null | undefined, ancestor: string): boolean => !!id && (id === ancestor || under(snapshot.goals.find(x => x.id === id)?.parentId, ancestor));
          for (const dep of g.dependencies) {
            if (g !== goal && under(dep, g.id)) continue; // a parent waiting on its own step
            expect(`${s.id}: ${snapshot.goals.find(x => x.id === dep)?.status}`).toBe(`${s.id}: completed`);
          }
        }
      }
      if (p.action.kind === 'start_step' || p.action.kind === 'decide_work') {
        const open = [...snapshot.commitments.map(c => c.what), ...snapshot.work.filter(w => w !== work && w.commitmentStatus === 'pending'
          && ['proposed', 'ready', 'running', 'blocked', 'needs_check'].includes(w.status)).map(w => w.title)];
        if (p.action.kind === 'start_step') expect(open.map(normalize)).not.toContain(normalize(goal!.title));
        expect(`${s.id}: ${goal?.lastResult?.verdict === 'passed' && ['task', 'daily_action'].includes(goal.level)}`).toBe(`${s.id}: false`);
        if (goal) expect(snapshot.done.map(d => normalize(d.title))).not.toContain(normalize(goal.title));
      }
      if (p.action.kind === 'resolve_blocker') expect(`${s.id}: ${work?.blocker?.waitsFor ?? 'none'}`).not.toMatch(/timer|outside/);
      if (p.workload.open >= p.workload.capacity) expect(`${s.id}: ${p.action.load}`).not.toBe(`${s.id}: adds`);
    }
  });

  test('doing nothing new is always weighed', () => {
    for (const s of SCENARIO_SET.scenarios) {
      expect(planNextAction(scenarioSnapshot(s)).considered.filter(c => c.kind === 'no_action')).toHaveLength(1);
    }
  });
});

describe('live observation', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jarvis-next-action-'));
    initWorkflowDb(join(directory, 'test.db'));
  });
  afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

  const changes = () => getDb().query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
  const accept = (title: string, goalId: string | null = null) => {
    const work = createWorkItem({ title, goalId });
    decideWorkItem(work.id, { outcome: 'accepted', reason: 'Yes' });
    return work;
  };
  function workflow(trigger: Record<string, unknown>) {
    const flow = createFlow();
    return { flow, version: createDraftVersion({ flowId: flow.id, displayName: 'Lead follow-ups', trigger: { name: 'trigger', type: 'EMPTY', ...trigger } }) };
  }

  test('reads goals, open work, commitments and workflow readiness, and writes nothing', () => {
    const objective = goals.createGoal('Grow revenue', 'objective', { status: 'active' });
    const followUps = goals.createGoal('Follow up with leads', 'key_result', { status: 'active', parent_id: objective.id });
    goals.createGoal('Update pricing page', 'key_result', { status: 'active', parent_id: objective.id });
    createCommitment('Update pricing page');
    createWorkItem({ title: 'Call Bo about the renewal', goalId: followUps.id });
    // A Gmail step with no piece catalog configured: readiness cannot pass it.
    const { flow, version } = workflow({ nextAction: { name: 'send', type: 'PIECE', settings: { pieceName: '@activepieces/piece-gmail', actionName: 'send_email', input: {} } } });
    lockVersion(version.id);
    const accepted = createWorkItem({ title: 'Send lead follow-ups', goalId: followUps.id, mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id, input: {} });
    decideWorkItem(accepted.id, { outcome: 'accepted', reason: 'Yes' });
    const before = changes();

    const snapshot = observeNextAction({ now: Date.now() });
    expect(snapshot.goals.map(g => [g.title, g.parentId === objective.id])).toEqual([['Grow revenue', false], ['Follow up with leads', true], ['Update pricing page', true]]);
    expect(snapshot.work.map(w => [w.title, w.status])).toEqual([['Send lead follow-ups', 'ready'], ['Call Bo about the renewal', 'proposed']]);
    expect(snapshot.commitments.map(c => c.what)).toEqual(['Update pricing page']);
    expect(snapshot.workflows).toEqual({ [`${flow.id}:${version.id}`]: { ready: false, reason: 'send: Piece catalog is unavailable; readiness cannot be verified' } });

    const p = nextAction({ now: Date.now() });
    const action = recommended(p);
    expect([action.kind, action.workItemId]).toEqual(['restore_capability', accepted.id]);
    expect(p.considered.map(c => `${c.outcome} ${c.kind} ${c.title}`)).toEqual([
      'chosen restore_capability Fix what "Send lead follow-ups" needs to run',
      expect.stringMatching(/^ranked_lower no_action /),
      'excluded start_step Update pricing page',
      'ranked_lower decide_work Decide whether to do "Call Bo about the renewal"',
    ]);
    expect(p.considered[2]!.why).toBe('Already committed as "Update pricing page".');
    // Planning is a read: the connection records no insert, update or delete.
    expect(changes()).toBe(before);
  });

  test('old, rejected and settled work is not read, and open work is bounded newest first', () => {
    const goal = goals.createGoal('Send invoice reminders', 'task', { status: 'active' });
    const stale = createWorkItem({ title: 'Work on: Send invoice reminders', goalId: goal.id });
    getDb().run('UPDATE commitments SET created_at = ? WHERE id = ?', [Date.now() - 2 * DAY, stale.id]);
    const rejected = createWorkItem({ title: 'Call the printer' });
    decideWorkItem(rejected.id, { outcome: 'rejected', reason: 'No' });
    const older = accept('Draft the reminder email', goal.id);
    getDb().run('UPDATE commitments SET created_at = ? WHERE id = ?', [Date.now() - 3 * DAY, older.id]);
    const settled = accept('Last month\'s reminders', goal.id);
    getDb().run('UPDATE commitments SET status = ?, completed_at = ? WHERE id = ?', ['completed', Date.now() - 30 * DAY, settled.id]);
    createWorkItem({ title: 'Ask Ana for the bank details' });

    expect(observeNextAction().work.map(w => w.title)).toEqual(['Ask Ana for the bank details', 'Draft the reminder email']);
    const bounded = observeNextAction({ workLimit: 1 });
    expect([bounded.work.map(w => w.title), bounded.omittedWork]).toEqual([['Ask Ana for the bank details'], 1]);
    expect(planNextAction(bounded).omitted.work).toBe(1);
  });

  test('a goal\'s latest result is read however old, from a check or from Tasks', () => {
    const checked = goals.createGoal('Send invoice reminders', 'task', { status: 'active' });
    const reminders = accept('Send this week\'s invoice reminders', checked.id);
    checkWorkResult(reminders.id, { verdict: 'passed', summary: 'All 12 reminders sent', evidence: [{ ref: 'gmail:sent', description: 'Sent folder' }] });
    const checkedAt = Date.now() - 30 * DAY;
    getDb().run("UPDATE commitment_work SET result_check = json_set(result_check, '$.checkedAt', ?) WHERE work_id = ?", [checkedAt, reminders.id]);
    const marked = goals.createGoal('Call Ana about invoice 1042', 'task', { status: 'active' });
    const call = accept('Call Ana', marked.id);
    updateCommitmentStatus(call.id, 'completed');
    const dismissed = goals.createGoal('Update pricing page', 'task', { status: 'active' });
    const proposal = createWorkItem({ title: 'Work on: Update pricing page', goalId: dismissed.id });
    updateCommitmentStatus(proposal.id, 'failed');

    const snapshot = observeNextAction();
    const result = (id: string) => snapshot.goals.find(g => g.id === id)!.lastResult;
    expect(result(checked.id)).toMatchObject({ workId: reminders.id, verdict: 'passed', summary: 'All 12 reminders sent', at: checkedAt });
    expect(result(checked.id)!.checkId).toBeTruthy();
    expect(result(marked.id)).toMatchObject({ workId: call.id, title: 'Call Ana', verdict: 'passed', checkId: null });
    expect(result(dismissed.id)).toBeNull();
    expect(snapshot.work).toEqual([]);
    const p = planNextAction(snapshot);
    expect(p.considered.filter(c => c.kind === 'close_goal').map(c => c.title))
      .toEqual(['Record whether "Send invoice reminders" is done', 'Record whether "Call Ana about invoice 1042" is done']);
    expect(p.considered).toContainEqual(expect.objectContaining({ kind: 'start_step', title: 'Start "Update pricing page"' }));
  });

  test('a waiting run says who resumes it, and planning over runs writes nothing', () => {
    const piece = (name: string, pieceName: string, next?: Record<string, unknown>) =>
      ({ name, type: 'PIECE', settings: { pieceName, actionName: 'wait', input: {} }, ...(next ? { nextAction: next } : {}) });
    const { flow, version } = workflow({ nextAction: piece('hook', '@activepieces/piece-webhook',
      piece('approve', '@activepieces/piece-approval', piece('wait', '@activepieces/piece-delay'))) });
    const goal = goals.createGoal('Follow up with leads', 'task', { status: 'active' });
    const paused = (title: string, type: WaitpointType, stepName: string) => {
      const work = accept(title, goal.id);
      const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'PAUSED' });
      createWaitpoint({ flowRunId: run.id, projectId: DEFAULT_IDS.project, stepName, type });
      getDb().run('UPDATE commitment_work SET run_id = ? WHERE work_id = ?', [run.id, work.id]);
    };
    paused('Wait three days', 'TIMER', 'wait');
    paused('Wait for the reply', 'WEBHOOK', 'hook');
    paused('Approve the send', 'WEBHOOK', 'approve');
    paused('Confirm the effects', 'MANUAL', 'send');
    const before = changes();

    const snapshot = observeNextAction();
    expect(Object.fromEntries(snapshot.work.map(w => [w.title, w.blocker?.waitsFor])))
      .toEqual({ 'Wait three days': 'timer', 'Wait for the reply': 'outside', 'Approve the send': 'you', 'Confirm the effects': 'you' });
    const p = nextAction();
    expect(p.considered.filter(c => c.kind === 'resolve_blocker').map(c => c.title).sort())
      .toEqual(['Answer what "Approve the send" is waiting for', 'Answer what "Confirm the effects" is waiting for']);
    expect(changes()).toBe(before);
  });

  test('a run moving through its steps leaves the basis alone; finishing changes it', () => {
    const { flow, version } = workflow({});
    const goal = goals.createGoal('Follow up with leads', 'task', { status: 'active' });
    const work = accept('Send lead follow-ups', goal.id);
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
    getDb().run('UPDATE commitment_work SET run_id = ? WHERE work_id = ?', [run.id, work.id]);
    const now = Date.now();
    const first = nextAction({ now });
    Bun.sleepSync(5);
    updateRun(run.id, { steps: { send: { status: 'SUCCEEDED', output: { id: 1 } } }, stepsCount: 1 });
    expect(nextAction({ now }).basis).toBe(first.basis);
    updateRun(run.id, { status: 'SUCCEEDED', finishTime: Date.now() });
    const finished = nextAction({ now });
    expect(finished.basis).not.toBe(first.basis);
    expect(recommended(finished).kind).toBe('check_result');
  });

  test('a resume counts as activation, so a long-idle goal resumed today is not stale', () => {
    const resumed = goals.createGoal('Publish the monthly newsletter', 'task', { status: 'active' });
    const idle = goals.createGoal('Clean up the CRM', 'task', { status: 'active' });
    const longAgo = Date.now() - 60 * DAY;
    getDb().run('UPDATE goals SET created_at = ?, started_at = ?, updated_at = ?', [longAgo, longAgo, longAgo]);
    getGoalApplication().updateStatus(resumed.id, 'paused');
    getGoalApplication().updateStatus(resumed.id, 'active');

    const snapshot = observeNextAction();
    expect(snapshot.goals.find(g => g.id === resumed.id)!.activatedAt).toBeGreaterThan(longAgo);
    expect(snapshot.goals.find(g => g.id === idle.id)!.activatedAt).toBe(longAgo);
    const p = planNextAction(snapshot);
    expect(recommended(p)).toMatchObject({ kind: 'start_step', goal: { goalId: resumed.id } });
    expect(p.considered).toContainEqual(expect.objectContaining({ kind: 'review_goal', title: 'Decide whether "Clean up the CRM" is still worth pursuing' }));
  });

  test('every goal is read, past a thousand', () => {
    // Ordered last, the paused objective is the goal a cap would drop, letting its key result look startable.
    const objective = goals.createGoal('Launch the partner program', 'objective', { status: 'paused', sort_order: 2 });
    goals.createGoal('Draft the partner agreement', 'key_result', { status: 'active', parent_id: objective.id, sort_order: 0 });
    getDb().transaction(() => { for (let i = 0; i < 1_000; i++) goals.createGoal(`Filler goal ${i}`, 'task', { sort_order: 1 }); })();

    const snapshot = observeNextAction();
    expect(snapshot.goals).toHaveLength(1_002);
    const p = planNextAction(snapshot);
    expect(p.outcome).toBe('none');
    expect(p.considered).toContainEqual({ kind: 'start_step', title: 'Draft the partner agreement', outcome: 'excluded',
      why: 'Not now: its parent "Launch the partner program" is paused.' });
  });
});
