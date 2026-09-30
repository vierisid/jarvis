/**
 * Which delivery scope a tool call runs in, as ambient context (#586).
 *
 * `WebappTemplateDelivery` remembers, per site template, that it handed the
 * playbook over recently, and stays quiet for 30 minutes so the model is not
 * re-stuffed with the same instructions every snapshot. That memory was one map
 * per instance, and one instance -- `globalWebappTemplateDelivery` -- serves
 * nearly everything: the daemon builds ONE ToolRegistry at startup
 * (daemon/agent-service.ts) and registers the module-level browser tools into
 * it, so every chat conversation, the approval executor, every workflow step and
 * every delegated sub-agent share it. The consumers therefore did not share a
 * scope; a workflow step taking a snapshot spent the chat model's delivery.
 *
 * Only the background agent was already isolated, because it builds its own
 * tools (`createBrowserTools`) over its own instance.
 *
 * WHY AMBIENT. `ToolDefinition.execute(params)` takes the model's arguments and
 * nothing else, by design -- a scope passed as a parameter would be a parameter
 * the model can set. The callers that know the answer sit several layers above:
 * the workflow tool adapter, the sub-agent runner, the approval executor. The
 * precedent is `turn-scope-store.ts`, `llm/origin.ts` and the orchestrator's
 * taint store, all of which carry per-turn facts this way for the same reason.
 *
 * NOT A SECURITY BOUNDARY, and nothing here grants anything. The states differ
 * only in which slot a delivery is recorded against, or whether it happens at
 * all. Escaping the async context fails to ABSENT, which means "the main
 * conversation's tool set" -- exactly what every caller got before this existed.
 * No id here is model-controlled: the only named ids are sub-agent UUIDs.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * ABSENT (no entry) is the instance's default scope: the chat conversation.
 *
 * A discriminated union rather than a nullable string, so the three states are
 * distinguishable here whatever an id later comes from. Keeping a NAMED id away
 * from the default scope's key is the tracker's job, not this type's -- see
 * `NAMED_SCOPE_PREFIX` in webapp-template-injection.ts.
 *
 * WHAT ABSENT COVERS, and it is more than one conversation. The chat's WebSocket
 * turns, a Telegram or Discord turn, and the realtime/voice tool route
 * (`executeRealtimeToolCallInner`) all share it, so they can still spend each
 * other's delivery. Narrowing that needs a conversation identity at the tool
 * boundary and there is none: `ToolDefinition.execute` takes the model's
 * arguments, `turn-scope-store.ts` carries a tool scope rather than a
 * conversation (undefined for ordinary chat, one shared constant for every site
 * chat), and `chatContextKey` is an explicit argument that stops well above the
 * registry. #586's case is workflow-versus-chat and #529 chose per-tool-set
 * granularity deliberately; this is the residual, recorded so the next reader
 * does not count the entered scopes and conclude voice is covered.
 */
export type TemplateDeliveryScope =
  /** Never deliver, and never record one. For a consumer with no model to read
   *  a playbook, or one that cannot place a trailer outside the untrusted
   *  block -- recording a delivery nobody can use is what burns the slot. */
  | { readonly kind: 'suppressed' }
  /** A context with its own conversation and its own history, which must
   *  neither suppress the chat's copy nor be suppressed by it. */
  | { readonly kind: 'named'; readonly id: string };

const store = new AsyncLocalStorage<TemplateDeliveryScope>();

/** Run `fn` with deliveries recorded under `id` rather than the default scope. */
export function withTemplateDeliveryScope<T>(id: string, fn: () => T): T {
  return store.run({ kind: 'named', id }, fn);
}

/**
 * Run `fn` with site-playbook delivery off: no lookup, no trailer, no record.
 *
 * For the paths that provably cannot use a trailer. Nesting inside a named
 * scope suppresses within it, which is the right way round: the innermost
 * caller is the one that knows what happens to the value.
 */
export function withoutTemplateDelivery<T>(fn: () => T): T {
  return store.run({ kind: 'suppressed' }, fn);
}

/**
 * The ambient scope, or undefined outside any of them.
 *
 * The try/catch is belt and braces -- `getStore()` does not throw -- and it is
 * here for the same reason `currentTurnScopeId` has one: deciding whether to
 * attach a playbook must never be the thing that breaks a tool call.
 */
export function currentTemplateDeliveryScope(): TemplateDeliveryScope | undefined {
  try {
    return store.getStore();
  } catch {
    return undefined;
  }
}
