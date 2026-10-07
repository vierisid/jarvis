import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initWorkflowDb } from '../workflows/db';
import { closeDb, getDb } from '../vault/schema';
import { getGoalApplication } from '../goals/application-service';
import { getGoal } from '../vault/goals';
import { createWorkItem, decideWorkItem, getWorkItem } from '../goals/work-items';
import { ApprovalManager } from '../authority/approval';
import { DeferredExecutor } from '../authority/deferred-executor';
import { AuditTrail } from '../authority/audit';
import { createFlow } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun } from '../workflows/db/repos/flow-run';
import { saveWorkflowEffect, type WorkflowEffect } from '../workflows/db/repos/workflow-effect';
import { DecisionQueue } from './decisions';
import { Recommendations } from './recommendations';
import { checkedRecommendationPlan } from './recommendation-planner';
import type { RecommendationPlan, RecommendationPlanner } from './recommendation-contracts';

let directory: string, file: string, queue: DecisionQueue, manager: ApprovalManager, provider: Recommendations;
let now: number, goalId: string, changed: number, planner: RecommendationPlanner;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const count = (table: string) => (getDb().query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
function plan(at: number): RecommendationPlan {
  return { planner: 'next-action-v1', generatedAt: at, expiresAt: at + 3_600_000,
    basis: digest([changed, getGoal(goalId), count('commitment_work')]), outcome: 'recommend',
    action: { kind: 'start_step', title: 'Contact the agreed partner', goal: { goalId, revision: String(getGoal(goalId)!.updated_at), path: ['Partner goal'] },
      workItemId: null, rationale: ['The goal has a concrete step and capacity.'], evidence: [{ kind: 'goal', id: goalId, revision: null }], load: 'adds' } };
}
function wire(p: RecommendationPlanner | null = planner) {
  manager = new ApprovalManager('f13-fixture');
  queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, new AuditTrail()) });
  provider = new Recommendations(getDb(), queue, p, () => now);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f13-')); file = join(directory, 'fixture.db'); initWorkflowDb(file);
  now = Date.now(); changed = 0;
  goalId = getGoalApplication().createGoal('Partner goal', 'task', { status: 'active' }).id;
  planner = { readiness: () => 'ready', plan }; wire();
});
afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

test('acceptance appends one canonical item, preserves the front, goal and durable receipt', async () => {
  const front = createWorkItem({ title: 'Current work' });
  let first = queue.get(`work:${front.id}`); first = queue.place(first.decisionId, first.revision, 17);
  const goal = getGoal(goalId), progress = count('goal_progress'), events = count('goal_events');
  const rec = provider.generate('generation-1');
  expect(provider.generate('generation-1')).toEqual(rec); expect(provider.read('generation-1')).toEqual(rec);
  const receipt = provider.accept(rec.recommendationId, 'accept-1', rec.revision);
  expect(receipt.created).toBe(true); expect(receipt.destination.title).toBe('Contact the agreed partner');
  expect(getWorkItem(receipt.destination.workItemId)).toMatchObject({ status: 'ready', goalId, runId: null });
  expect((await queue.read()).data.items.map(i => i.decisionId)).toEqual([first.decisionId, receipt.destination.decisionId]);
  expect(queue.get(first.decisionId)).toEqual(first);
  expect(provider.accept(rec.recommendationId, 'accept-1', rec.revision)).toEqual(receipt);
  expect(provider.accept(rec.recommendationId, 'accept-from-other-tab', rec.revision).receiptId).toBe(receipt.receiptId);
  expect(count('commitment_work')).toBe(2); expect(getGoal(goalId)).toEqual(goal);
  expect(count('goal_progress')).toBe(progress); expect(count('goal_events')).toBe(events); expect(count('flow_run')).toBe(0); expect(count('approval_requests')).toBe(0);
  closeDb(); initWorkflowDb(file); wire();
  expect(provider.get(rec.recommendationId)).toMatchObject({ state: 'accepted', acceptance: receipt });
  expect(provider.accept(rec.recommendationId, 'accept-1', rec.revision)).toEqual(receipt);
  expect((await queue.read()).data.items.map(i => i.decisionId)).toEqual([first.decisionId, receipt.destination.decisionId]);
});

test('return, dismissal, explicit refresh and expiry never create work', () => {
  const rec = provider.generate('first');
  closeDb(); initWorkflowDb(file); wire();
  expect(provider.read()).toEqual(rec); expect(provider.get(rec.recommendationId)).toEqual(rec);
  const dismissed = provider.dismiss(rec.recommendationId, rec.revision);
  expect(provider.generate('first')).toEqual(dismissed);
  expect(() => provider.accept(rec.recommendationId, 'denied', dismissed.revision)).toThrow('not available');
  const fresh = provider.generate('refresh'); expect(fresh.recommendationId).not.toBe(rec.recommendationId);
  now = fresh.plan.expiresAt;
  expect(provider.get(fresh.recommendationId).state).toBe('expired');
  expect(() => provider.accept(fresh.recommendationId, 'expired', fresh.revision)).toThrow('changed');
  expect(count('commitment_work')).toBe(0);
});

test.each(['goal', 'workload', 'capability'] as const)('%s changes invalidate a stored recommendation before acceptance', reason => {
  const rec = provider.generate(reason);
  if (reason === 'goal') getGoalApplication().updateStatus(goalId, 'paused');
  else if (reason === 'workload') createWorkItem({ title: 'Someone else added work' });
  else changed++;
  const total = count('commitment_work');
  const stale = provider.get(rec.recommendationId);
  expect(stale).toMatchObject({ state: 'blocked', reason: expect.stringContaining('changed') });
  expect(() => provider.accept(rec.recommendationId, 'stale', rec.revision)).toThrow('changed');
  expect(() => provider.accept(rec.recommendationId, 'stale-fresh-read', stale.revision)).toThrow('changed');
  expect(count('commitment_work')).toBe(total);
});

test.each(['ask', 'none'] as const)('%s remains an honest non-action across reload', outcome => {
  planner = { readiness: () => 'ready', plan: at => ({ ...plan(at), outcome,
    ...(outcome === 'ask' ? { question: 'Which goal should come first?', about: [] } : { reason: 'Nothing new is worth adding.', evidence: [] }) }) };
  wire(); const rec = provider.generate(outcome); expect(rec.state).toBe(outcome);
  expect(() => provider.accept(rec.recommendationId, outcome, rec.revision)).toThrow(rec.reason!);
  closeDb(); initWorkflowDb(file); wire();
  expect(provider.get(rec.recommendationId)).toEqual(rec); expect(count('commitment_work')).toBe(0);
});

test('existing work is linked without duplicating, renaming, accepting its pending intent or moving the front', async () => {
  const work = createWorkItem({ title: 'Existing proposal', goalId });
  const before = queue.get(`work:${work.id}`);
  planner = { readiness: () => 'ready', plan: at => {
    const p = plan(at); if (p.outcome !== 'recommend') throw Error();
    return { ...p, action: { ...p.action, kind: 'decide_work', title: 'Decide whether to do Existing proposal', workItemId: work.id, load: 'none' } };
  } }; wire();
  const rec = provider.generate('existing'); const receipt = provider.accept(rec.recommendationId, 'link', rec.revision);
  expect(receipt).toMatchObject({ created: false, destination: { decisionId: before.decisionId, workItemId: work.id, title: work.title } });
  expect(getWorkItem(work.id)).toEqual(work); expect(queue.get(before.decisionId)).toEqual(before);
  expect((await queue.read()).data.items).toEqual([before]); expect(count('commitment_work')).toBe(1);
});

test('work whose goal was deleted still links once and preserves its historical goal ID after restart', async () => {
  const original = plan(now);
  if (original.outcome !== 'recommend') throw Error();
  const work = createWorkItem({ title: 'Surviving work', goalId });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Proceed' });
  const before = getWorkItem(work.id), queued = queue.get(`work:${work.id}`);
  getGoalApplication().deleteGoal(goalId);
  planner = { readiness: () => 'ready', plan: at => ({ ...original, generatedAt: at, expiresAt: at + 3_600_000,
    basis: digest([getGoal(goalId), getWorkItem(work.id)]),
    action: { ...original.action, kind: 'continue_work', goal: null, workItemId: work.id, load: 'reduces' } }) };
  wire();
  const rec = provider.generate('deleted-goal'), events = count('goal_events');
  expect(rec.state).toBe('available');
  const receipt = provider.accept(rec.recommendationId, 'link-survivor', rec.revision);
  expect(receipt).toMatchObject({ created: false, destination: { decisionId: queued.decisionId, workItemId: work.id, title: work.title } });
  expect(getWorkItem(work.id)).toEqual(before); expect((await queue.read()).data.items).toEqual([queued]);
  expect(getGoal(goalId)).toBeNull(); expect(count('commitment_work')).toBe(1); expect(count('goal_progress')).toBe(0);
  expect(count('goal_events')).toBe(events); expect(count('flow_run')).toBe(0); expect(count('approval_requests')).toBe(0);
  closeDb(); initWorkflowDb(file); wire();
  expect(provider.get(rec.recommendationId)).toMatchObject({ state: 'accepted', acceptance: receipt });
  expect(provider.accept(rec.recommendationId, 'link-survivor', rec.revision)).toEqual(receipt);
  expect(getWorkItem(work.id)).toEqual(before); expect(queue.get(queued.decisionId)).toEqual(queued);
});

test.each(['missing', 'different'] as const)('a %s planner goal cannot link work that belongs to a live goal', context => {
  const work = createWorkItem({ title: 'Work with a live goal', goalId });
  const other = getGoalApplication().createGoal('Another goal', 'task', { status: 'active' });
  planner = { readiness: () => 'ready', plan: at => {
    const p = plan(at); if (p.outcome !== 'recommend') throw Error();
    return { ...p, action: { ...p.action, workItemId: work.id,
      goal: context === 'missing' ? null : { goalId: other.id, revision: String(other.updated_at), path: [other.title] } } };
  } }; wire();
  const rec = provider.generate(`mismatched-${context}`);
  expect(() => provider.accept(rec.recommendationId, `mismatched-${context}`, rec.revision)).toThrow('Work no longer belongs to this goal');
  expect(getWorkItem(work.id)).toEqual(work); expect(count('commitment_work')).toBe(1);
  expect(provider.get(rec.recommendationId).acceptance).toBeNull();
});

test('blocked work links its approval identity rather than creating an invisible work wrapper', async () => {
  const flow = createFlow(), version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'PAUSED' });
  const work = createWorkItem({ title: 'Waiting work', goalId, mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Proceed' });
  getDb().run('UPDATE commitment_work SET run_id = ? WHERE work_id = ?', [run.id, work.id]);
  const approval = manager.createRequest({ agentId: 'fixture', agentName: 'Fixture', toolName: 'fixture', toolArguments: {},
    actionCategory: 'write_data', urgency: 'normal', reason: 'Pending permission', context: '', executionMode: 'workflow' });
  const effect: WorkflowEffect = { id: 'effect', runId: run.id, projectId: run.projectId, flowId: flow.id, versionId: version.id,
    versionDigest: 'fixture', stepName: 'step', executionPath: [], route: 'tool', toolName: 'fixture', actionCategory: 'write_data',
    requestDigest: 'fixture', arguments: {}, target: {}, provenance: {}, decision: 'approval_required', reason: 'Review', status: 'pending',
    approvalId: approval.id, waitpointId: null, createdAt: now };
  saveWorkflowEffect(effect);
  planner = { readiness: () => 'ready', plan: at => { const p = plan(at); if (p.outcome !== 'recommend') throw Error();
    return { ...p, action: { ...p.action, kind: 'resolve_blocker', workItemId: work.id, load: 'reduces' } }; } }; wire();
  const before = queue.get(`approval:${approval.id}`), rec = provider.generate('blocked');
  const receipt = provider.accept(rec.recommendationId, 'blocked', rec.revision);
  expect(receipt.destination).toEqual({ decisionId: before.decisionId, workItemId: work.id, title: before.title });
  expect((await queue.read()).data.items).toEqual([before]); expect(manager.getRequest(approval.id)!.status).toBe('pending');
});

test('queue failure rolls back work creation, intent acceptance and receipt together', () => {
  const front = createWorkItem({ title: 'Queue at limit' }); const item = queue.get(`work:${front.id}`);
  queue.place(item.decisionId, item.revision, 1_000_000);
  const rec = provider.generate('full');
  expect(() => provider.accept(rec.recommendationId, 'full', rec.revision)).toThrow('placement is full');
  expect(count('commitment_work')).toBe(1); expect(count('commitments')).toBe(1);
  expect(provider.get(rec.recommendationId)).toEqual(rec);
});

test('acceptance rechecks under the write lock even without an intervening read', () => {
  const rec = provider.generate('race'); changed++;
  expect(() => provider.accept(rec.recommendationId, 'race', rec.revision)).toThrow('changed');
  expect(count('commitment_work')).toBe(0);
});

test('missing, failed and replaced dependencies fail closed without saving a recommendation', async () => {
  wire(null); expect(provider.readiness()).toBe('unavailable'); expect(() => provider.generate('none')).toThrow('unavailable');
  wire({ readiness: () => 'ready', plan: () => { throw Error('PRIVATE PROVIDER FAILURE'); } });
  expect(() => provider.generate('failed')).toThrow('planning is unavailable'); expect(count('brief_recommendation')).toBe(0);
  wire(); closeDb(); initWorkflowDb(':memory:');
  expect(provider.readiness()).toBe('unavailable'); expect(() => provider.generate('replaced')).toThrow('unavailable');
});

test('planner wire projection is bounded and strips unreviewed extra source fields', () => {
  const source = { ...plan(now), rawSnapshot: 'PRIVATE RAW DATA', action: { ...(plan(now) as Extract<RecommendationPlan, { outcome: 'recommend' }>).action,
    rawRun: { steps: 'PRIVATE RAW DATA' } } };
  expect(JSON.stringify(checkedRecommendationPlan(source, now))).not.toContain('PRIVATE RAW DATA');
  for (const bad of [{ ...source, planner: 'unknown' }, { ...source, basis: '' }, { ...source, expiresAt: now },
    { ...source, expiresAt: now + 13 * 3_600_000 }, { ...source, action: { ...source.action, evidence: [] } },
    { ...source, action: { ...source.action, title: 'x'.repeat(10_001) } }]) expect(() => checkedRecommendationPlan(bad, now)).toThrow();
});


test('return uses insertion order even when the wall clock moves backwards', () => {
  const first = provider.generate('clock-before'); now -= 1;
  const latest = provider.generate('clock-after');
  expect(latest.recommendationId).not.toBe(first.recommendationId);
  expect(provider.read()).toEqual(latest);
});

test('a changed planner choice with the same basis cannot authorize an old action', () => {
  let reviewed = false;
  planner = { readiness: () => 'ready', plan: at => { const p = plan(at); if (p.outcome !== 'recommend') throw Error();
    return { ...p, action: { ...p.action, kind: reviewed ? 'review_goal' : 'start_step' } }; } }; wire();
  const rec = provider.generate('choice'); reviewed = true;
  expect(provider.get(rec.recommendationId).state).toBe('blocked');
  expect(() => provider.accept(rec.recommendationId, 'choice', rec.revision)).toThrow('changed');
  expect(count('commitment_work')).toBe(0);
});


test('two independent processes accept the same saved recommendation exactly once', async () => {
  // Fixed planner output isolates process/transaction fencing from Q-18 ranking.
  const fixed = plan(now);
  planner = { readiness: () => 'ready', plan: at => ({ ...fixed, generatedAt: at, expiresAt: at + 3_600_000 }) }; wire();
  const rec = provider.generate('parallel');
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = (ready: string) => `
    import { writeFileSync } from 'node:fs';
    import { initWorkflowDb } from ${module('../workflows/db/index.ts')};
    import { getDb, closeDb } from ${module('../vault/schema.ts')};
    import { ApprovalManager } from ${module('../authority/approval.ts')};
    import { DeferredExecutor } from ${module('../authority/deferred-executor.ts')};
    import { AuditTrail } from ${module('../authority/audit.ts')};
    import { DecisionQueue } from ${module('./decisions.ts')};
    import { Recommendations } from ${module('./recommendations.ts')};
    initWorkflowDb(${JSON.stringify(file)});
    const manager = new ApprovalManager('child');
    const queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, new AuditTrail()) });
    const fixed = ${JSON.stringify(fixed)};
    const readyFile = ${JSON.stringify(ready)};
    const provider = new Recommendations(getDb(), queue, { readiness: () => 'ready', plan: now => ({ ...fixed, generatedAt: now, expiresAt: now + 3600000 }) });
    getDb().run('PRAGMA busy_timeout = 5000');
    writeFileSync(readyFile, 'ready');
    await new Response(Bun.stdin.stream()).text();
    console.log('RECEIPT:' + JSON.stringify(provider.accept(${JSON.stringify(rec.recommendationId)}, 'parallel', ${JSON.stringify(rec.revision)})));
    closeDb();
  `;
  // Initialize the shared schema serially; race only the recommendation writer.
  const children: Bun.Subprocess<'pipe', 'pipe', 'pipe'>[] = [];
  try {
    for (const index of [0, 1]) {
      const ready = join(directory, `ready-${index}`);
      const child = Bun.spawn([process.execPath, '--eval', script(ready)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      children.push(child);
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
    }
    for (const child of children) child.stdin.end();
  const results = await Promise.all(children.map(async child => {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).not.toContain('error:'); expect(exit).toBe(0);
    return JSON.parse(stdout.split('RECEIPT:')[1]!.trim());
  }));
  expect(results[0]).toEqual(results[1]); expect(count('commitment_work')).toBe(1);
  expect(provider.get(rec.recommendationId).acceptance).toEqual(results[0]);
  } finally { for (const child of children) { child.kill(); await child.exited; } }
}, 15_000);
