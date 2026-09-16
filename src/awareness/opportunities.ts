import { getDb, generateId } from '../vault/schema.ts';
import { createSuggestion, findAutomationSuggestion } from '../vault/awareness.ts';
import { findGoals, getGoal } from '../vault/goals.ts';
import { getOpportunityObservations, pruneOpportunityObservations } from '../vault/opportunity-observations.ts';
import { assessJobHypotheses } from './job-hypotheses.ts';
import type { JobHypothesis, Opportunity, OpportunityValidation } from './opportunity-types.ts';
import type { Suggestion } from './types.ts';

export class OpportunityError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Row = {
  suggestion_id: string; hypothesis: string; validation: string | null;
  created_at: number; dismissed: number; acted_on: number;
};

function fromRow(row: Row): Opportunity {
  const validation = row.validation ? JSON.parse(row.validation) as OpportunityValidation : null;
  // Preserve the historical confirmation in feedback, but never expose a stale
  // or inactive goal as a current usable relation.
  if (validation?.goalLink) {
    const goal = getGoal(validation.goalLink.goalId);
    validation.goalLink = goal?.status === 'active' ? { ...validation.goalLink, title: goal.title } : null;
  }
  return {
    id: row.suggestion_id, hypothesis: JSON.parse(row.hypothesis), validation,
    status: row.dismissed ? 'dismissed' : validation ? 'validated' : row.acted_on ? 'interested' : 'proposed',
    createdAt: row.created_at,
  };
}

const SELECT = `SELECT h.*, s.dismissed, s.acted_on FROM opportunity_hypotheses h
  JOIN awareness_suggestions s ON s.id = h.suggestion_id`;

export function getOpportunity(id: string): Opportunity | null {
  const row = getDb().prepare(`${SELECT} WHERE h.suggestion_id = ?`).get(id) as Row | null;
  return row ? fromRow(row) : null;
}

export function listOpportunities(limit = 50): Opportunity[] {
  return (getDb().prepare(`${SELECT} ORDER BY h.created_at DESC, h.suggestion_id LIMIT ?`)
    .all(limit) as Row[]).map(fromRow);
}

export function assessOpportunities(now = Date.now()) {
  const known = getDb().prepare('SELECT pattern_key FROM opportunity_hypotheses').all() as Array<{ pattern_key: string }>;
  return assessJobHypotheses(getOpportunityObservations(now), findGoals({ status: 'active' }),
    new Set(known.map(r => r.pattern_key)), now);
}

export function opportunitySuggestion(hypothesis: JobHypothesis): Suggestion {
  const first = hypothesis.evidence[0]!;
  const last = hypothesis.evidence.at(-1)!;
  const body = `${hypothesis.recurrence.episodes} separate observations across ${hypothesis.recurrence.distinctDays} days mention ${first.cue}. `
    + `Possible output: ${hypothesis.job.proposedOutcome} `
    + `${hypothesis.job.question} These are activity signals, not proof of completed work. Automation feasibility and goal links need confirmation. `
    + `Evidence: ${hypothesis.evidence.slice(0, 3).map(e => `${new Date(e.observedAt).toISOString().slice(0, 10)} in ${e.app}`).join('; ')}.`;
  return { id: '', type: 'automation', title: hypothesis.job.title, body,
    triggerCaptureId: last.captureId, context: { opportunity: hypothesis } };
}

/** Called only for a selected candidate, after higher-priority suggestions and rate limits. */
export function publishOpportunity(hypothesis: JobHypothesis): Suggestion | null {
  const db = getDb();
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM opportunity_hypotheses WHERE pattern_key = ?').get(hypothesis.patternKey)) return null;
    const candidate = opportunitySuggestion(hypothesis);
    // createSuggestion dedupes on the durable automation identity and returns a
    // pre-existing row rather than inserting. A proposal must own a fresh
    // suggestion: the hypothesis and delivery rows are keyed on its ID, and the
    // notification body comes from that row. Reusing an older one would publish
    // its stale text, or attach this proposal to a row the delivery query skips.
    if (findAutomationSuggestion(candidate)) return null;
    const suggestion = createSuggestion(candidate);
    db.prepare(`INSERT INTO opportunity_hypotheses
      (suggestion_id, pattern_key, hypothesis, created_at) VALUES (?, ?, ?, ?)`)
      .run(suggestion.id, hypothesis.patternKey, JSON.stringify(hypothesis), suggestion.created_at);
    db.prepare('INSERT INTO opportunity_delivery (opportunity_id) VALUES (?)').run(suggestion.id);
    return { ...candidate, id: suggestion.id };
  }).immediate();
}

export function refreshOpportunity(): Suggestion | null {
  pruneOpportunityObservations();
  const candidate = assessOpportunities().proposals[0];
  return candidate ? publishOpportunity(candidate) : null;
}

type Feedback = { requestId: string } & (
  | { kind: 'validate'; job: string; expectedOutcome: string; goalId: string | null; goalReason: string | null }
  | { kind: 'dismiss'; reason: string }
  | { kind: 'outcome'; workRef: string; performedAt: number; useful: boolean; note: string }
);

function text(value: unknown, field: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new OpportunityError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function parseFeedback(input: unknown): Feedback {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OpportunityError('Expected a feedback object');
  const data = input as Record<string, unknown>;
  const requestId = text(data.requestId, 'requestId', 100);
  let parsed: Feedback;
  if (data.kind === 'validate') {
    const goalId = data.goalId === undefined || data.goalId === null ? null : text(data.goalId, 'goalId', 100);
    parsed = { requestId, kind: 'validate', job: text(data.job, 'job', 300),
      expectedOutcome: text(data.expectedOutcome, 'expectedOutcome'), goalId,
      goalReason: goalId ? text(data.goalReason, 'goalReason') : null };
    if (!goalId && data.goalReason != null) throw new OpportunityError('goalReason requires goalId');
  } else if (data.kind === 'dismiss') {
    parsed = { requestId, kind: 'dismiss', reason: text(data.reason, 'reason') };
  } else if (data.kind === 'outcome') {
    if (typeof data.useful !== 'boolean' || typeof data.performedAt !== 'number'
      || !Number.isSafeInteger(data.performedAt)) throw new OpportunityError('useful must be boolean and performedAt an epoch millisecond integer');
    parsed = { requestId, kind: 'outcome', workRef: text(data.workRef, 'workRef', 500),
      performedAt: data.performedAt, useful: data.useful, note: text(data.note, 'note') };
  } else throw new OpportunityError('Unknown feedback kind');
  if (Object.keys(data).some(key => !Object.hasOwn(parsed, key))) throw new OpportunityError('Unknown feedback field');
  return parsed;
}

/** No workflow, goal score or progress writes. C7 acceptance and checked results are separate. */
export function recordOpportunityFeedback(id: string, input: unknown) {
  const feedback = parseFeedback(input);
  const payload = JSON.stringify(feedback);
  const db = getDb();
  return db.transaction(() => {
    const opportunity = getOpportunity(id);
    if (!opportunity) throw new OpportunityError('Opportunity not found', 404);
    const prior = db.prepare(`SELECT id, payload FROM opportunity_feedback WHERE opportunity_id = ? AND request_id = ?`)
      .get(id, feedback.requestId) as { id: string; payload: string } | null;
    if (prior) {
      if (prior.payload !== payload) throw new OpportunityError('requestId already used with different feedback', 409);
      return { feedbackId: prior.id, opportunity };
    }
    const now = Date.now();
    const feedbackId = generateId();
    if (feedback.kind === 'validate') {
      if (opportunity.status === 'dismissed' || opportunity.validation) throw new OpportunityError('Opportunity is already resolved', 409);
      const goal = feedback.goalId ? getGoal(feedback.goalId) : null;
      if (feedback.goalId && goal?.status !== 'active') throw new OpportunityError('goalId must identify an active goal');
      const validation: OpportunityValidation = {
        feedbackId, job: feedback.job, expectedOutcome: feedback.expectedOutcome,
        goalLink: goal ? { goalId: goal.id, title: goal.title, reason: feedback.goalReason!, basis: 'user_confirmed' } : null,
        confirmedAt: now,
      };
      db.prepare('UPDATE opportunity_hypotheses SET validation = ? WHERE suggestion_id = ?').run(JSON.stringify(validation), id);
    } else if (feedback.kind === 'dismiss') {
      db.prepare('UPDATE awareness_suggestions SET dismissed = 1 WHERE id = ?').run(id);
    } else {
      if (!opportunity.validation || opportunity.status === 'dismissed') throw new OpportunityError('Confirm the recurring job before reporting outcomes', 409);
      if (feedback.performedAt < opportunity.validation.confirmedAt || feedback.performedAt > now) {
        throw new OpportunityError('performedAt must be between job confirmation and now');
      }
      if (db.prepare('SELECT 1 FROM opportunity_feedback WHERE opportunity_id = ? AND work_ref = ?').get(id, feedback.workRef)) {
        throw new OpportunityError('An outcome for this workRef is already recorded', 409);
      }
    }
    db.prepare(`INSERT INTO opportunity_feedback (id, opportunity_id, request_id, kind, payload, work_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(feedbackId, id, feedback.requestId, feedback.kind, payload, feedback.kind === 'outcome' ? feedback.workRef : null, now);
    return { feedbackId, opportunity: getOpportunity(id)! };
  }).immediate();
}

export function getOpportunityFeedback(id: string) {
  if (!getOpportunity(id)) throw new OpportunityError('Opportunity not found', 404);
  const rows = getDb().prepare(`SELECT id, kind, payload, created_at FROM opportunity_feedback
    WHERE opportunity_id = ? ORDER BY created_at, rowid`).all(id) as Array<{ id: string; kind: string; payload: string; created_at: number }>;
  return rows.map(r => ({ id: r.id, kind: r.kind, data: JSON.parse(r.payload), createdAt: r.created_at, source: 'user_report' }));
}

export function getOpportunityMetrics() {
  const db = getDb();
  const counts = db.prepare(`SELECT COUNT(*) AS proposed,
    COALESCE(SUM(d.delivered_at IS NOT NULL), 0) AS delivered, COALESCE(SUM(s.acted_on), 0) AS interested,
    COALESCE(SUM(s.dismissed), 0) AS dismissed,
    COALESCE(SUM(h.validation IS NOT NULL), 0) AS validated
    FROM opportunity_hypotheses h JOIN awareness_suggestions s ON s.id = h.suggestion_id
    LEFT JOIN opportunity_delivery d ON d.opportunity_id = h.suggestion_id`).get() as
      Record<'proposed' | 'delivered' | 'interested' | 'dismissed' | 'validated', number>;
  const outcomes = db.prepare(`SELECT opportunity_id, payload FROM opportunity_feedback WHERE kind = 'outcome'`)
    .all() as Array<{ opportunity_id: string; payload: string }>;
  const perOpportunity = new Map<string, number>();
  let useful = 0;
  for (const row of outcomes) {
    const outcome = JSON.parse(row.payload) as Extract<Feedback, { kind: 'outcome' }>;
    if (outcome.useful) useful++;
    perOpportunity.set(row.opportunity_id, (perOpportunity.get(row.opportunity_id) ?? 0) + 1);
  }
  return {
    ...counts, outcomeReports: outcomes.length, usefulReports: useful,
    notUsefulReports: outcomes.length - useful,
    opportunitiesWithOutcomes: perOpportunity.size,
    validatedWithoutOutcomes: counts.validated! - perOpportunity.size,
    recurringJobsWithOutcomes: [...perOpportunity.values()].filter(n => n >= 2).length,
    usefulReportRate: outcomes.length ? useful / outcomes.length : null,
    evidenceBasis: 'user_report', verifiedResults: 0,
  };
}
