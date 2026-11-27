/**
 * Ask, then burn a fuse, then act: the one way it is done (fix 05, step 9).
 *
 * Everything the notch does in the world on a yes goes the same road after
 * that yes (docs/notch/README.md 22, 61, 116, 262 to 268):
 *
 *   held     what stops it before anything burns: everything is stopped, it
 *            cannot start now. Nothing burns for a thing that cannot go
 *   look     a try before this one may have gone (Send was pressed and
 *            nothing confirmed it). It is looked for before it is done
 *            again: found, it is written down as done and not done twice;
 *            not known, nothing is done
 *   still    asked again after the look and after the fuse: whether it is
 *            still to be done (decided somewhere else, closed meanwhile)
 *   the fuse a line with its window, or the letter on paper under it, which
 *            goes only on a page's word that it was seen to its end
 *            (`NotchStage.letter`). Esc takes the yes back. A fuse nobody
 *            saw burn out decides nothing
 *   act      what the yes was for. It says what came of it
 *   record   written down once, where what came of it is known
 *            (./actions.ts): only past a fuse seen to burn out. A yes taken
 *            back, a fuse nobody saw, a thing held: nothing is written
 *
 * What the owner is asked, and how (a line, a sheet, a pick, words), stays
 * with each feature: their asks differ in what can be changed on them before
 * the yes. Once the yes is given, this is the road. What is said afterwards
 * is the feature's too: it gets back how it ended.
 *
 * Where the fuse burns in the middle of the act (a reply is put in its thread
 * first, and the fuse burns over the draft there, ./mail/send.ts), the act is
 * handed the gate and burns it itself (`inside`). The rule is the same: only
 * a gate that was seen to burn out lets it go, and only then is anything
 * written down.
 */
import { notchSentOutcome, type NotchActionAsked, type NotchActionEntry, type NotchActionHow, type NotchActionKind, type NotchActionOutcome, type NotchActions } from './actions.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';
import { NotchStageEnded, type NotchLineExtras, type NotchStage } from './stage.ts';

/** How a fuse ended: seen to burn out, taken back, burnt out over a letter nobody vouched for, or nobody said. */
export type NotchFuseEnd = 'done' | 'undo' | 'unseen' | 'lost';

/** What the act says came of it: the outcome to write down (null: nothing, it was not this yes's to write), and the feature's own result. */
export interface NotchActed<R> {
  outcome: NotchActionOutcome | null;
  result: R;
}

export interface NotchDecidable<H, R> {
  /** What the owner had before them, and how they gave the yes: read right after the yes, before the fuse answers. */
  asked: Omit<NotchActionAsked, 'fuseMs'>;
  /** The line under the fuse. With `letter`, what goes is shown whole under it, and it goes only when seen. */
  fuse: { say: NotchPart[]; ms: number; extras?: NotchLineExtras; letter?: NotchBlock[] };
  /** Why nothing may burn now (everything is stopped, it cannot start). Null when it may. */
  held?(): H | null;
  /** An earlier try may have gone: it is looked for first (`went`), and `ref` is the entry that says it may have. */
  look?: { went(): Promise<boolean | null> } | null;
  /** Asked after the look and after the fuse: why it is no longer to be done. Null when it still is. */
  still?(): H | null;
  /** The act burns the gate itself, in its middle. Without it the fuse burns first and the act follows. */
  inside?: boolean;
  act(gate: () => Promise<boolean>): Promise<NotchActed<R>>;
  /** The entry this action is written down as, with what came of it, and the act's result when it ran. */
  entry(outcome: NotchActionOutcome, asked: NotchActionAsked, result?: R): NotchActionEntry;
  /** What is written down when the act breaks off past a fuse that burnt out: it may have been done. Not given: nothing. */
  broke?: NotchActionOutcome;
}

export type NotchDecided<H, R> =
  /** Held before anything burnt, or no longer to be done after the look or the fuse. */
  | { took: 'held'; held: H }
  /** The earlier try had gone: written down as done, and not done again. */
  | { took: 'found' }
  /** Whether the earlier try went is not known: nothing was done. */
  | { took: 'unknown' }
  /** The fuse did not let it go: taken back, nobody vouched for the letter, nobody said. Nothing was done or written. */
  | { took: 'undo' | 'unseen' | 'lost' }
  /** The act ran. `fuse` is how its gate ended: with `inside`, the act may have ended before or without it. */
  | { took: 'acted'; fuse: NotchFuseEnd; result: R };

/** Where what was done is written down, and what the act's own lines are said with. */
export interface NotchDecideDeps {
  actions?: Pick<NotchActions, 'record' | 'settle'> | null;
}

/** Burns the fuse of a decidable on its stage: the line, or the letter that goes only when seen. */
async function burn(stage: NotchStage, fuse: NotchDecidable<unknown, unknown>['fuse']): Promise<NotchFuseEnd> {
  return fuse.letter
    ? stage.letter(fuse.say, fuse.ms, fuse.letter, fuse.extras)
    : stage.fuse(fuse.say, fuse.ms, fuse.extras);
}

/**
 * Plays what comes after a yes: held, the look, the fuse, the act, and the
 * one entry of what came of it. A stage that ends throws, as every wait on
 * it does; past a fuse that burnt out, what `broke` says is written first.
 */
export async function playDecidable<H, R>(stage: NotchStage, item: NotchDecidable<H, R>, deps: NotchDecideDeps = {}): Promise<NotchDecided<H, R>> {
  const asked: NotchActionAsked = { ...item.asked, fuseMs: item.fuse.ms };
  const held = item.held?.() ?? null;
  if (held !== null) return { took: 'held', held };
  if (item.look) {
    stage.put({ id: stage.id(), kind: 'work', say: ['Looking whether it went…'], steps: 0, done: 0, src: 'mail' });
    // A look that breaks says nothing about whether it went. A stage that ended ends this too.
    const there = await item.look.went().catch((error: unknown) => { if (error instanceof NotchStageEnded) throw error; return null; });
    const after = item.still?.() ?? null;
    if (after !== null) return { took: 'held', held: after };
    if (there === true) {
      // The entry that said it may have gone says that it went: no second one. With none written down
      // (its write had failed), it is written now, as what this yes found.
      const found = item.entry('done', asked);
      if (found.ref) deps.actions?.settle(found.ref, 'done', { otherwise: found });
      else deps.actions?.record(found);
      return { took: 'found' };
    }
    if (there === null) return { took: 'unknown' };
  }
  // Changed by the gate, wherever it is burnt.
  let fuse = 'lost' as NotchFuseEnd;
  const gate = async (): Promise<boolean> => {
    fuse = await burn(stage, item.fuse);
    return fuse === 'done';
  };
  if (!item.inside) {
    if (!(await gate())) return { took: fuse as 'undo' | 'unseen' | 'lost' };
    const after = item.still?.() ?? null;
    if (after !== null) return { took: 'held', held: after };
  }
  let acted: NotchActed<R>;
  try {
    acted = await item.act(item.inside ? gate : async () => true);
  } catch (error) {
    if (fuse === 'done' && item.broke) deps.actions?.record(item.entry(item.broke, asked));
    throw error;
  }
  // Written down once the yes stands: the fuse was seen to burn out. Then whatever came of it is.
  if (fuse === 'done' && acted.outcome !== null) deps.actions?.record(item.entry(acted.outcome, asked, acted.result));
  return { took: 'acted', fuse, result: acted.result };
}

/**
 * Something sent to another person's Jarvis on the owner's word (./people.ts and the parts it is made of):
 * the line under its fuse is all the owner sees, and what they said or typed (or a pick, `how`) started
 * it. Taken back, `back` is said. Comes back with what the send said, or null when nothing went: taken
 * back, or nobody saw the fuse burn out. One entry says what came of it (`notchSentOutcome`).
 */
export async function playSend<T extends { ok: boolean; why?: string }>(
  stage: NotchStage,
  send: {
    say: NotchPart[]; ms: number; extras?: NotchLineExtras; back: NotchPart[];
    kind: NotchActionKind; what: string; target: string; how?: NotchActionHow;
    go(): Promise<T>;
  },
  deps: NotchDecideDeps = {},
): Promise<T | null> {
  const played = await playDecidable<never, T>(stage, {
    asked: { seen: 'line', how: send.how ?? 'said' },
    fuse: { say: send.say, ms: send.ms, ...(send.extras ? { extras: send.extras } : {}) },
    act: async () => {
      const sent = await send.go();
      return { outcome: notchSentOutcome(sent), result: sent };
    },
    entry: (outcome, asked) => ({ kind: send.kind, what: send.what, target: send.target, asked, outcome }),
  }, deps);
  if (played.took === 'undo') { await stage.say(send.back, 2000); return null; }
  return played.took === 'acted' ? played.result : null;
}
