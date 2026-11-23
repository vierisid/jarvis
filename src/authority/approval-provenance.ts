import { AsyncLocalStorage } from 'node:async_hooks';
import { isScreenCaptureEnabled } from '../actions/tools/desktop-guard.ts';

/**
 * Where an approval request came from, recorded on the row when it is created
 * (owner decision 2026-11-11, #1314 follow-up).
 *
 * `screen`: raised by a screen-derived background turn (error and struggle
 * research, the event reactor's turns on awareness events). Its tool call was
 * written from what was read on the screen, so while screen awareness is off
 * it is held: no card is delivered or retried, approving it waits (the card
 * stays pending, it is not denied) and the executor refuses to run it. Once
 * awareness is back on it is approvable again. Every other approval is
 * unaffected.
 *
 * `watched`: raised by a turn the owner watches step by step (a colleague's
 * request that asks for something to be done, daemon/notch-peers.ts). It is
 * a step of that job: it is put to the owner by whoever shows the job, in
 * its place among the other steps, and by no other surface. Shown as a card
 * of its own it could be approved by somebody who does not see what it is a
 * step of, or after the job was stopped.
 *
 * Carried in AsyncLocalStorage like the LLM origin (src/llm/origin.ts): the
 * background agent sets it around the whole turn, and every request created
 * inside it (the authority gate, a sub-agent's gate, request_approval) is
 * marked without each layer passing it on.
 */
export type ApprovalProvenance = 'screen' | 'watched';

const store = new AsyncLocalStorage<ApprovalProvenance>();

/** Run `fn` (and everything it starts) with every approval it creates marked `provenance`. */
export function runWithApprovalProvenance<T>(provenance: ApprovalProvenance, fn: () => T): T {
  return store.run(provenance, fn);
}

/** Run `fn` with no provenance, whatever context it was called from. */
export function runWithoutApprovalProvenance<T>(fn: () => T): T {
  return store.exit(fn);
}

export function currentApprovalProvenance(): ApprovalProvenance | null {
  return store.getStore() ?? null;
}

/** Whether this request is a step of something the owner watches being done: shown there, and nowhere else. */
export function approvalIsWatched(request: { provenance?: string | null }): boolean {
  return request.provenance === 'watched';
}

/** What a person is told about a held screen-derived approval. */
export const AWARENESS_HELD_APPROVAL_MESSAGE =
  'Held while screen awareness is off: this request came from what was on your screen. Turn screen awareness back on to approve it; it is still waiting.';

/** Whether this request is held now: screen-derived, with screen awareness off. */
export function approvalHeldByAwareness(request: { provenance?: string | null }): boolean {
  return request.provenance === 'screen' && !isScreenCaptureEnabled();
}
