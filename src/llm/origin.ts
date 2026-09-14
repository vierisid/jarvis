import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * On whose behalf an LLM request is made.
 *
 * The hosted platform screens what reaches its providers and counts policy
 * strikes against the account, but only for what the PERSON wrote. A lot of
 * hosted traffic is not that: background turns quote incoming email and
 * calendar text, workflows process whatever they were pointed at, and the
 * post-turn extractor re-sends a conversation that was already screened. So
 * the hosted provider tags each request with `x-jarvis-origin` and the platform
 * weighs a hit by it.
 *
 * Carried in AsyncLocalStorage rather than threaded through every call: the
 * LLM calls sit many layers below the entry points that know the answer, and
 * the tag has to survive un-awaited follow-ups (a turn's extraction) without
 * each layer remembering to pass it on. Set it at the ENTRY point, around the
 * code that consumes the whole turn, including a streamed answer: an async
 * generator's body runs in the context of whoever calls next().
 *
 * Unset means "unknown", and the header is simply omitted; the platform treats
 * a request without it as the person's own.
 */
export type LLMOrigin = 'user' | 'background' | 'workflow';

export const ORIGIN_HEADER = 'x-jarvis-origin';

const store = new AsyncLocalStorage<LLMOrigin>();

/** Run `fn` (and everything it starts) with `origin`; nested calls override. */
export function runWithOrigin<T>(origin: LLMOrigin, fn: () => T): T {
  return store.run(origin, fn);
}

export function currentOrigin(): LLMOrigin | undefined {
  return store.getStore();
}

/** The header to add to a hosted request, or nothing when the origin is unknown. */
export function originHeaders(): Record<string, string> {
  const origin = currentOrigin();
  return origin ? { [ORIGIN_HEADER]: origin } : {};
}
