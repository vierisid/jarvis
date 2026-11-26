/**
 * The standing of a turn the owner started on the notch.
 *
 * It used to be read off the turn's request id: an id that began
 * `notch-typed-` or `notch-spoken-` had it. That was a naming convention, and
 * any code inside the brain that named its id that way held the widest waiver
 * in the product (authority/owner-word.ts). Now it is an object, made here and
 * nowhere else, and tied to the one turn it was made for. The id keeps its
 * shape and says nothing.
 *
 * How it travels, and it is the whole path:
 *
 *   1. the notch makes it when an instruction becomes a turn (`mintStanding`,
 *      called from notch/asks.ts and from nowhere else in the product: the
 *      list of callers is pinned by standing-sites.test.ts);
 *   2. it is handed to the turn store's in-process `submit`
 *      (brief/chat-transport.ts). A socket has no field for it;
 *   3. the store ties it to the turn's execution context when the turn runs
 *      (`grantStanding`). Once: a standing that was used is used up;
 *   4. whoever asks (`currentStanding`) is answered from the context the code
 *      is running in. A helper agent, a retry and a tool call run inside the
 *      turn and so inside its context. Work the turn started and did not wait
 *      for keeps the context and loses the standing when the turn is over.
 *
 * It is kept in memory only. A restart ends every turn that was running
 * (vault/chat-turns.ts, recover), so there is nothing to carry across one.
 *
 * It also says who wrote the words of the turn:
 *
 *   - `typed`:  the owner, on their keyboard;
 *   - `spoken`: the owner, with the talk keys held;
 *   - `shown`:  the code. The owner circled something without a word, or
 *     pressed a button on a file ("Summarise it"), and the question that runs
 *     is one this product wrote for them.
 *
 * "Saying it is the approval" is about what the owner said. A `shown` turn has
 * a standing, so that it is known to come from the notch, and no owner's word:
 * it is judged like any other turn (`ownerAskedOnNotch` in app-open.ts).
 */
import { currentBriefTurn, type BriefExecutionContext } from '../brief/chat-context.ts';
import { notchEnabled } from '../notch/switch.ts';

/** Who wrote the words of a turn started on the notch. */
export type StandingOrigin = 'typed' | 'spoken' | 'shown';

export interface TurnStanding {
  readonly origin: StandingOrigin;
}

const ORIGINS: ReadonlySet<string> = new Set<StandingOrigin>(['typed', 'spoken', 'shown']);

/** Made here and not yet tied to a turn. An object that merely looks like one is not in it. */
const minted = new WeakSet<TurnStanding>();

/** The turn each standing was tied to, by the turn's own context object. */
const granted = new WeakMap<BriefExecutionContext, TurnStanding>();

/**
 * Makes a standing for one turn. For the notch's own wiring only
 * (notch/asks.ts): whoever calls this says "the owner started this, on their
 * own computer, and this is who wrote its words".
 */
export function mintStanding(origin: StandingOrigin): TurnStanding {
  if (!ORIGINS.has(origin)) throw new Error('Unknown standing');
  const standing: TurnStanding = Object.freeze({ origin });
  minted.add(standing);
  return standing;
}

/** Whether this is a standing made here that no turn has taken yet. */
export function isUnusedStanding(value: unknown): value is TurnStanding {
  return typeof value === 'object' && value !== null && minted.has(value as TurnStanding);
}

/**
 * Ties a standing to the turn that runs under `context`. For the turn store
 * only. False, and nothing is tied, for anything that was not made by
 * `mintStanding`, for one that a turn already took, and for a context that
 * already has one.
 */
export function grantStanding(context: BriefExecutionContext, standing: unknown): boolean {
  if (!isUnusedStanding(standing) || granted.has(context)) return false;
  minted.delete(standing);
  granted.set(context, standing);
  return true;
}

/**
 * The standing of the turn the code running now belongs to, while that turn
 * is still going. Null with the notch switch off, outside a turn, in a turn
 * that was given none, and once the turn has ended or been stopped (Esc):
 * whatever it left running has no standing from it.
 */
export function currentStanding(): TurnStanding | null {
  if (!notchEnabled()) return null;
  const turn = currentBriefTurn();
  if (!turn || turn.over === true || turn.signal.aborted) return null;
  return granted.get(turn) ?? null;
}

/** Whether the owner wrote the words of this standing themselves. */
export function ownersOwnWords(standing: TurnStanding | null): boolean {
  return standing !== null && (standing.origin === 'typed' || standing.origin === 'spoken');
}
