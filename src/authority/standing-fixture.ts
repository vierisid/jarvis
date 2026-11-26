/**
 * For tests only: a turn's execution context as the turn store builds it,
 * with the standing the notch would have given it. Nothing in the product
 * imports this file (standing-sites.test.ts holds it to that).
 */
import { withBriefTurn, type BriefExecutionContext } from '../brief/chat-context.ts';
import { grantStanding, mintStanding, type StandingOrigin, type StandingWords } from './standing.ts';

/**
 * The context of a turn. `origin` null is a turn that was given no standing
 * (a dashboard send, or anything that only names its ids like the notch).
 * `said`: the owner's words and what they asked for; left out, they asked
 * for nothing that reaches out or runs code.
 */
export function turnContext(
  origin: StandingOrigin | null,
  more: { requestId?: string; controller?: AbortController; said?: StandingWords } = {},
): BriefExecutionContext {
  const context: BriefExecutionContext = {
    conversationId: 'c', turnId: 't', requestId: more.requestId ?? (origin ? `notch-${origin === 'shown' ? 'typed' : origin}-1` : 'req-1'),
    signal: (more.controller ?? new AbortController()).signal, progress: () => {},
  };
  if (origin) grantStanding(context, mintStanding(origin, more.said));
  return context;
}

/** Runs `fn` inside such a turn. */
export function inTurnOf<T>(origin: StandingOrigin | null, fn: () => T, more?: { requestId?: string; controller?: AbortController; said?: StandingWords }): T {
  return withBriefTurn(turnContext(origin, more), fn);
}
