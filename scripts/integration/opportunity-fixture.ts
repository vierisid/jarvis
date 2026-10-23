import { createGoal } from '../../src/vault/goals';
import { createSuggestion } from '../../src/vault/awareness';
import { getDb } from '../../src/vault/schema';
/** Synthetic observations in the dedicated integration database only. */
export function seedOpportunity(key = 'local-browser', confirmed = true, linked = true) {
  const goal = createGoal(`Review invoices ${key}`, 'objective', { status: 'active' });
  const hypothesis = { schemaVersion: 1, assessedAt: Date.now(), patternKey: `job-v1:invoice_review:${key}`, kind: 'invoice_review',
    job: { title: 'Review invoices', proposedOutcome: 'A checked list of unpaid invoices and draft follow-ups for approval.', question: 'Confirm the job?' },
    evidence: [{ captureId: `capture-${key}`, observedAt: 1, app: 'Mail', kind: 'invoice_review', cue: 'unpaid invoices' }],
    recurrence: { episodes: 3, distinctDays: 2, firstObservedAt: 1, lastObservedAt: 3, windowDays: 14, basis: 'observed_activity' },
    goalCandidates: [], feasibility: { status: 'unverified', requiredChecks: [], reason: 'Not checked' }, uncertainty: [],
  };
  const suggestion = createSuggestion({ type: 'automation', title: hypothesis.job.title, body: 'Observed invoice review', context: { opportunity: hypothesis } });
  const validation = confirmed ? { feedbackId: 'confirmed', job: hypothesis.job.title, expectedOutcome: hypothesis.job.proposedOutcome,
    goalLink: linked ? { goalId: goal.id, title: goal.title, reason: 'These invoices support this goal', basis: 'user_confirmed' } : null, confirmedAt: Date.now() } : null;
  getDb().run('INSERT INTO opportunity_hypotheses (suggestion_id, pattern_key, hypothesis, validation, created_at) VALUES (?, ?, ?, ?, ?)',
    [suggestion.id, hypothesis.patternKey, JSON.stringify(hypothesis), validation ? JSON.stringify(validation) : null, Date.now()]);
  return suggestion.id;
}
