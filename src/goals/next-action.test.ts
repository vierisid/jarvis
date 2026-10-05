import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb } from '../vault/schema.ts';
import { initWorkflowDb } from '../workflows/db/index.ts';
import * as goals from '../vault/goals.ts';
import { createCommitment } from '../vault/commitments.ts';
import { createFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version.ts';
import { configureWorkItem, createWorkItem, decideWorkItem } from './work-items.ts';
import { nextAction, observeNextAction, PLAN_TTL, planNextAction, PLANNER, type NextActionPlan, type PlanSnapshot } from './next-action.ts';
import { SCENARIO_NOW, SCENARIO_SET, scenarioMisses, scenarioSnapshot, type NextActionScenario } from './next-action-scenarios.ts';

const scenario = (id: string): NextActionScenario => SCENARIO_SET.scenarios.find(s => s.id === id)!;
const plan = (id: string) => planNextAction(scenarioSnapshot(scenario(id)));
const recommended = (p: NextActionPlan) => { if (p.outcome !== 'recommend') throw new Error(`expected a recommendation, got ${p.outcome}`); return p.action; };
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

describe('founder-review scenarios', () => {
  for (const s of SCENARIO_SET.scenarios) {
    test(`${s.id}: ${s.situation}`, () => {
      expect(scenarioMisses(s, planNextAction(scenarioSnapshot(s)))).toEqual([]);
    });
  }

  test('the set covers the cases the card names, and the pass conditions', () => {
    const ids = SCENARIO_SET.scenarios.map(s => s.id);
    for (const id of ['already-done', 'stale-goal', 'unavailable-integration', 'duplicate-commitment', 'blocked-by-dependency',
      'full-queue', 'no-concrete-step', 'last-attempt-failed', 'tie-between-goals']) expect(ids).toContain(id);
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
    expect({ planner: p.planner, generatedAt: p.generatedAt, expiresAt: p.expiresAt, workload: p.workload })
      .toEqual({ planner: PLANNER, generatedAt: SCENARIO_NOW, expiresAt: SCENARIO_NOW + PLAN_TTL, workload: { open: 2, capacity: 5 } });
  });

  test('a goal deadline inside the window brings the expiry forward', () => {
    const s = scenarioSnapshot(scenario('deadline-breaks-tie'));
    s.goals.find(g => g.id === 'g3')!.deadline = SCENARIO_NOW + 6 * 3_600_000;
    expect(planNextAction(s).expiresAt).toBe(SCENARIO_NOW + 6 * 3_600_000);
  });

  test('the basis ignores the clock and changes with any input', () => {
    const s = scenarioSnapshot(scenario('continue-before-starting'));
    const first = planNextAction(s);
    expect(planNextAction({ ...s, now: s.now + 3_600_000 }).basis).toBe(first.basis);
    expect(planNextAction({ ...s, goals: s.goals.map(g => g.id === 'g3' ? { ...g, title: 'Update the pricing page' } : g) }).basis).not.toBe(first.basis);
    expect(planNextAction({ ...s, capacity: 4 }).basis).not.toBe(first.basis);
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
    const none = plan('full-queue');
    expect(none.outcome === 'none' && none.reason).toBe('5 items are already open, at your limit of 5. Finish or check some before adding more.');
  });

  test('questions say what the answer unblocks', () => {
    const failed = plan('last-attempt-failed');
    expect(failed.outcome === 'ask' && failed.question).toBe(
      'The last attempt at "Send invoice reminders" failed its check (Three reminders bounced). Try again as it was, or change the approach first?');
    const tie = plan('tie-between-goals');
    expect(tie.outcome === 'ask' && tie.question).toBe(
      'Which should come first: "Update pricing page" or "Write the onboarding email"? Nothing in their deadlines, health or order separates them.');
    const vague = plan('no-concrete-step');
    expect(vague.outcome === 'ask' && vague.question).toBe('What is the first concrete step toward "Reach 10 paying customers"?');
  });

  test('across every scenario: nothing blocked is offered as doable, nothing duplicates open work, and a full day gets no new work', () => {
    for (const s of SCENARIO_SET.scenarios) {
      const snapshot = scenarioSnapshot(s);
      const p = planNextAction(snapshot);
      if (p.outcome !== 'recommend') continue;
      const goal = snapshot.goals.find(g => g.id === p.action.goal?.goalId);
      if (p.action.kind === 'start_step' || p.action.kind === 'continue_work') {
        for (let g = goal; g; g = snapshot.goals.find(x => x.id === g!.parentId)) expect(`${s.id}: ${g.status}`).toBe(`${s.id}: active`);
        for (const dep of goal?.dependencies ?? []) expect(`${s.id}: ${snapshot.goals.find(x => x.id === dep)?.status}`).toBe(`${s.id}: completed`);
      }
      if (p.action.kind === 'start_step') {
        const open = [...snapshot.commitments.map(c => c.what), ...snapshot.work.filter(w => !['verified', 'rejected'].includes(w.status)).map(w => w.title)];
        expect(open.map(normalize)).not.toContain(normalize(goal!.title));
        expect(snapshot.work.some(w => w.goalId === goal!.id && w.check?.verdict === 'passed')).toBe(false);
      }
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

  function lockedWorkflow() {
    const flow = createFlow();
    // A Gmail step with no piece catalog configured: readiness cannot pass it.
    const version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Lead follow-ups', trigger: { name: 'trigger', type: 'EMPTY',
      nextAction: { name: 'send', type: 'PIECE', settings: { pieceName: '@activepieces/piece-gmail', actionName: 'send_email', input: {} } } } }).id);
    return { flow, version };
  }
  const counts = () => Object.fromEntries(['goals', 'commitments', 'commitment_work', 'goal_progress', 'goal_check_ins']
    .map(table => [table, getDb().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n]));

  test('reads goals, open work, commitments and workflow readiness, and writes nothing', () => {
    const objective = goals.createGoal('Grow revenue', 'objective', { status: 'active' });
    const followUps = goals.createGoal('Follow up with leads', 'key_result', { status: 'active', parent_id: objective.id });
    const pricing = goals.createGoal('Update pricing page', 'key_result', { status: 'active', parent_id: objective.id });
    createCommitment('Update pricing page');
    const proposal = createWorkItem({ title: 'Call Bo about the renewal', goalId: followUps.id });
    const { flow, version } = lockedWorkflow();
    const accepted = createWorkItem({ title: 'Send lead follow-ups', goalId: followUps.id, mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id, input: {} });
    decideWorkItem(accepted.id, { outcome: 'accepted', reason: 'Yes' });
    const before = counts();

    const snapshot = observeNextAction({ now: Date.now() });
    expect(snapshot.goals.map(g => [g.title, g.parentId === objective.id])).toEqual([['Grow revenue', false], ['Follow up with leads', true], ['Update pricing page', true]]);
    expect(snapshot.work.map(w => [w.title, w.status])).toEqual([['Call Bo about the renewal', 'proposed'], ['Send lead follow-ups', 'ready']]);
    expect(snapshot.commitments.map(c => c.what)).toEqual(['Update pricing page']);
    expect(snapshot.workflows).toEqual({ [`${flow.id}:${version.id}`]: { ready: false, reason: 'send: Piece catalog is unavailable; readiness cannot be verified' } });

    const p = nextAction({ now: Date.now() });
    const action = recommended(p);
    expect([action.kind, action.workItemId]).toEqual(['restore_capability', accepted.id]);
    expect(p.considered.map(c => `${c.outcome} ${c.kind} ${c.title}`)).toEqual([
      'chosen restore_capability Fix what "Send lead follow-ups" needs to run',
      expect.stringMatching(/^ranked_lower no_action /),
      'ranked_lower decide_work Decide whether to do "Call Bo about the renewal"',
      'excluded start_step Update pricing page',
    ]);
    expect(p.considered.at(-1)!.why).toBe('Already committed as "Update pricing page".');
    expect(pricing.id).toBeTruthy();
    expect(proposal.status).toBe('proposed');
    // Planning is a read: no commitment, work item, progress entry or check-in is created.
    expect(counts()).toEqual(before);
  });

  test('work settled long ago is not read', () => {
    const goal = goals.createGoal('Send invoice reminders', 'task', { status: 'active' });
    const work = createWorkItem({ title: 'Reminder batch', goalId: goal.id });
    decideWorkItem(work.id, { outcome: 'accepted', reason: 'Yes' });
    getDb().run('UPDATE commitments SET status = ?, completed_at = ? WHERE id = ?', ['completed', Date.now() - 30 * 86_400_000, work.id]);
    expect(observeNextAction().work).toEqual([]);
  });
});
