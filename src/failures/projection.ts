/**
 * Q-19: one typed projection from a failure to what a person reads. Runs,
 * chat, Today and delivery all show a failure through it, so the same failure
 * reads the same everywhere: what happened, what did and did not take effect,
 * and what the person can safely do next.
 *
 * Classification reads typed evidence only (an action outcome's status, effect
 * and code, a readiness issue's code, a provider error code, a cancellation,
 * a delivery result), never the wording of a message. An approval decision
 * arrives as an action outcome (APPROVAL_DENIED and the like). Wording is kept,
 * redacted and bounded, as the technical detail behind it. When the evidence
 * cannot say whether something took effect, the projection says it may have:
 * it never claims that nothing happened without evidence that nothing did.
 *
 * Recovery is advice for the person: every step is something they start
 * themselves. Nothing here runs, retries or resends anything.
 */
import { createHash } from 'node:crypto';
import type { ActionFailure } from '../actions/action-outcome';
import type { LLMErrorCode } from '../llm/provider';
import { redactSecrets } from '../util/redact';
import { boundedReceiptText } from '../roles/untrusted';

export type FailureCategory =
  /** The input or definition is not valid; fixing it is the person's call. */
  | 'invalid_input'
  /** A connection, account, computer, tool or other binding is missing or changed. */
  | 'missing_binding'
  /** A provider's quota, rate, plan, model or policy limit refused the request. */
  | 'provider_limit'
  /** The computer, service or provider it needed could not be reached. */
  | 'target_offline'
  /** An approval was denied, expired or withdrawn, or Authority does not allow it. */
  | 'approval_denied'
  /** It may or may not have taken effect. */
  | 'uncertain_effect'
  /** It stopped before doing anything, for a reason with no category of its own. */
  | 'not_started'
  /** Jarvis held back its own background AI work to stay within its resource limits. Not a provider failure. */
  | 'resource_paused'
  | 'cancelled'
  /** A message was not sent on any channel, or only on some. */
  | 'delivery_failed'
  /** Untyped evidence. Its detail is kept; nothing is guessed from its wording. */
  | 'internal';

/** What took effect: the part a person must never have to guess. */
export type FailureEffect = 'none' | 'unknown' | 'partial';

/** A safe next step the person starts themselves. */
export type RecoveryStep =
  | 'edit_and_run_again' | 'connect' | 'wait_or_switch_model' | 'bring_online' | 'ask_again' | 'review_authority'
  | 'check_before_running_again' | 'check_earlier_steps' | 'run_again' | 'resend' | 'check_before_resending' | 'open_details'
  | 'wait_and_run_again' | 'run_again_when_resumed' | 'accept_binding_change' | 'update_recipient' | 'update_desktop_app';

export interface FailureLinks {
  runId?: string; flowId?: string; stepName?: string; effectId?: string;
  approvalId?: string; taskId?: string; channel?: string;
  /** A chat turn's request id. */
  requestId?: string;
}

export interface UserFailure {
  category: FailureCategory;
  effect: FailureEffect;
  /** What happened, one sentence. */
  headline: string;
  /** What did and did not take effect, one sentence. */
  outcome: string;
  next: Array<{ step: RecoveryStep; label: string }>;
  links: FailureLinks;
  /** The typed code it was classified from, when there was one. */
  code: string | null;
  /** The original evidence, credentials redacted and bounded; shown behind detail. */
  detail: string;
  /** Stable identity of this failure, for one interruption per failure. */
  key: string;
}

/** What was being done, so the sentence can name it, and whether it can have side effects. */
export interface FailureSubject {
  /** "The workflow step \"Send email\"", "Your request", "The message to Telegram". */
  label: string;
  /** Whether the work could change anything outside Jarvis. Untyped failures of such work may have taken effect. */
  sideEffects: boolean;
}

export type DeliveryResult = 'delivered' | 'failed' | 'unknown';

export type FailureEvidence =
  | { source: 'action'; outcome: ActionFailure }
  | { source: 'readiness'; issues: Array<{ code: string; message?: string }> }
  | { source: 'provider'; code: LLMErrorCode; message?: string; retryAfterMs?: number }
  | { source: 'cancellation'; dispatched: boolean; message?: string }
  | { source: 'delivery'; channels: Array<{ channel: string; result: DeliveryResult; error?: string }> }
  | { source: 'unknown'; message: string };

const DETAIL_MAX = 1200;

/** Action codes whose meaning is a missing or changed binding: a computer, a session, a capability, a target. */
const BINDING_CODES = new Set([
  'WORKFLOW_TARGET_AMBIGUOUS', 'WORKFLOW_RETARGET_REQUIRED', 'WORKFLOW_SESSION_CHANGED', 'WORKFLOW_CAPABILITY_UNAVAILABLE',
  'WORKFLOW_BINDING_IDENTITY', 'WORKFLOW_BINDING_LEGACY', 'WORKFLOW_SAMPLE_BINDING_UNKNOWN', 'METHOD_NOT_FOUND',
  'DESKTOP_ACTION_UNSUPPORTED', 'SKILL_NOT_FOUND', 'FLOW_NOT_FOUND', 'VERSION_MISSING',
]);
/** Action codes whose meaning is an unreachable computer or local runtime. */
const OFFLINE_CODES = new Set(['WORKFLOW_MACHINE_OFFLINE', 'WORKFLOW_MACHINE_UNAVAILABLE', 'SIDECAR_OFFLINE', 'OFFLINE', 'SKILL_NO_SIDECAR', 'LOCAL_TOOLS_DISABLED',
  'LOCAL_DESKTOP_UNAVAILABLE']);
/**
 * Refusals whose cause and fix are specific enough to name: a binding pinned
 * when the workflow was enabled that no longer holds (Q-05), or a desktop app
 * too old for a reviewed action (Q-09). Each refused before anything ran.
 */
const NAMED_REFUSALS: Record<string, { category: FailureCategory; why: string; step: RecoveryStep }> = {
  WORKFLOW_MACHINE_REPLACED: { category: 'missing_binding', why: 'the computer it was enabled for is no longer enrolled', step: 'accept_binding_change' },
  WORKFLOW_FACT_STALE: { category: 'missing_binding', why: 'a recipient it sends to is no longer current in memory', step: 'update_recipient' },
  WORKFLOW_FACT_AMBIGUOUS: { category: 'missing_binding', why: 'memory holds conflicting values for a recipient it sends to', step: 'update_recipient' },
  SIDECAR_TOO_OLD_FOR_REVIEWED_ACTION: { category: 'missing_binding', why: 'the Jarvis app on that computer is too old for this approved action', step: 'update_desktop_app' },
  SIDECAR_TOO_OLD_FOR_BROWSER_OUTCOMES: { category: 'missing_binding', why: 'the Jarvis app on that computer is too old for this approved browser action', step: 'update_desktop_app' },
};
/** Action codes whose meaning is invalid input or an invalid definition. */
const INPUT_CODES = new Set(['DESKTOP_INVALID_KEYS', 'SKILL_BAD_PARAMS', 'SKILL_INVALID', 'INVALID_JSON_OUTPUT', 'OUTPUT_SCHEMA_MISMATCH',
  'WORKFLOW_NOT_READY', 'SELF_RECURSION']);
/** Action codes whose meaning is that the approval does not cover this run. */
const APPROVAL_CODES = new Set(['APPROVAL_DENIED', 'APPROVAL_EXPIRED', 'APPROVAL_WITHDRAWN', 'APPROVAL_REQUIRED', 'EFFECT_CHANGED_AFTER_REVIEW']);
const APPROVAL_WHY: Record<string, string> = {
  APPROVAL_DENIED: 'its approval was denied', APPROVAL_EXPIRED: 'its approval was not given in time',
  APPROVAL_WITHDRAWN: 'its approval was withdrawn', APPROVAL_REQUIRED: 'it now needs approval',
  EFFECT_CHANGED_AFTER_REVIEW: 'what it would do changed after it was approved',
};
/** A notification that was sent on no channel at all (the notify step's own outcome). */
const DELIVERY_FAILED = 'DELIVERY_FAILED';
/** Readiness issues that name a binding rather than invalid input. */
const BINDING_ISSUES = new Set(['CONNECTION_BINDING', 'WORKFLOW_BINDING', 'TOOL_BINDING', 'ROLE_BINDING', 'BINDING_STALE']);
/** A connection or computer that changed since the workflow was enabled (Q-05): accepted by enabling it again. */
const STALE_BINDING_ISSUE = 'BINDING_STALE';

const PROVIDER: Record<LLMErrorCode, { category: FailureCategory; what: string }> = {
  // Jarvis's own admission budget refused it before any provider was called.
  background_throttled: { category: 'resource_paused', what: 'Jarvis is holding back background AI work for now' },
  auth: { category: 'missing_binding', what: 'the AI provider did not accept its credentials' },
  forbidden: { category: 'provider_limit', what: 'the AI provider does not allow this model or endpoint for this account' },
  rate_limit: { category: 'provider_limit', what: 'the AI provider is rate limiting requests' },
  network: { category: 'target_offline', what: 'the AI provider could not be reached' },
  bad_request: { category: 'invalid_input', what: 'the AI provider refused the request as invalid' },
  unsupported_tools: { category: 'provider_limit', what: 'the selected model cannot use tools' },
  not_found: { category: 'missing_binding', what: 'the configured model or endpoint does not exist' },
  server: { category: 'target_offline', what: 'the AI provider had a server error' },
  quota_exhausted: { category: 'provider_limit', what: "the plan's included AI usage is used up for now" },
  content_policy: { category: 'provider_limit', what: "the AI platform's content policy blocked the request" },
  restricted: { category: 'provider_limit', what: 'hosted AI is restricted on this account' },
  unknown: { category: 'internal', what: 'the AI provider failed' },
};

const NEXT: Record<RecoveryStep, string> = {
  edit_and_run_again: 'Fix the input, then run it again.',
  connect: 'Reconnect or set up what it needs, then run it again.',
  wait_or_switch_model: 'Wait for the limit to reset, or switch to another model.',
  bring_online: 'Bring the computer or service online, then run it again.',
  ask_again: 'Ask for approval again if you still want it.',
  review_authority: 'Allow it in Authority if you want Jarvis to do this, then run it again.',
  check_before_running_again: 'Check whether it happened before running it again. Jarvis will not run it again on its own.',
  check_earlier_steps: 'Check what the earlier steps already did before running it again. Running it again repeats them.',
  run_again: 'Run it again.',
  resend: 'Send it again if it still matters.',
  check_before_resending: 'Check whether it arrived before sending it again. Jarvis will not resend it on its own.',
  open_details: 'Open the details.',
  wait_and_run_again: 'Wait a little, then run it again. Nothing is wrong with the AI provider.',
  run_again_when_resumed: 'Once Jarvis is running again, run it again if you still want it.',
  accept_binding_change: 'Check the change, then enable or publish the workflow again to accept it.',
  update_recipient: 'Update the recipient in the workflow or in memory, then run it again.',
  update_desktop_app: 'Update Jarvis on that computer, then run it again.',
};
const next = (...steps: RecoveryStep[]) => steps.map(step => ({ step, label: NEXT[step] }));
/** Recovery steps with their labels, for a reading that adjusts a projected failure. */
export const recoverySteps = next;

const CHANNELS: Record<string, string> = {
  telegram: 'Telegram', discord: 'Discord', dashboard: 'the dashboard', desktop: 'desktop notifications', voice: 'voice',
};
/** How a delivery channel is named in a sentence. */
export function channelLabel(channel: string): string {
  return CHANNELS[channel] ?? channel;
}
function names(channels: string[]): string {
  const labels = channels.map(channelLabel);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The failure as one short paragraph: what happened, what did and did not
 * take effect, and the first thing to do. For surfaces with room for one line
 * of text, such as a toast; `detail` appends the redacted evidence.
 */
export function failureText(failure: UserFailure, opts: { detail?: boolean } = {}): string {
  const step = failure.next.find(n => n.step !== 'open_details');
  return [failure.headline, failure.outcome, step?.label, opts.detail && failure.detail ? `Details: ${failure.detail}` : '']
    .filter(Boolean).join(' ');
}

/** Redacted, bounded evidence. The original stays in the record it came from. */
export function failureDetail(text: string): string {
  return boundedReceiptText(redactSecrets(text), DETAIL_MAX);
}

function key(category: FailureCategory, code: string | null, links: FailureLinks): string {
  const where = [links.runId, links.stepName, links.effectId, links.approvalId, links.taskId, links.channel, links.requestId]
    .map(v => v ?? '').join('|');
  return createHash('sha256').update(`${category}\u0000${code ?? ''}\u0000${where}`).digest('hex').slice(0, 32);
}

function build(category: FailureCategory, effect: FailureEffect, headline: string, outcome: string, steps: RecoveryStep[],
  links: FailureLinks, code: string | null, detail: string): UserFailure {
  return { category, effect, headline, outcome, next: next(...steps, 'open_details'), links, code, detail: failureDetail(detail),
    key: key(category, code, links) };
}

/** The outcome sentence when nothing took effect. */
export const NOTHING_DONE = 'Nothing was done.';
const NOTHING = NOTHING_DONE;
const MAYBE = 'It may already have taken effect.';

/** Project typed evidence of a failure into what a person reads. */
export function projectFailure(evidence: FailureEvidence, subject: FailureSubject, links: FailureLinks = {}): UserFailure {
  const s = subject.label;
  switch (evidence.source) {
    case 'action': {
      const o = evidence.outcome, code = o.code || null, detail = `${o.status} ${o.code}: ${o.message}`;
      // Whatever the code, an outcome that may have occurred is uncertain: never "nothing happened".
      if (o.status === 'unknown' || o.effect === 'may_have_occurred') {
        return build('uncertain_effect', 'unknown', `${s} may or may not have taken effect.`, MAYBE,
          ['check_before_running_again'], links, code, detail);
      }
      if (code === 'WORKFLOW_CHANGED') {
        return build('not_started', 'none', `${s} did not continue: the workflow changed while it was waiting.`, NOTHING,
          ['run_again'], links, code, detail);
      }
      if (code === 'SETUP_REQUIRED') {
        return build('missing_binding', 'none', `${s} did not run: finish setting up Jarvis first.`, NOTHING, ['connect'], links, code, detail);
      }
      if (code === DELIVERY_FAILED) {
        return build('delivery_failed', 'none', `${s} was not sent.`, 'It was not sent on any channel.', ['resend'], links, code, detail);
      }
      if (code && APPROVAL_CODES.has(code)) {
        return build('approval_denied', 'none', `${s} did not run: ${APPROVAL_WHY[code]}.`, NOTHING, ['ask_again'], links, code, detail);
      }
      if (code === 'AUTHORITY_DENIED') {
        return build('approval_denied', 'none', `${s} did not run: your Authority settings do not allow it.`, NOTHING,
          ['review_authority'], links, code, detail);
      }
      if (code === 'EMERGENCY_STOPPED') {
        return build('cancelled', 'none', `${s} did not run: Jarvis was stopped.`, NOTHING, ['run_again_when_resumed'], links, code, detail);
      }
      if (code && NAMED_REFUSALS[code]) {
        const named = NAMED_REFUSALS[code];
        return build(named.category, 'none', `${s} did not run: ${named.why}.`, NOTHING, [named.step], links, code, detail);
      }
      if (code && OFFLINE_CODES.has(code)) {
        return build('target_offline', 'none', `${s} did not run: the computer it needs is offline or not connected.`, NOTHING,
          ['bring_online'], links, code, detail);
      }
      if (code && BINDING_CODES.has(code)) {
        return build('missing_binding', 'none', `${s} did not run: something it needs is not set up or has changed.`, NOTHING,
          ['connect'], links, code, detail);
      }
      if (code && INPUT_CODES.has(code)) {
        return build('invalid_input', 'none', `${s} did not run: its input or definition is not valid.`, NOTHING,
          ['edit_and_run_again'], links, code, detail);
      }
      return build('not_started', 'none', `${s} stopped before doing anything.`, NOTHING, ['run_again'], links, code, detail);
    }
    case 'readiness': {
      const codes = evidence.issues.map(issue => issue.code);
      const binding = codes.find(c => BINDING_ISSUES.has(c));
      const detail = evidence.issues.map(issue => `${issue.code}${issue.message ? `: ${issue.message}` : ''}`).join('\n');
      if (codes.includes(STALE_BINDING_ISSUE)) {
        return build('missing_binding', 'none', `${s} did not run: a connection or computer it uses changed since it was enabled.`, NOTHING,
          ['accept_binding_change'], links, STALE_BINDING_ISSUE, detail);
      }
      return binding
        ? build('missing_binding', 'none', `${s} did not run: a connection or other binding it needs is missing.`, NOTHING,
          ['connect'], links, binding, detail)
        : build('invalid_input', 'none', `${s} did not run: its definition has problems to fix.`, NOTHING,
          ['edit_and_run_again'], links, codes[0] ?? null, detail);
    }
    case 'provider': {
      const mapped = PROVIDER[evidence.code] ?? PROVIDER.unknown;
      // A model call changes nothing outside Jarvis. Work the same request had
      // already started (a tool it called) may have, so it is never "nothing".
      const effect: FailureEffect = subject.sideEffects ? 'unknown' : 'none';
      if (mapped.category === 'resource_paused') {
        // A pause, not a failure of the provider: it refused before calling one.
        const minutes = evidence.retryAfterMs !== undefined ? Math.max(1, Math.ceil(evidence.retryAfterMs / 60_000)) : null;
        return build('resource_paused', effect, `${s} was paused: ${mapped.what}${minutes ? `, for about ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}.`,
          effect === 'none' ? NOTHING : 'Actions it had already taken may have gone through.',
          effect === 'none' ? ['wait_and_run_again'] : ['check_before_running_again'], links, evidence.code, evidence.message ?? evidence.code);
      }
      const steps: RecoveryStep[] = mapped.category === 'provider_limit' ? ['wait_or_switch_model']
        : mapped.category === 'missing_binding' ? ['connect']
        : mapped.category === 'target_offline' ? (effect === 'none' ? ['run_again'] : [])
        : mapped.category === 'invalid_input' ? ['edit_and_run_again'] : [];
      if (effect === 'unknown') steps.push('check_before_running_again');
      return build(mapped.category, effect, `${s} failed: ${mapped.what}.`,
        effect === 'none' ? NOTHING : 'Actions it had already taken may have gone through.', steps,
        links, evidence.code, evidence.message ?? evidence.code);
    }
    case 'cancellation':
      return evidence.dispatched
        ? build('cancelled', 'unknown', `${s} was cancelled.`, 'Anything it had already sent may have gone through.',
          ['check_before_running_again'], links, 'CANCELLED', evidence.message ?? 'cancelled')
        : build('cancelled', 'none', `${s} was cancelled.`, NOTHING, ['run_again'], links, 'CANCELLED', evidence.message ?? 'cancelled');
    case 'delivery': {
      const by = (result: DeliveryResult) => evidence.channels.filter(c => c.result === result).map(c => c.channel);
      const sent = by('delivered'), failed = by('failed'), unknown = by('unknown');
      const said = { delivered: 'sent', failed: 'not sent', unknown: 'not confirmed' } as const;
      const detail = evidence.channels.map(c => `${channelLabel(c.channel)}: ${said[c.result]}${c.error ? ` (${c.error})` : ''}`).join('\n');
      if (unknown.length) {
        // A send that timed out or dropped after leaving may have arrived:
        // never "not sent", and nothing is resent on its own.
        const parts = [sent.length ? `Sent on ${names(sent)}.` : '', `${upper(names(unknown))} did not confirm it.`,
          failed.length ? `Not sent on ${names(failed)}.` : ''].filter(Boolean).join(' ');
        return build('uncertain_effect', 'unknown', `${s} may not have arrived.`, parts, ['check_before_resending'], links, 'DELIVERY_UNKNOWN', detail);
      }
      if (sent.length) {
        return build('delivery_failed', 'partial', `${s} was only partly sent.`, `Sent on ${names(sent)}. Not sent on ${names(failed)}.`,
          ['resend'], links, 'DELIVERY_PARTIAL', detail);
      }
      return build('delivery_failed', 'none', `${s} was not sent.`, failed.length ? `Not sent on ${names(failed)}.` : 'No channel was available.',
        ['resend'], links, DELIVERY_FAILED, detail);
    }
    case 'unknown':
      // No typed evidence: say what is known, and for work that can change
      // things outside Jarvis, do not claim that nothing did.
      return subject.sideEffects
        ? build('internal', 'unknown', `${s} failed, and Jarvis cannot tell whether it took effect.`, MAYBE,
          ['check_before_running_again'], links, null, evidence.message)
        : build('internal', 'none', `${s} failed.`, NOTHING, ['run_again'], links, null, evidence.message);
  }
}
