/**
 * The current turn's tool scope, as ambient context (#571).
 *
 * Why this exists at all, when the scope is otherwise passed explicitly
 * everywhere: one in-scope tool's whole effect is to schedule a LATER turn
 * whose text the model writes. `commitments` creates a row the
 * CommitmentExecutor picks up minutes or days later, and the scope is
 * per-turn, so by the time that row runs there is nothing left to consult.
 * Recording the originating scope ON the row is what makes the escalation
 * visible, and for that the creating code has to be able to ask "what scope am
 * I inside".
 *
 * Only the scope's ID is carried, not the scope object: what a caller does
 * with it is record it (`commitments.scope_id`), and a recorded id is only
 * ever read back for logging and comparison, never resolved into a policy.
 * The scope a turn RUNS under always comes from that turn.
 *
 * An AsyncLocalStorage rather than a parameter because the alternative is a
 * `scope` argument on `createCommitment` and on every one of its six callers,
 * four of which have no turn in hand at all (the HTTP route, the extractor,
 * goal work items, delegation records). The precedent is `taintStore`
 * (agents/orchestrator.ts) and `llm/origin.ts`, both of which carry per-turn
 * facts the same way for the same reason.
 *
 * A module-level global, like those two, which means it is NOT a security
 * boundary: it is entered per tool call inside the orchestrator, so a tool
 * that spawns work escaping that call's async context sees `undefined`. That
 * direction is the safe one -- an unstamped row, which the executor treats as
 * unscoped, which is what it already did for every row before this existed.
 * Nothing reads this to GRANT anything.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<string | undefined>();

/** Run `fn` with `scopeId` as the ambient turn scope. */
export function withTurnScopeId<T>(scopeId: string | undefined, fn: () => T): T {
  return store.run(scopeId, fn);
}

/**
 * The ambient turn scope id, or `undefined` outside any scoped turn.
 *
 * Never throws: a caller recording provenance must not be the thing that
 * breaks a turn.
 */
export function currentTurnScopeId(): string | undefined {
  try {
    return store.getStore();
  } catch {
    return undefined;
  }
}
