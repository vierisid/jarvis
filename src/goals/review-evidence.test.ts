import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { createCommitment } from '../vault/commitments.ts';
import * as vault from '../vault/goals.ts';
import { DailyRhythm } from './rhythm.ts';
import { buildGoalReviewBundle, getGoalReviewRecord, MAX_REVIEW_BUNDLE_CHARS, validateReviewScores } from './review-evidence.ts';

let directory: string | undefined;
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => {
  closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const goal = () => vault.createGoal('Customer deployments', 'key_result', {
  status: 'active', success_criteria: 'Ten confirmed customer deployments',
});
const proposal = (goalId: string, evidenceIds: unknown = []) => ({ goalId, newScore: 0.9, reason: 'Progress', evidenceIds });
const rhythm = (response: unknown) => new DailyRhythm({ chatTier: async () => ({ content: JSON.stringify(response) }) });

/** Fixture for the optional #450 storage contract; production does not create this table here. */
function checkedWork(goalId: string, overrides: Record<string, unknown> = {}) {
  getDb().exec(`CREATE TABLE IF NOT EXISTS commitment_work (
    work_id TEXT PRIMARY KEY REFERENCES commitments(id), goal_id TEXT, run_id TEXT,
    result_check TEXT, updated_at INTEGER NOT NULL
  )`);
  const work = createCommitment('Deploy the release');
  const check = {
    id: crypto.randomUUID(), verdict: 'passed', summary: 'Customer confirmed the deployment',
    checkedBy: 'user', checkedAt: Date.now(), runId: null, runSnapshot: null, goalProgressId: null,
    evidence: [{ ref: 'customer://confirmation', description: 'Customer receipt checked' }], ...overrides,
  };
  getDb().query('INSERT INTO commitment_work (work_id, goal_id, run_id, result_check, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(work.id, goalId, null, JSON.stringify(check), Date.now());
  return { work, check, id: `work_item:${work.id}:check:${check.id}` };
}

describe('automatic score boundary', () => {
  test.each([undefined, null, {}, [], '0.9', NaN, Infinity, -1, 2])('malformed score %p cannot create progress', async score => {
    const g = goal();
    const result = await rhythm({ score_updates: [{ ...proposal(g.id), newScore: score }] }).runEveningReview();
    expect(result.scoreUpdates).toEqual([]);
    expect(vault.getGoal(g.id)!.score).toBe(0);
    expect(vault.getProgressHistory(g.id)).toEqual([]);
    expect(result.reviewEvidence.rejectedScoreUpdates[0]!.reason).toBe('invalid_update');
  });

  test('unknown, missing and out-of-bundle known IDs never appear as accepted updates', async () => {
    const g = goal();
    const excluded = vault.createGoal('A paused goal', 'task', { status: 'paused' });
    const events: any[] = [];
    const review = rhythm({ score_updates: [null, {}, proposal('invented'), proposal(excluded.id), proposal(g.id)] });
    review.setEventCallback(event => events.push(event));
    const result = await review.runEveningReview();
    expect(result.reviewEvidence.rejectedScoreUpdates.map(r => r.reason)).toEqual([
      'invalid_update', 'invalid_update', 'goal_not_in_bundle', 'goal_not_in_bundle', 'no_evidence',
    ]);
    expect(events[0].data.scoreUpdates).toEqual([]);
    expect(vault.getGoal(g.id)!.score).toBe(0);
    expect(vault.getGoal(excluded.id)!.score).toBe(0);
  });

  test('activity, prior scores, cross-goal references and invented evidence are rejected', () => {
    const first = goal();
    const second = goal();
    vault.updateGoalScore(first.id, 0.3, 'User assessment');
    const activity = vault.addProgressEntry(first.id, 'auto_detected', 0.3, 0.3, 'Editor open', 'awareness');
    const foreign = checkedWork(second.id);
    const bundle = buildGoalReviewBundle(vault.findGoals({ status: 'active' }), null);
    const history = bundle.goals.find(g => g.goalId === first.id)!.scoreHistory[0]!;
    const result = validateReviewScores(bundle, [
      proposal(first.id, [`goal_progress:${activity.id}`]), proposal(first.id, [history.id]),
      proposal(first.id, [foreign.id]), proposal(first.id, ['invented']),
    ]);
    expect(result.rejectedScoreUpdates.map(r => r.reason)).toEqual([
      'activity_or_score_history_only', 'activity_or_score_history_only', 'evidence_not_in_goal_bundle', 'evidence_not_in_goal_bundle',
    ]);
    expect(vault.getGoal(first.id)!.score).toBe(0.3);
  });

  test('qualitative checks do not authorize arbitrary scores or recount recorded scores', async () => {
    const g = goal();
    const passed = checkedWork(g.id);
    const failed = checkedWork(g.id, { verdict: 'failed', summary: 'Customer could not deploy' });
    vault.updateGoalScore(g.id, 0.4, 'User checked progress');
    const progress = vault.getProgressHistory(g.id)[0]!;
    const scored = checkedWork(g.id, { goalProgressId: progress.id });
    const result = await rhythm({ score_updates: [
      proposal(g.id, [passed.id]), proposal(g.id, [failed.id]), proposal(g.id, [scored.id]),
    ], actions_completed: ['An invented completion'] }).runEveningReview();
    expect(result.reviewEvidence.rejectedScoreUpdates.map(r => r.reason)).toEqual([
      'no_verified_score_mapping', 'no_verified_score_mapping', 'score_already_recorded',
    ]);
    expect(result.checkIn.actions_completed).toHaveLength(2);
    expect(result.checkIn.actions_completed.join(' ')).toContain(passed.id);
    expect(result.checkIn.actions_completed.join(' ')).not.toContain(failed.id);
    expect(result.checkIn.actions_completed.join(' ')).not.toContain('invented');
    expect(vault.getGoal(g.id)!.score).toBe(0.4);
    expect(vault.getProgressHistory(g.id)).toHaveLength(1);
  });

  test.each(['score', 'criteria', 'status', 'delete'])('a concurrent %s change survives the review', async change => {
    const g = goal();
    const review = new DailyRhythm({ chatTier: async () => {
      if (change === 'score') vault.updateGoalScore(g.id, 0.6, 'User correction');
      if (change === 'criteria') vault.updateGoal(g.id, { success_criteria: 'Twenty deployments' });
      if (change === 'status') vault.updateGoalStatus(g.id, 'paused');
      if (change === 'delete') vault.deleteGoal(g.id);
      return { content: JSON.stringify({ score_updates: [proposal(g.id)] }) };
    } });
    const result = await review.runEveningReview();
    expect(result.reviewEvidence.rejectedScoreUpdates[0]!.reason).toBe('goal_changed');
    expect(vault.getGoal(g.id)?.score ?? null).toBe(change === 'delete' ? null : change === 'score' ? 0.6 : 0);
  });

  test('malformed collections and excessive proposals produce bounded rejection records', async () => {
    const g = goal();
    const invalid = await rhythm({ score_updates: { goalId: g.id } }).runEveningReview();
    expect(invalid.reviewEvidence.rejectedScoreUpdates[0]!.reason).toBe('invalid_update');
    const excessive = await rhythm({ score_updates: Array.from({ length: 200 }, () => proposal(g.id)) }).runEveningReview();
    expect(excessive.reviewEvidence.rejectedScoreUpdates).toHaveLength(100);
    expect(excessive.reviewEvidence.proposalsTruncated).toBe(true);
    expect(vault.getProgressHistory(g.id)).toEqual([]);
  });
});

describe('evidence snapshots', () => {
  test('only checks within the local review day count, regardless of work creation date', () => {
    const g = goal();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const old = checkedWork(g.id, { checkedAt: today.getTime() - 1 });
    const future = checkedWork(g.id, { checkedAt: Date.now() + 86_400_000 });
    const fresh = checkedWork(g.id, { checkedAt: today.getTime() });
    getDb().query('UPDATE commitments SET created_at = ? WHERE id = ?').run(today.getTime() - 86_400_000, fresh.work.id);
    const outdatedNote = vault.addProgressEntry(g.id, 'auto_detected', 0, 0, 'Yesterday activity', 'awareness');
    getDb().query('UPDATE goal_progress SET created_at = ? WHERE id = ?').run(today.getTime() - 1, outdatedNote.id);
    const bundle = buildGoalReviewBundle([g], null);
    expect(bundle.goals[0]!.verifiedOutcomes.map(o => o.id)).toEqual([fresh.id]);
    expect(JSON.stringify(bundle)).not.toContain(old.id);
    expect(JSON.stringify(bundle)).not.toContain(future.id);
    expect(bundle.goals[0]!.activity).toEqual([]);
  });

  test('unchecked, malformed, unsupported and evidence-free results never become verified completions', async () => {
    const g = goal();
    checkedWork(g.id, { evidence: [] });
    checkedWork(g.id, { checkedBy: 'model' });
    checkedWork(g.id, { runId: 'other-run' });
    const invalid = checkedWork(g.id);
    getDb().query('UPDATE commitment_work SET result_check = ? WHERE work_id = ?').run('{bad json', invalid.work.id);
    const unchecked = checkedWork(g.id);
    getDb().query('UPDATE commitment_work SET result_check = NULL WHERE work_id = ?').run(unchecked.work.id);
    const result = await rhythm({ actions_completed: ['Completed everything'] }).runEveningReview();
    expect(result.reviewEvidence.bundle.goals[0]!.verifiedOutcomes).toEqual([]);
    expect(result.checkIn.actions_completed).toEqual([]);
  });

  test('bounds context, preserves other goals and discloses omissions including escaped text', () => {
    const noisyText = '\u0001'.repeat(10_000);
    const many = Array.from({ length: 21 }, () => vault.createGoal(noisyText, 'task', {
      status: 'active', success_criteria: noisyText,
    }));
    for (const g of many) for (let i = 0; i < 8; i++) {
      vault.addProgressEntry(g.id, 'auto_detected', 0, 0, noisyText, 'awareness');
    }
    const morning = vault.createCheckIn('morning_plan', noisyText, [], Array.from({ length: 25 }, () => noisyText));
    const bundle = buildGoalReviewBundle(many, morning);
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(MAX_REVIEW_BUNDLE_CHARS);
    expect(bundle.goals).toHaveLength(20);
    expect(bundle.goalsOmitted).toBe(1);
    expect(bundle.goals.every(g => g.truncated)).toBe(true);
    expect(bundle.morningIntentions!.truncated).toBe(true);
    expect(bundle.goals[19]!.goalId).toBe(many[19]!.id);
  });

  test('evidence and decisions survive reopening the database and are exposed by check-in reads', async () => {
    directory = mkdtempSync(join(tmpdir(), 'jarvis-goal-review-'));
    const path = join(directory, 'review.db');
    initDatabase(path, { quiet: true });
    const g = goal();
    const checked = checkedWork(g.id);
    const result = await rhythm({ score_updates: [proposal(g.id, [checked.id])] }).runEveningReview();
    closeDb();
    initDatabase(path, { quiet: true });
    expect(getGoalReviewRecord(result.checkIn.id)).toEqual(result.reviewEvidence);
    expect(vault.getRecentCheckIns('evening_review')[0]!.review_evidence).toEqual(result.reviewEvidence);
    expect(vault.getGoal(g.id)!.score).toBe(0);
    const child = Bun.spawnSync([process.execPath, '--eval', `
      const schema = await import(${JSON.stringify(new URL('../vault/schema.ts', import.meta.url).href)});
      const goals = await import(${JSON.stringify(new URL('../vault/goals.ts', import.meta.url).href)});
      schema.initDatabase(${JSON.stringify(path)}, { quiet: true });
      process.stdout.write(JSON.stringify(goals.getRecentCheckIns('evening_review')[0].review_evidence));
      schema.closeDb();
    `]);
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual(result.reviewEvidence);
    const repeated = await rhythm({ score_updates: [proposal(g.id, [checked.id])] }).runEveningReview();
    expect(repeated.scoreUpdates).toEqual([]);
    expect(vault.getProgressHistory(g.id)).toEqual([]);
  });

  test('LLM failure still records its input evidence without inventing progress', async () => {
    const g = goal();
    const note = vault.addProgressEntry(g.id, 'auto_detected', 0, 0, 'Editor open', 'awareness');
    const result = await new DailyRhythm({ chatTier: async () => { throw new Error('offline'); } }).runEveningReview();
    expect(getGoalReviewRecord(result.checkIn.id)!.bundle.goals[0]!.activity[0]!.id).toBe(`goal_progress:${note.id}`);
    expect(result.checkIn.actions_completed).toEqual([]);
    expect(result.scoreUpdates).toEqual([]);
  });

  test('an audit write failure rolls back the check-in, with no partially applied scores', async () => {
    const g = goal();
    getDb().exec(`CREATE TRIGGER fail_review BEFORE INSERT ON goal_review_evidence
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    await expect(rhythm({ score_updates: [proposal(g.id)] }).runEveningReview()).rejects.toThrow('audit unavailable');
    expect(vault.getRecentCheckIns('evening_review')).toEqual([]);
    expect(vault.getProgressHistory(g.id)).toEqual([]);
    expect(vault.getGoal(g.id)!.score).toBe(0);
  });
});
