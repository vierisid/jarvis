/** Evidence for automatic reviews. Text activity is never a measured score. */
import { generateId, getDb } from '../vault/schema.ts';
import { getGoal } from '../vault/goals.ts';
import type { Goal, GoalCheckIn, GoalProgressEntry } from './types.ts';

const MAX_RECORDS_PER_GOAL = 5;
export const MAX_REVIEW_BUNDLE_CHARS = 40_000;
// Bound serialized context too: control characters expand when JSON-escaped.
function clip(text: string, max = 500): string {
  if (JSON.stringify(text).length <= max + 2) return text;
  let result = '';
  let size = 0;
  for (const char of text) {
    const cost = JSON.stringify(char).length - 2;
    if (size + cost > max - 1) break;
    result += char;
    size += cost;
  }
  return result + '…';
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

export type ReviewOutcome = {
  id: string;
  goalId: string;
  workItemId: string;
  checkId: string;
  verdict: 'passed' | 'failed';
  summary: string;
  checkedBy: 'user';
  checkedAt: number;
  runId: string | null;
  evidence: { ref: string; description: string }[];
  evidenceTruncated: boolean;
  // A recorded user score is already applied, not a pending automatic update.
  goalProgressId: string | null;
};

export type GoalReviewBundle = {
  version: 1;
  id: string;
  window: { start: number; end: number };
  scorePolicy: 'no_verified_score_mapping';
  outcomeSource: 'today_result_checks' | 'unavailable';
  goalsOmitted: number;
  morningIntentions: { checkInId: string; summary: string; actions: string[]; truncated: boolean } | null;
  goals: {
    goalId: string; title: string; level: string; score: number; health: string;
    successCriteria: string; updatedAt: number;
    activity: { id: string; goalId: string; note: string; source: string; type: GoalProgressEntry['type']; observedAt: number }[];
    scoreHistory: { id: string; goalId: string; note: string; source: string; type: GoalProgressEntry['type'];
      scoreBefore: number; scoreAfter: number; recordedAt: number }[];
    verifiedOutcomes: ReviewOutcome[];
    truncated: boolean;
  }[];
};

export type RejectedReviewScore = {
  goalId: string | null;
  reason: 'invalid_update' | 'goal_not_in_bundle' | 'goal_changed' | 'no_evidence'
    | 'evidence_not_in_goal_bundle' | 'activity_or_score_history_only'
    | 'score_already_recorded' | 'no_verified_score_mapping';
};
export type GoalReviewRecord = {
  bundle: GoalReviewBundle;
  rejectedScoreUpdates: RejectedReviewScore[];
  proposalsTruncated: boolean;
};

/** Optional #450 adapter. No dependency on its service or workflow database. */
function hasTodayChecks(): boolean {
  const db = getDb();
  if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'commitment_work'").get()) return false;
  const columns = new Set((db.query('PRAGMA table_info(commitment_work)').all() as { name: string }[]).map(c => c.name));
  return ['work_id', 'goal_id', 'run_id', 'result_check'].every(c => columns.has(c));
}

function readOutcomes(goalId: string, start: number, end: number): { outcomes: ReviewOutcome[]; truncated: boolean } {
  // Select by check time, not plan/commitment creation: yesterday's work may be
  // checked today. Invalid legacy JSON must not break the whole evening review.
  const rows = getDb().query(`
    SELECT work_id, run_id, result_check FROM commitment_work
    WHERE goal_id = ? AND json_extract(CASE WHEN json_valid(result_check) THEN result_check END, '$.checkedAt') BETWEEN ? AND ?
    ORDER BY json_extract(result_check, '$.checkedAt') DESC, work_id ASC LIMIT ?
  `).all(goalId, start, end, MAX_RECORDS_PER_GOAL + 1) as {
    work_id: string; run_id: string | null; result_check: string;
  }[];
  const outcomes: ReviewOutcome[] = [];
  for (const row of rows.slice(0, MAX_RECORDS_PER_GOAL)) {
    const check: unknown = JSON.parse(row.result_check);
    if (!object(check) || !nonempty(check.id) || !nonempty(check.summary)
      || check.checkedBy !== 'user' || !['passed', 'failed'].includes(String(check.verdict))
      || typeof check.checkedAt !== 'number' || !Number.isFinite(check.checkedAt)
      || check.checkedAt < start || check.checkedAt > end || check.runId !== row.run_id
      || !(check.goalProgressId === null || nonempty(check.goalProgressId))
      || !Array.isArray(check.evidence) || !check.evidence.length || check.evidence.length > 20
      || !check.evidence.every(e => object(e) && nonempty(e.ref) && nonempty(e.description))) continue;
    outcomes.push({
      id: `work_item:${row.work_id}:check:${check.id}`, goalId, workItemId: row.work_id,
      checkId: check.id, verdict: check.verdict as 'passed' | 'failed', summary: clip(check.summary),
      checkedBy: 'user', checkedAt: check.checkedAt, runId: row.run_id,
      evidence: check.evidence.slice(0, 5).map(e => ({ ref: clip(e.ref, 300), description: clip(e.description, 300) })),
      evidenceTruncated: check.evidence.length > 5 || check.evidence.some(e => clip(e.ref, 300) !== e.ref || clip(e.description, 300) !== e.description),
      goalProgressId: check.goalProgressId,
    });
  }
  return { outcomes, truncated: rows.length > MAX_RECORDS_PER_GOAL || outcomes.length !== rows.length
    || rows.some(row => { const check = JSON.parse(row.result_check); return nonempty(check.summary) && clip(check.summary) !== check.summary; }) };
}

export function buildGoalReviewBundle(goals: Goal[], morning: GoalCheckIn | null, now = Date.now()): GoalReviewBundle {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayAvailable = hasTodayChecks();
  const activeCount = (getDb().query("SELECT COUNT(*) AS count FROM goals WHERE status = 'active'").get() as { count: number }).count;
  const bundle: GoalReviewBundle = {
    version: 1, id: generateId(), window: { start: start.getTime(), end: now },
    scorePolicy: 'no_verified_score_mapping', outcomeSource: todayAvailable ? 'today_result_checks' : 'unavailable',
    goalsOmitted: Math.max(0, activeCount - Math.min(goals.length, 20)),
    morningIntentions: morning ? {
      checkInId: morning.id, summary: clip(morning.summary, 1000),
      actions: morning.actions_planned.slice(0, 20).map(a => clip(a, 300)),
      truncated: clip(morning.summary, 1000) !== morning.summary || morning.actions_planned.length > 20 || morning.actions_planned.some(a => clip(a, 300) !== a),
    } : null,
    goals: goals.slice(0, 20).map(goal => {
      const readProgress = (scored: boolean) => getDb().query(`
        SELECT * FROM goal_progress WHERE goal_id = ? AND created_at BETWEEN ? AND ?
        AND score_before ${scored ? '!=' : '='} score_after
        ORDER BY created_at DESC, id ASC LIMIT ?
      `).all(goal.id, start.getTime(), now, MAX_RECORDS_PER_GOAL + 1) as GoalProgressEntry[];
      const notes = readProgress(false);
      const scores = readProgress(true);
      const checked = todayAvailable ? readOutcomes(goal.id, start.getTime(), now) : { outcomes: [], truncated: false };
      return {
        goalId: goal.id, title: clip(goal.title, 200), level: goal.level, score: goal.score, health: goal.health,
        successCriteria: clip(goal.success_criteria, 1000), updatedAt: goal.updated_at,
        activity: notes.slice(0, MAX_RECORDS_PER_GOAL).map(p => ({
          id: `goal_progress:${p.id}`, goalId: goal.id, note: clip(p.note), source: clip(p.source, 100), type: p.type, observedAt: p.created_at,
        })),
        scoreHistory: scores.slice(0, MAX_RECORDS_PER_GOAL).map(p => ({
          id: `goal_progress:${p.id}`, goalId: goal.id, note: clip(p.note), source: clip(p.source, 100), type: p.type,
          scoreBefore: p.score_before, scoreAfter: p.score_after, recordedAt: p.created_at,
        })),
        verifiedOutcomes: checked.outcomes,
        truncated: checked.truncated || notes.length > MAX_RECORDS_PER_GOAL || scores.length > MAX_RECORDS_PER_GOAL
          || clip(goal.title, 200) !== goal.title || clip(goal.success_criteria, 1000) !== goal.success_criteria
          || [...notes, ...scores].some(p => clip(p.note) !== p.note || clip(p.source, 100) !== p.source),
      };
    }),
  };
  // Trim observations from the largest goal first so one busy goal cannot
  // dominate context. Stable IDs, baselines and truncation markers survive.
  while (JSON.stringify(bundle).length > MAX_REVIEW_BUNDLE_CHARS) {
    const largest = bundle.goals.filter(g => g.activity.length || g.scoreHistory.length || g.verifiedOutcomes.length)
      .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!largest) break;
    if (largest.activity.length) largest.activity.pop();
    else if (largest.scoreHistory.length) largest.scoreHistory.pop();
    else largest.verifiedOutcomes.pop();
    largest.truncated = true;
  }
  return bundle;
}

/** Validate model proposals against the actual input snapshot, never model-supplied evidence. */
export function validateReviewScores(bundle: GoalReviewBundle, proposals: unknown): Pick<GoalReviewRecord, 'rejectedScoreUpdates' | 'proposalsTruncated'> {
  if (proposals == null) return { rejectedScoreUpdates: [], proposalsTruncated: false };
  if (!Array.isArray(proposals)) return { rejectedScoreUpdates: [{ goalId: null, reason: 'invalid_update' }], proposalsTruncated: false };
  const rejectedScoreUpdates = proposals.slice(0, 100).map((proposal): RejectedReviewScore => {
    const goalId = object(proposal) && nonempty(proposal.goalId) && proposal.goalId.length <= 200 ? proposal.goalId : null;
    const reject = (reason: RejectedReviewScore['reason']): RejectedReviewScore => ({ goalId, reason });
    if (!object(proposal) || !goalId || typeof proposal.newScore !== 'number' || !Number.isFinite(proposal.newScore)
      || proposal.newScore < 0 || proposal.newScore > 1 || !nonempty(proposal.reason)) return reject('invalid_update');
    const goal = bundle.goals.find(g => g.goalId === goalId);
    if (!goal) return reject('goal_not_in_bundle');
    const current = getGoal(goalId);
    if (!current || current.status !== 'active' || current.updated_at !== goal.updatedAt || current.score !== goal.score
      || clip(current.success_criteria, 1000) !== goal.successCriteria) return reject('goal_changed');
    if (!Array.isArray(proposal.evidenceIds) || !proposal.evidenceIds.length) return reject('no_evidence');
    const knownIds = new Set([...goal.activity, ...goal.scoreHistory, ...goal.verifiedOutcomes].map(e => e.id));
    if (!proposal.evidenceIds.every(id => typeof id === 'string' && knownIds.has(id))) return reject('evidence_not_in_goal_bundle');
    const evidenceIds = proposal.evidenceIds;
    const outcomes = goal.verifiedOutcomes.filter(o => evidenceIds.includes(o.id));
    if (!outcomes.length) return reject('activity_or_score_history_only');
    if (outcomes.some(o => o.goalProgressId)) return reject('score_already_recorded');
    // C5/C9 must supply a verified measurement and a deterministic mapping to
    // the goal's criteria/baseline before this boundary may authorize a write.
    // A passed or failed qualitative result cannot justify an arbitrary float.
    return reject('no_verified_score_mapping');
  });
  return { rejectedScoreUpdates, proposalsTruncated: proposals.length > 100 };
}

export function saveGoalReviewRecord(checkInId: string, record: GoalReviewRecord): void {
  getDb().query('INSERT INTO goal_review_evidence (check_in_id, record) VALUES (?, ?)').run(checkInId, JSON.stringify(record));
}

export function getGoalReviewRecord(checkInId: string): GoalReviewRecord | null {
  const row = getDb().query('SELECT record FROM goal_review_evidence WHERE check_in_id = ?').get(checkInId) as { record: string } | null;
  return row ? JSON.parse(row.record) as GoalReviewRecord : null;
}
