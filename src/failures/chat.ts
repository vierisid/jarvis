/**
 * Q-19: the failure a chat error frame carries. One builder for every place a
 * turn can fail (the stream relay, the chat handler), so a failed reply reads
 * the same in every tab and in Today, and the dashboard never has to guess a
 * failure from its wording.
 */
import { redactSecrets } from '../util/redact';
import { getDb } from '../vault/schema';
import { projectFailure, type FailureEvidence, type UserFailure } from './projection';

export interface ChatErrorPayload {
  /** The original message, credentials redacted. Shown only behind details. */
  message: string;
  /** The typed code it was classified from: a provider code, an action code, or `unknown`. */
  code: string;
  failure: UserFailure;
  requestId?: string;
}

/**
 * `toolsRan`: the turn had already called a tool before it failed, so work it
 * started may have taken effect; never "nothing was done".
 */
export function chatErrorPayload(evidence: FailureEvidence, opts: { requestId?: string; toolsRan?: boolean } = {}): ChatErrorPayload {
  const failure = projectFailure(evidence, { label: 'Your request', sideEffects: opts.toolsRan === true },
    opts.requestId ? { requestId: opts.requestId } : {});
  const message = evidence.source === 'action' ? evidence.outcome.message
    : 'message' in evidence && typeof evidence.message === 'string' ? evidence.message : failure.headline;
  return { message: redactSecrets(message), code: evidence.source === 'provider' ? evidence.code : failure.code ?? 'unknown', failure,
    ...(opts.requestId ? { requestId: opts.requestId } : {}) };
}

/**
 * Keep a failed turn that may have acted (its effect is not "none"), so Today
 * can show it until the person checks and dismisses it. A turn that changed
 * nothing is not kept: the chat already showed it. Idempotent by key.
 */
export function recordChatFailure(failure: UserFailure, now = Date.now()): boolean {
  if (failure.effect === 'none') return false;
  return getDb().run('INSERT OR IGNORE INTO chat_failure (key, failure, at) VALUES (?, ?, ?)',
    [failure.key, JSON.stringify(failure), now]).changes === 1;
}

/** Kept chat failures, newest first. They stay until dismissed. */
export function listChatFailures(): Array<{ failure: UserFailure; at: number }> {
  return (getDb().query('SELECT failure, at FROM chat_failure ORDER BY at DESC LIMIT 50').all() as Array<{ failure: string; at: number }>)
    .map(row => ({ failure: JSON.parse(row.failure) as UserFailure, at: row.at }));
}

/** Dismissing a chat failure removes it. */
export function dismissChatFailures(keys: string[]): number {
  let removed = 0;
  for (const key of keys) removed += getDb().run('DELETE FROM chat_failure WHERE key = ?', [key]).changes;
  return removed;
}
