/** End-to-end over the real Today work-item service, not a storage fixture. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import { DailyRhythm } from './rhythm.ts';
import * as work from './work-items.ts';

test('actual Today checks stay linked after restart and cannot be scored twice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-review-today-'));
  const path = join(directory, 'test.db');
  try {
    initDatabase(path, { quiet: true });
    const goal = vault.createGoal('Confirm deployments', 'key_result', { status: 'active', success_criteria: 'Ten deployments' });
    const scored = work.createWorkItem({ title: 'Customer A deployed', goalId: goal.id, mode: 'manual' });
    work.decideWorkItem(scored.id, { outcome: 'accepted', reason: 'Deployment requested' });
    const checked = work.checkWorkResult(scored.id, {
      verdict: 'passed', summary: 'Customer A confirmed', goalScore: 0.1,
      evidence: [{ ref: 'customer://a/receipt', description: 'Checked deployment receipt' }],
    });
    const qualitative = work.createWorkItem({ title: 'Customer B preparation', goalId: goal.id, mode: 'manual' });
    work.decideWorkItem(qualitative.id, { outcome: 'accepted', reason: 'Prepare deployment' });
    work.checkWorkResult(qualitative.id, {
      verdict: 'passed', summary: 'Preparation checked; deployment not measured',
      evidence: [{ ref: 'customer://b/notes', description: 'Preparation notes' }],
    });
    closeDb(); initDatabase(path, { quiet: true });
    const review = new DailyRhythm({ chatTier: async (_t: string, _s: string, messages: any[]) => {
      expect(messages[1].content).toContain(checked.resultCheck!.id);
      expect(messages[1].content).toContain(checked.resultCheck!.goalProgressId!);
      return { content: JSON.stringify({ score_updates: [
        { goalId: goal.id, newScore: 0.9, reason: 'Count it again', evidenceIds: [`work_item:${scored.id}:check:${checked.resultCheck!.id}`] },
      ] }) };
    } });
    const result = await review.runEveningReview();
    expect(result.checkIn.actions_completed).toHaveLength(2);
    expect(result.reviewEvidence.rejectedScoreUpdates[0]!.reason).toBe('score_already_recorded');
    expect(vault.getGoal(goal.id)!.score).toBe(0.1);
    expect(vault.getProgressHistory(goal.id)).toHaveLength(1);
    closeDb(); initDatabase(path, { quiet: true });
    expect(vault.getRecentCheckIns('evening_review')[0]!.review_evidence).toEqual(result.reviewEvidence);
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
