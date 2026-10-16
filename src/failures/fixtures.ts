/**
 * Q-19 diagnosis fixtures: one canonical failure for each category the card
 * names, and the timeouts that must never read as "nothing happened". Each
 * fixture is typed evidence plus the reading every surface must give it.
 * Tests run them through `projectFailure`; they double as the reference for
 * what each kind of failure says.
 */
import type { FailureCategory, FailureEffect, FailureEvidence, FailureSubject, RecoveryStep } from './projection';

export interface DiagnosisFixture {
  name: string;
  evidence: FailureEvidence;
  subject: FailureSubject;
  expect: { category: FailureCategory; effect: FailureEffect; next: RecoveryStep[] };
}

const step: FailureSubject = { label: 'The workflow step "Send invoice"', sideEffects: true };
const chat: FailureSubject = { label: 'Your request', sideEffects: false };
const message: FailureSubject = { label: 'The message', sideEffects: true };

export const DIAGNOSIS_FIXTURES: DiagnosisFixture[] = [
  { name: 'validation: a step input of the wrong type',
    evidence: { source: 'readiness', issues: [{ code: 'INPUT_TYPE', message: 'amount must be a number' }] },
    subject: step, expect: { category: 'invalid_input', effect: 'none', next: ['edit_and_run_again', 'open_details'] } },
  { name: 'missing binding: a Gmail connection that is not connected',
    evidence: { source: 'readiness', issues: [{ code: 'CONNECTION_BINDING', message: 'gmail is not connected' }] },
    subject: step, expect: { category: 'missing_binding', effect: 'none', next: ['connect', 'open_details'] } },
  { name: 'missing binding: the bound computer changed session',
    evidence: { source: 'action', outcome: { status: 'blocked', code: 'WORKFLOW_SESSION_CHANGED', message: 'session changed', effect: 'not_started' } },
    subject: step, expect: { category: 'missing_binding', effect: 'none', next: ['connect', 'open_details'] } },
  { name: 'provider limit: the plan quota is used up',
    evidence: { source: 'provider', code: 'quota_exhausted', message: 'quota exhausted for this window' },
    subject: chat, expect: { category: 'provider_limit', effect: 'none', next: ['wait_or_switch_model', 'open_details'] } },
  { name: 'provider limit: rate limited',
    evidence: { source: 'provider', code: 'rate_limit', message: '429 Too Many Requests' },
    subject: chat, expect: { category: 'provider_limit', effect: 'none', next: ['wait_or_switch_model', 'open_details'] } },
  { name: 'offline target: the bound computer is offline',
    evidence: { source: 'action', outcome: { status: 'blocked', code: 'WORKFLOW_MACHINE_OFFLINE', message: 'Bound computer mac-1 is offline', effect: 'not_started' } },
    subject: step, expect: { category: 'target_offline', effect: 'none', next: ['bring_online', 'open_details'] } },
  { name: 'denied approval',
    evidence: { source: 'action', outcome: { status: 'blocked', code: 'APPROVAL_DENIED', message: 'Workflow approval denied; effect was not executed', effect: 'not_started' } },
    subject: step, expect: { category: 'approval_denied', effect: 'none', next: ['ask_again', 'open_details'] } },
  { name: 'expired approval',
    evidence: { source: 'action', outcome: { status: 'blocked', code: 'APPROVAL_EXPIRED', message: 'Workflow approval expired; effect was not executed', effect: 'not_started' } },
    subject: step, expect: { category: 'approval_denied', effect: 'none', next: ['ask_again', 'open_details'] } },
  { name: 'uncertain effect: the sidecar timed out after dispatch',
    evidence: { source: 'action', outcome: { status: 'unknown', code: 'SIDECAR_TIMEOUT', message: 'timed out after 30000ms', effect: 'may_have_occurred' } },
    subject: step, expect: { category: 'uncertain_effect', effect: 'unknown', next: ['check_before_running_again', 'open_details'] } },
  { name: 'uncertain effect: an error after a partial effect, whatever its code says',
    evidence: { source: 'action', outcome: { status: 'error', code: 'WORKFLOW_MACHINE_OFFLINE', message: 'connection dropped', effect: 'may_have_occurred' } },
    subject: step, expect: { category: 'uncertain_effect', effect: 'unknown', next: ['check_before_running_again', 'open_details'] } },
  { name: 'timeout: a model call that timed out changed nothing',
    evidence: { source: 'provider', code: 'network', message: 'Request timed out' },
    subject: chat, expect: { category: 'target_offline', effect: 'none', next: ['run_again', 'open_details'] } },
  { name: 'timeout: a send that timed out may have arrived',
    evidence: { source: 'delivery', channels: [{ channel: 'telegram', result: 'unknown', error: 'timed out after 30s' }] },
    subject: message, expect: { category: 'uncertain_effect', effect: 'unknown', next: ['check_before_resending', 'open_details'] } },
  { name: 'delivery: sent on one channel, failed on another',
    evidence: { source: 'delivery', channels: [{ channel: 'telegram', result: 'delivered' }, { channel: 'discord', result: 'failed', error: '401' }] },
    subject: message, expect: { category: 'delivery_failed', effect: 'partial', next: ['resend', 'open_details'] } },
  { name: 'delivery: failed everywhere',
    evidence: { source: 'delivery', channels: [{ channel: 'telegram', result: 'failed', error: '401' }] },
    subject: message, expect: { category: 'delivery_failed', effect: 'none', next: ['resend', 'open_details'] } },
  { name: 'cancellation after the run had started',
    evidence: { source: 'cancellation', dispatched: true },
    subject: step, expect: { category: 'cancelled', effect: 'unknown', next: ['check_before_running_again', 'open_details'] } },
  { name: 'untyped failure of work with side effects',
    evidence: { source: 'unknown', message: 'Error: socket hang up' },
    subject: step, expect: { category: 'internal', effect: 'unknown', next: ['check_before_running_again', 'open_details'] } },
  { name: 'untyped failure of a chat reply',
    evidence: { source: 'unknown', message: 'Error: unexpected end of stream' },
    subject: chat, expect: { category: 'internal', effect: 'none', next: ['run_again', 'open_details'] } },
];
