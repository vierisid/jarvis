import { getDb, generateId } from '../vault/schema.ts';
import { suggestionContext } from '../vault/suggestion-schema.ts';
import { getGoal } from '../vault/goals.ts';
import type { SuggestionRow } from './types.ts';

export class SuggestionFeedbackError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type CompositionRequest = {
  name: string; description: string; expectedOutcome: string;
  goalLink: { goalId: string; title: string; reason: string; basis: 'user_confirmed' } | null;
  observations: Array<{ captureId: string; observedAt?: number; app?: string; cue?: string }>;
};
export type CompositionRow = {
  id: string; suggestion_id: string; feedback_id: string; request: string;
  state: 'queued' | 'running' | 'failed' | 'draft_ready'; attempts: number;
  lease_token: string | null; lease_until: number; error: string | null;
  flow_id: string | null; version_id: string | null; created_at: number; updated_at: number;
};

export function canonicalSuggestion(id: string): SuggestionRow {
  const db = getDb();
  const row = db.query<SuggestionRow, [string]>('SELECT * FROM awareness_suggestions WHERE id = ?').get(id);
  if (!row) throw new SuggestionFeedbackError('Suggestion not found', 404);
  const identity = db.query<{ pattern_key: string }, [string]>('SELECT pattern_key FROM suggestion_identities WHERE suggestion_id = ?').get(id);
  if (!identity) return row;
  const family = db.query<SuggestionRow, [string]>(`SELECT s.* FROM awareness_suggestions s
    JOIN suggestion_identities i ON i.suggestion_id = s.id WHERE i.pattern_key = ? ORDER BY s.created_at, s.id`).all(identity.pattern_key);
  const canonical = family[0]!;
  return { ...canonical, dismissed: family.some(r => r.dismissed) ? 1 : 0, acted_on: family.some(r => r.acted_on) ? 1 : 0 };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SuggestionFeedbackError('Expected a JSON object');
  return input as Record<string, unknown>;
}
function text(input: unknown, field: string, max = 1000): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max) {
    throw new SuggestionFeedbackError(`${field} must be non-empty text of at most ${max} characters`);
  }
  return input.trim();
}
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new SuggestionFeedbackError('Unknown feedback field');
}

function feedback(id: string, requestId: string, kind: string, reason: string, payload: string): string {
  const db = getDb();
  const existing = db.query<{ id: string; kind: string; reason: string; payload: string }, [string, string]>(
    'SELECT * FROM suggestion_feedback WHERE suggestion_id = ? AND request_id = ?').get(id, requestId);
  if (existing) {
    if (existing.kind !== kind || existing.reason !== reason || existing.payload !== payload) {
      throw new SuggestionFeedbackError('requestId already used for different feedback', 409);
    }
    return existing.id;
  }
  const feedbackId = generateId();
  db.run('INSERT INTO suggestion_feedback VALUES (?, ?, ?, ?, ?, ?, ?)',
    [feedbackId, id, requestId, kind, reason, payload, Date.now()]);
  return feedbackId;
}

function setFlag(id: string, flag: 'dismissed' | 'acted_on') {
  getDb().run(`UPDATE awareness_suggestions SET ${flag} = 1 WHERE id = ? OR id IN (
    SELECT suggestion_id FROM suggestion_identities WHERE pattern_key = (
      SELECT pattern_key FROM suggestion_identities WHERE suggestion_id = ?))`, [id, id]);
}

/** An interest signal is not acceptance or authority to compose/run. */
export function recordSuggestionDecision(id: string, kind: 'dismiss' | 'interest', input: unknown) {
  const data = object(input);
  fields(data, ['requestId', 'reason']);
  const requestId = text(data.requestId, 'requestId', 100);
  const reason = text(data.reason, 'reason');
  return getDb().transaction(() => {
    const row = canonicalSuggestion(id);
    if (kind === 'dismiss' && getCompositionRow(row.id)) {
      throw new SuggestionFeedbackError('This suggestion already has a composition request; inspect its status', 409);
    }
    feedback(row.id, requestId, kind, reason, '{}');
    setFlag(row.id, kind === 'dismiss' ? 'dismissed' : 'acted_on');
    return getSuggestionLearning(row.id);
  }).immediate();
}

export function getCompositionRow(suggestionId: string): CompositionRow | null {
  return getDb().query<CompositionRow, [string]>('SELECT * FROM suggestion_composition_jobs WHERE suggestion_id = ?').get(suggestionId);
}

function observations(row: SuggestionRow): CompositionRequest['observations'] {
  const opportunity = suggestionContext(row.context).opportunity as { evidence?: unknown } | undefined;
  const evidence = opportunity?.evidence;
  if (Array.isArray(evidence)) {
    return evidence.slice(0, 100).flatMap(e => {
      if (!e || typeof e.captureId !== 'string') return [];
      return [{ captureId: e.captureId, ...(Number.isSafeInteger(e.observedAt) ? { observedAt: e.observedAt as number } : {}),
        ...(typeof e.app === 'string' ? { app: e.app.slice(0, 200) } : {}),
        ...(typeof e.cue === 'string' ? { cue: e.cue.slice(0, 200) } : {}) }];
    });
  }
  return row.trigger_capture_id ? [{ captureId: row.trigger_capture_id }] : [];
}

export function acceptSuggestion(id: string, input: unknown) {
  const data = object(input);
  fields(data, ['requestId', 'reason', 'name', 'description', 'expectedOutcome', 'goalId', 'goalReason']);
  const requestId = text(data.requestId, 'requestId', 100);
  const reason = text(data.reason, 'reason');
  const goalId = data.goalId == null ? null : text(data.goalId, 'goalId', 100);
  if (!goalId && data.goalReason != null) throw new SuggestionFeedbackError('goalReason requires goalId');
  const supplied = { name: text(data.name, 'name', 200), description: text(data.description, 'description', 4000),
    expectedOutcome: text(data.expectedOutcome, 'expectedOutcome'), goalId,
    goalReason: goalId ? text(data.goalReason, 'goalReason') : null };
  const payload = JSON.stringify(supplied);
  return getDb().transaction(() => {
    const row = canonicalSuggestion(id);
    if (row.type !== 'automation') throw new SuggestionFeedbackError('Only automation suggestions can create workflow drafts');
    const existing = getCompositionRow(row.id);
    if (existing) {
      const original = getDb().query<{ payload: string; reason: string }, [string]>(
        'SELECT payload, reason FROM suggestion_feedback WHERE id = ?').get(existing.feedback_id)!;
      if (original.payload !== payload || original.reason !== reason) throw new SuggestionFeedbackError('Acceptance is already recorded with different details', 409);
      feedback(row.id, requestId, 'accept', reason, payload);
      return getSuggestionLearning(row.id);
    }
    if (row.dismissed) throw new SuggestionFeedbackError('Suggestion was dismissed', 409);
    const goal = goalId ? getGoal(goalId) : null;
    if (goalId && goal?.status !== 'active') throw new SuggestionFeedbackError('Goal must exist and be active');
    const request: CompositionRequest = {
      name: supplied.name, description: supplied.description, expectedOutcome: supplied.expectedOutcome,
      goalLink: goal ? { goalId: goal.id, title: goal.title, reason: supplied.goalReason!, basis: 'user_confirmed' } : null,
      observations: observations(row),
    };
    const feedbackId = feedback(row.id, requestId, 'accept', reason, payload);
    const now = Date.now();
    getDb().run(`INSERT INTO suggestion_composition_jobs
      (id, suggestion_id, feedback_id, request, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      [generateId(), row.id, feedbackId, JSON.stringify(request), now, now]);
    setFlag(row.id, 'acted_on');
    return getSuggestionLearning(row.id);
  }).immediate();
}

export function retrySuggestionComposition(id: string, input: unknown) {
  const data = object(input);
  fields(data, ['requestId', 'reason']);
  const requestId = text(data.requestId, 'requestId', 100);
  const reason = text(data.reason, 'reason');
  return getDb().transaction(() => {
    const row = canonicalSuggestion(id);
    const job = getCompositionRow(row.id);
    if (!job) throw new SuggestionFeedbackError('No composition request exists', 409);
    const prior = getDb().query('SELECT id FROM suggestion_feedback WHERE suggestion_id = ? AND request_id = ?').get(row.id, requestId);
    if (prior) {
      feedback(row.id, requestId, 'retry', reason, '{}');
      return getSuggestionLearning(row.id);
    }
    if (row.dismissed) throw new SuggestionFeedbackError('Suggestion was dismissed', 409);
    if (job.state !== 'failed') throw new SuggestionFeedbackError('Only failed composition requests can be retried', 409);
    feedback(row.id, requestId, 'retry', reason, '{}');
    getDb().run(`UPDATE suggestion_composition_jobs SET state = 'queued', error = NULL,
      lease_token = NULL, lease_until = 0, updated_at = ? WHERE id = ?`, [Date.now(), job.id]);
    return getSuggestionLearning(row.id);
  }).immediate();
}

export function getSuggestionLearning(id: string) {
  const row = canonicalSuggestion(id);
  const job = getCompositionRow(row.id);
  const request = job ? JSON.parse(job.request) as CompositionRequest : null;
  const goal = request?.goalLink ? getGoal(request.goalLink.goalId) : null;
  // Retain the accepted snapshot in history, but expose current goal availability separately.
  return {
    opportunityId: row.id, type: row.type, title: row.title, body: row.body,
    status: row.dismissed ? 'dismissed' : job ? 'accepted' : row.acted_on ? 'interested' : 'proposed',
    observations: request?.observations ?? observations(row),
    goalLink: goal?.status === 'active' ? { ...request!.goalLink!, title: goal.title } : null,
    feedback: getDb().query<{ id: string; kind: string; reason: string; created_at: number }, [string]>(
      'SELECT id, kind, reason, created_at FROM suggestion_feedback WHERE suggestion_id = ? ORDER BY created_at, rowid').all(row.id),
    composition: job ? {
      id: job.id, state: job.state, attempts: job.attempts, error: job.error,
      request: request!, workflowId: job.flow_id, workflowVersionId: job.version_id,
      draftAvailable: job.flow_id ? !!getDb().query(`SELECT 1 FROM flow f JOIN flow_version v ON v.flow_id = f.id
        WHERE f.id = ? AND v.id = ?`).get(job.flow_id, job.version_id) : null,
      createdAt: job.created_at, updatedAt: job.updated_at,
    } : null,
  };
}

/** Pending/failed work is discoverable even after its original tip has disappeared. */
export function listSuggestionCompositions(offset = 0) {
  return getDb().query<{ suggestion_id: string }, [number]>(
    'SELECT suggestion_id FROM suggestion_composition_jobs ORDER BY created_at DESC, id LIMIT 100 OFFSET ?').all(offset)
    .map(row => getSuggestionLearning(row.suggestion_id));
}
