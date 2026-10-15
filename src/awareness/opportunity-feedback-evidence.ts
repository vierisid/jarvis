import { getDb } from '../vault/schema.ts';
import { suggestionContext } from '../vault/suggestion-schema.ts';
import { hypothesisRoutineKey, parseRoutineKey } from './routine-identity.ts';
import type { JobKind } from './opportunity-types.ts';

export type FeedbackEvidence = {
  ref: string;
  source: 'awareness_suggestions' | 'opportunity_delivery' | 'opportunity_feedback' | 'suggestion_feedback' | 'prepared_opportunities';
  opportunityId: string; routineKey: string; kind: JobKind;
  event: 'proposal' | 'delivery' | 'interest' | 'accept' | 'validate' | 'dismiss' | 'outcome';
  at: number | null; reason?: string; workRef?: string; useful?: boolean;
};
export type FeedbackSnapshot = { evidence: FeedbackEvidence[]; invalidOutcomeRecords: number };

const timestamp = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

/** Read canonical records; acceptance, delivery and flags never become outcome reports. */
export function readOpportunityFeedbackEvidence(): FeedbackSnapshot {
  const db = getDb();
  const rows = db.query(`SELECT s.id, s.context, s.created_at, s.dismissed, s.acted_on,
      i.pattern_key, h.hypothesis, d.delivered_at
    FROM awareness_suggestions s LEFT JOIN suggestion_identities i ON i.suggestion_id = s.id
    LEFT JOIN opportunity_hypotheses h ON h.suggestion_id = s.id
    LEFT JOIN opportunity_delivery d ON d.opportunity_id = s.id WHERE s.type = 'automation'`).all() as Array<{
      id: string; context: string | null; created_at: number; dismissed: number; acted_on: number;
      pattern_key: string | null; hypothesis: string | null; delivered_at: number | null;
    }>;
  const identities = new Map<string, { key: string; kind: JobKind }>();
  const evidence: FeedbackEvidence[] = [];
  for (const row of rows) {
    const h = row.hypothesis ? suggestionContext(row.hypothesis) : suggestionContext(row.context).opportunity;
    const identity = parseRoutineKey(hypothesisRoutineKey(h) ?? row.pattern_key ?? '');
    if (!identity) continue;
    identities.set(row.id, identity);
    const base = { opportunityId: row.id, routineKey: identity.key, kind: identity.kind };
    evidence.push({ ...base, ref: `awareness_suggestions:${row.id}`, source: 'awareness_suggestions', event: 'proposal', at: timestamp(row.created_at) });
    if (row.delivered_at !== null) evidence.push({ ...base, ref: `opportunity_delivery:${row.id}`, source: 'opportunity_delivery', event: 'delivery', at: timestamp(row.delivered_at) });
    // Old flags establish a decision, but do not establish when it happened.
    if (row.dismissed) evidence.push({ ...base, ref: `awareness_suggestions:${row.id}:dismissed`, source: 'awareness_suggestions', event: 'dismiss', at: null });
    if (row.acted_on) evidence.push({ ...base, ref: `awareness_suggestions:${row.id}:acted_on`, source: 'awareness_suggestions', event: 'interest', at: null });
  }
  let invalidOutcomeRecords = 0;
  for (const source of ['opportunity_feedback', 'suggestion_feedback'] as const) {
    const records = db.query(source === 'opportunity_feedback'
      ? 'SELECT id, opportunity_id AS opportunityId, kind, payload, created_at FROM opportunity_feedback ORDER BY created_at, id'
      : 'SELECT id, suggestion_id AS opportunityId, kind, reason, payload, created_at FROM suggestion_feedback ORDER BY created_at, id').all() as Array<{
        id: string; opportunityId: string; kind: string; reason?: string; payload: string; created_at: number;
      }>;
    for (const row of records) {
      const identity = identities.get(row.opportunityId);
      if (!identity || row.kind === 'retry') continue;
      const payload = suggestionContext(row.payload);
      const event = row.kind as FeedbackEvidence['event'];
      if (!['dismiss', 'interest', 'accept', 'validate', 'outcome'].includes(event)) continue;
      if (event === 'outcome' && (typeof payload.useful !== 'boolean' || typeof payload.workRef !== 'string'
        || !payload.workRef.trim() || timestamp(payload.performedAt) === null
        || Number(payload.performedAt) > row.created_at || timestamp(row.created_at) === null)) {
        invalidOutcomeRecords++; continue;
      }
      const reason = source === 'suggestion_feedback' ? row.reason : payload.reason ?? payload.note;
      evidence.push({ ref: `${source}:${row.id}`, source, opportunityId: row.opportunityId,
        routineKey: identity.key, kind: identity.kind, event, at: timestamp(row.created_at),
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(event === 'outcome' ? { workRef: payload.workRef as string, useful: payload.useful as boolean } : {}) });
    }
  }
  // Optional F-09/F-10 storage is a read-only integration, not a compile-time or
  // activation dependency. Its acceptance also remains distinct from usefulness.
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prepared_opportunities'").get()) {
    const prepared = db.query('SELECT id, opportunity_id, dismissed_at, accepted_at FROM prepared_opportunities').all() as Array<{
      id: string; opportunity_id: string; dismissed_at: number | null; accepted_at: number | null;
    }>;
    for (const row of prepared) {
      const identity = identities.get(row.opportunity_id);
      if (!identity) continue;
      for (const [event, at] of [['dismiss', row.dismissed_at], ['accept', row.accepted_at]] as const) {
        if (at === null) continue;
        evidence.push({ ref: `prepared_opportunities:${row.id}:${event}`, source: 'prepared_opportunities',
          opportunityId: row.opportunity_id, routineKey: identity.key, kind: identity.kind, event, at: timestamp(at) });
      }
    }
  }
  return { evidence, invalidOutcomeRecords };
}
