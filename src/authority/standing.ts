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
 *      for keeps the context and loses the standing when the turn is over:
 *      the store takes it back (`revokeStanding`), so that does not rest on a
 *      flag of the context that anything holding the context could write.
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
 * It is never judged more lightly than a typed one: the turn store marks every
 * shown turn as holding outside content, whatever came with it
 * (`NOTCH_SHOWN_SOURCE`), so the guard that asks after outside content was
 * read is on from its first step.
 *
 * A bare yes is the one thing the owner writes that is `shown` too: typed or
 * said in answer to a question that a turn with no word of the owner's asked
 * back (a shown turn, an offer that was taken, such a yes before it), it says
 * nothing of its own, and what it agrees to was proposed by a turn that had
 * no word of theirs (notch/asks.ts). An answer with a word of its own is the
 * owner's.
 *
 * And it says what the owner's words asked for (decided by the owner on 26
 * November 2026, owner-word.ts): `words` is the sentence, and `covers` is
 * which of the four kinds of act that reach out or run code it asked for (a
 * send, a command, an install, a change of settings), read from the sentence
 * alone where the turn is made (words-cover.ts). They matter once the turn
 * has read something the owner did not write. A bare yes to what a turn with
 * the owner's word asked back is `answers`: the question it agrees to was not
 * written by the owner, so the turn counts as having read outside content
 * from its first step (owner-word.ts reads it here; the turn is not marked
 * for the ordinary guard, which the owner's word sets aside anyway, and it
 * runs the same way a typed turn does). It covers what the question asked
 * and what the words before it covered.
 */
import { currentBriefTurn, type BriefExecutionContext } from '../brief/chat-context.ts';
import { notchEnabled } from '../notch/switch.ts';
import { OWNER_ACTS, type OwnerAct } from './words-cover.ts';

/** Who wrote the words of a turn started on the notch. */
export type StandingOrigin = 'typed' | 'spoken' | 'shown';

export interface TurnStanding {
  readonly origin: StandingOrigin;
  /** What the owner wrote or said, and for a bare yes also the question it answers. Empty for a shown turn. */
  readonly words: string;
  /** The kinds of act those words asked for. Always none for a shown turn. */
  readonly covers: readonly OwnerAct[];
  /** The words are only a yes to a question the assistant asked back: that question is outside content, so the turn has read some from its start. */
  readonly answers: boolean;
}

/** What the notch says of the words when it makes a standing. Left out: the words cover nothing. */
export interface StandingWords {
  words?: string;
  covers?: Iterable<OwnerAct>;
  answers?: boolean;
}

/**
 * The outside content every `shown` turn is marked as holding, beside any
 * attachment it has: its request was not written by the owner.
 */
export const NOTCH_SHOWN_SOURCE = 'notch request the owner did not write';

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
export function mintStanding(origin: StandingOrigin, said: StandingWords = {}): TurnStanding {
  if (!ORIGINS.has(origin)) throw new Error('Unknown standing');
  // A question the code wrote is nobody's word: it has no words and covers nothing, whatever is handed in.
  const owners = origin !== 'shown';
  const covers = owners ? OWNER_ACTS.filter((act) => [...(said.covers ?? [])].includes(act)) : [];
  const standing: TurnStanding = Object.freeze({
    origin,
    words: owners && typeof said.words === 'string' ? said.words : '',
    covers: Object.freeze(covers),
    answers: owners && said.answers === true,
  });
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
 * Takes a turn's standing back. For the turn store, when the turn ends:
 * whatever still runs with the turn's context reads none from then on.
 */
export function revokeStanding(context: BriefExecutionContext): void {
  granted.delete(context);
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
