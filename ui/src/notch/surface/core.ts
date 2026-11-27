/**
 * What the page holds and decides, with no screen and no clock: the line the
 * brain said is up, whether it was answered, how far the page has read, and
 * what each thing the person does with the line comes to. Every function here
 * takes the model and the time and gives back a new model and what is to be
 * done, in order (`NotchPageOut`): what to say to the brain, what to draw.
 * Nothing is changed in place, nothing is scheduled, nothing is drawn. The
 * drawing is ./render.ts; the keys, the pointer and the page's own events are
 * read by ./input.ts; ./index.ts joins them.
 *
 * The rules themselves are the brain's, written into each line (`after`,
 * `away`, `asking`, `gate`, `held`): this only reads them. What only the page
 * can know (whether the end of a sheet is on screen, what is typed in a field,
 * whether a word's choices are open) comes in with each input as `facts`.
 */
import {
  NOTCH_ARRIVALS, NOTCH_FUSE_SEEN_MS, NOTCH_MOODS, NOTCH_PROTOCOL_VERSION, notchWhereApp, readNotchToPage,
} from '../../../../src/notch/protocol.ts';
import type {
  NotchAnswerAct, NotchBlock, NotchBirth, NotchEdit, NotchEffect, NotchFromPage, NotchKept, NotchLine, NotchMood, NotchMouth, NotchPart,
  NotchWhereApp,
} from '../../../../src/notch/protocol.ts';

export type NotchPageAnswer = Extract<NotchFromPage, { type: 'answer' }>;

/** The line on the notch and what has been done with it. */
export interface NotchPageCur {
  readonly id: string;
  /** Answered: nothing more can be done with it until the brain says what next. */
  readonly done: boolean;
  /** A fuse that was taken back. Whatever comes after, this page never says of it that it ran out. */
  readonly undone: boolean;
}

export interface NotchPageModel {
  /** The brain has told the whole of the notch once: before that nothing is drawn and nothing is heard but a `state`. */
  readonly born: boolean;
  /** The run of the brain this page was last told the whole by. */
  readonly brain: string;
  /** The number of the last message read from it. One whose number is not the next was not the next the brain sent. */
  readonly seq: number;
  readonly line: NotchLine | null;
  readonly cur: NotchPageCur | null;
  /** Counts the drawings of a line: a fuse that waits for its paper to fold is lit only if it is still the same drawing. */
  readonly drawn: number;
  /** Every drawing makes whatever was scheduled before it void: `due` holds only while this is what it was. */
  readonly tok: number;
  /** What `tok` was when the last drawing was finished. Not `tok` any more: something is on its way, or failed half way. */
  readonly shownTok: number;
  /** When the line that is up was drawn. */
  readonly shownAt: number;
  /** When the result or the burning fuse that is up runs out. `fired`: it did, and was said. */
  readonly due: { readonly id: string; readonly at: number; readonly tok: number; readonly fired?: true } | null;
  /** The drawing (`drawn`) of a send whose fuse was put up: before that (its paper still folding away) Esc has nothing to take back. */
  readonly undoable: number;
  /** The line on its way in along the edge, not yet on the notch, and which arrival it is. */
  readonly arriving: { readonly line: NotchLine; readonly n: number } | null;
  readonly count: number;
  /** The face the notch rests with. */
  readonly face: NotchMood;
  /** The app in front on this machine, as the brain last said. */
  readonly where: NotchWhereApp | null;
  /** When the last two clicks on the notch came. */
  readonly clickAt: number;
  readonly clickBefore: number;
}

export const notchPageStart = (): NotchPageModel => ({
  born: false, brain: '', seq: -1, line: null, cur: null, drawn: 0, undoable: 0, tok: 0, shownTok: 0, shownAt: 0, due: null, arriving: null,
  count: 0, face: 'idle', where: null, clickAt: 0, clickBefore: 0,
});

/** What only the page can know when the person does something, measured as it happens. */
export interface NotchPageFacts {
  /** The notch is on screen (it can be hidden while it is born, or before the brain has spoken). */
  shown?: boolean;
  /** The notch shows the eyes and nothing else. */
  resting?: boolean;
  /** A word's strip of choices is open. */
  picking?: boolean;
  /** Something is typed in a word's field and not yet taken. */
  typed?: boolean;
  /** A row of choices is drawn: a yes nudges it, to say "pick one". */
  choices?: boolean;
  /** Since when the end of the sheet that is up has been on screen, or null if it has not been. */
  sheetSeenAt?: number | null;
  /** What is typed in the line's own field, trimmed. */
  askText?: string;
  /** A letter under its fuse was drawn here, its end on the screen, and this page in sight for all of it. */
  letterSeen?: boolean;
}

/** What is to be done, in order, after the person or the brain did something. */
export type NotchPageOut =
  | { do: 'send'; message: NotchFromPage }
  /** An answer, said until the brain has it. `once`: it settles its line (./answers.ts). */
  | { do: 'answer'; answer: Omit<NotchPageAnswer, 'n'>; once: boolean }
  | { do: 'rest'; instant?: boolean }
  /** Answered: dimmed, until the brain says what next. */
  | { do: 'settle' }
  /** An answer the brain never had: the line can be answered again. */
  | { do: 'reopen' }
  /** A yes is seen: the eyes nod and the bottom edge gulps. */
  | { do: 'nod' }
  | { do: 'shake' }
  | { do: 'sfx'; name: 'yes' | 'no' }
  /** The fuse stops burning. */
  | { do: 'unfuse' }
  /** What ran out leaves along the edge, to the left or the right. */
  | { do: 'depart'; left: boolean }
  | { do: 'clearHint' }
  /** A sheet that must be seen whole goes down a page. */
  | { do: 'scrollSheet' }
  | { do: 'nudge' }
  /** What is typed in a word's field is taken, as Enter would take it. */
  | { do: 'commit' }
  | { do: 'closePick' }
  /** The line's own field gives the keyboard back. */
  | { do: 'blurAsk' }
  | { do: 'talk'; held: boolean }
  /** A line is drawn. `restore`: if it cannot be, the line before it stays (a patch); otherwise the notch rests (a state). */
  | { do: 'draw'; line: NotchLine; restore: boolean; instant: boolean }
  | { do: 'arrive'; line: NotchLine; n: number }
  | { do: 'edit'; edit: NotchEdit }
  /** What a `patch` says of the notch apart from its line, as the page is to show it. */
  | { do: 'kept'; kept: NotchKept }
  /** What a `state` says of the notch apart from its line: the face, the app in front, the eye, the sound. */
  | { do: 'whole'; eye: boolean; sound: boolean }
  | { do: 'effect'; effect: NotchEffect }
  /** The brain holds the line answered: it is answered here too, and a fuse on it burns no further. */
  | { do: 'held'; line: NotchLine }
  | { do: 'appear' }
  | { do: 'birth'; born: NotchBirth }
  | { do: 'park'; park: number }
  | { do: 'mouth'; mouth: NotchMouth; whole: boolean }
  /** The brain has the answer `n`. `unread`: a typed value it could not read. */
  | { do: 'ack'; n: number; took: boolean; unread?: boolean }
  | { do: 'clearAnswers' }
  | { do: 'outOfStep'; what: string; refused?: boolean }
  | { do: 'version'; v: number }
  /** Whether Esc is wanted, whether a question is up, whether a hand is on it: worked out again. */
  | { do: 'sync' }
  | { do: 'beat' };

export interface NotchPageStep { model: NotchPageModel; out: NotchPageOut[] }

/** Two clicks closer together than this are one double click. */
export const NOTCH_DOUBLE_CLICK_MS = 500;

// --- the moment a line was drawn ---

/**
 * How a press is too soon after the line was drawn, by what it came by. The
 * numbers are the brain's (`gate`), counted here from when the line was drawn:
 * only the page can count that.
 *
 *   key    a yes by its keys, Enter, or a press away from the notch: a moment
 *          for any line (the key may already have been on its way down), and
 *          longer for one that came by itself (`gate.dead`)
 *   esc    an Esc, on a line that came by itself, in its first moment (`gate.esc`)
 *   click  a click on a yes or a choice: as an Esc, or the second of two quick
 *          clicks whose first was made before this line was shown (a double
 *          click, whose second half lands on whatever the first brought up)
 */
export function notchTooSoon(model: NotchPageModel, via: 'key' | 'esc' | 'click', now: number): boolean {
  const gate = model.line?.gate;
  if (via === 'key') return now - model.shownAt < (gate?.dead ?? 0);
  const early = now - model.shownAt < (gate?.esc ?? 0);
  if (via === 'esc') return early;
  return early || (model.clickBefore > 0 && model.clickBefore < model.shownAt && model.clickAt - model.clickBefore < NOTCH_DOUBLE_CLICK_MS);
}

/** A click on the notch came now. */
export const notchClicked = (model: NotchPageModel, now: number): NotchPageModel => ({ ...model, clickBefore: model.clickAt, clickAt: now });

/** How long ago the line that is up was drawn, in whole ms. */
export const notchSince = (model: NotchPageModel, now: number): number => Math.max(0, Math.round(now - model.shownAt));

/** A drawing starts: what was scheduled for the one before is void from here. */
export const notchPainting = (model: NotchPageModel, now: number): NotchPageModel => ({ ...model, tok: model.tok + 1, shownAt: now });
/** The drawing is finished. */
export const notchPainted = (model: NotchPageModel): NotchPageModel => ({ ...model, shownTok: model.tok });
/** Something is on its way that is not drawn yet (a birth): what was scheduled is void. */
export const notchVoid = (model: NotchPageModel): NotchPageModel => ({ ...model, tok: model.tok + 1 });

// --- a line put up ---

export interface NotchLineTiming {
  /** What is left of a result's time or a fuse, in ms. */
  left: number;
  total: number;
  /** A fuse with enough left that this page can vouch for having shown it burn (NOTCH_FUSE_SEEN_MS). */
  seen: boolean;
  /** A fuse that was taken back on this page, drawn again: it stays taken back. */
  undone: boolean;
}

/**
 * A line is put on the notch. `same`: it is the line that is already up,
 * drawn again, and its time goes on from where the page has it. Otherwise
 * what is left is as the brain says (a page that came up in the middle of
 * it), or all of it.
 */
export function notchLineUp(model: NotchPageModel, line: NotchLine, now: number, same = false): { model: NotchPageModel; timing: NotchLineTiming } {
  const timed = line.kind === 'say' || line.kind === 'send' ? line : null;
  const own = same && timed && model.due?.id === line.id ? Math.max(0, model.due.at - now) : undefined;
  const total = timed ? Math.max(0, timed.ms) : 0;
  const left = Math.min(total, Math.max(0, own ?? timed?.left ?? total));
  // A fuse this page did not show from its start, with too little left for anybody to read it and press Esc,
  // was not seen to burn: the page cannot say it ran out.
  const seen = own !== undefined || timed?.left === undefined || left >= Math.min(total, NOTCH_FUSE_SEEN_MS);
  const undone = same && model.cur?.id === line.id && model.cur.undone;
  return {
    model: { ...model, line, cur: { id: line.id, done: false, undone }, due: null, drawn: model.drawn + 1 },
    timing: { left, total, seen, undone },
  };
}

/** A result, or a fuse that was lit, runs out `left` ms from now, unless the line is drawn again before. */
export function notchTimed(model: NotchPageModel, id: string, left: number, now: number): NotchPageModel {
  if (model.cur?.id !== id) return model;
  return { ...model, due: { id, at: now + left, tok: model.tok } };
}

/** The fuse of the send drawn as `drawn` was put up: from now on Esc takes it back. */
export const notchFuseUp = (model: NotchPageModel, drawn: number): NotchPageModel => (model.drawn === drawn ? { ...model, undoable: drawn } : model);

/** Back to the eyes. What the last drawing still had to do (a fuse lit after its paper folded away) is void with it. */
export const notchRested = (model: NotchPageModel): NotchPageModel => ({ ...model, line: null, cur: null, due: null, drawn: model.drawn + 1 });

/** The line that is up is answered: it takes nothing more. */
const settled = (model: NotchPageModel): NotchPageModel => (model.cur ? { ...model, cur: { ...model.cur, done: true } } : model);

/** Whether the line that is up can still be answered. */
const open = (model: NotchPageModel): boolean => model.cur !== null && !model.cur.done;

// --- answers ---

/** The answer to the line that is up, with when it was given and the run of the brain whose line it is. */
function answer(model: NotchPageModel, act: NotchAnswerAct, now: number, more: Partial<NotchPageAnswer> = {}): NotchPageOut[] {
  if (!model.cur) return [];
  return [{
    do: 'answer',
    answer: { type: 'answer', id: model.cur.id, act, since: notchSince(model, now), ...more, ...(model.brain ? { brain: model.brain } : {}) },
    once: model.line?.after?.[act] === 'hold',
  }];
}

/** What the answer `act` does to the line, as the brain wrote it into the line: it goes, it is held, or it stays. */
function ended(model: NotchPageModel, act: NotchAnswerAct): NotchPageStep {
  const what = model.line?.after?.[act];
  if (what === 'rest') return { model: notchRested(model), out: [{ do: 'rest' }] };
  if (what === 'hold') return { model: settled(model), out: [{ do: 'settle' }] };
  return { model, out: [] };
}

/** An answer and what it does to the line. `before` and `between` are said first and between the two. */
function answered(model: NotchPageModel, act: NotchAnswerAct, now: number, more: Partial<NotchPageAnswer> = {}, before: NotchPageOut[] = [], between: NotchPageOut[] = []): NotchPageStep {
  const end = ended(model, act);
  return { model: end.model, out: [...before, ...answer(model, act, now, more), ...between, ...end.out] };
}

/**
 * What became of an answer the brain never said it has. If it is the one
 * that held the line that is up, the line can be answered again: the brain
 * takes a number once, so what comes of that cannot count beside the first.
 * Not a fuse this page said ran out: whether or not the brain had it, it is
 * not to be taken back now. Either way the brain is asked what the notch shows.
 */
export function notchLost(model: NotchPageModel, given: Omit<NotchPageAnswer, 'n'>): NotchPageStep {
  const out: NotchPageOut[] = [];
  let next = model;
  if (model.cur && model.cur.done && model.cur.id === given.id && model.line?.after?.[given.act] === 'hold' && given.act !== 'done') {
    next = { ...model, cur: { ...model.cur, done: false } };
    out.push({ do: 'reopen' });
  }
  out.push({ do: 'outOfStep', what: `no word that the brain has the ${given.act}` });
  return { model: next, out };
}

/** A line the brain holds answered is answered here. True when it is the line that is up and was not yet. */
export const notchHeldNow = (model: NotchPageModel, line: NotchLine): boolean =>
  line.held === true && model.cur !== null && model.cur.id === line.id && !model.cur.done;

/** The same, as a change to the model: a fuse on it burns no further. */
export function notchHeld(model: NotchPageModel, line: NotchLine): NotchPageModel {
  if (!notchHeldNow(model, line)) return model;
  return settled(line.kind === 'send' ? { ...model, due: null } : model);
}

// --- what the person did ---

/** One thing the person did, as ./input.ts and the drawing read it. */
export type NotchPageInput =
  /** A key from anywhere on the desktop, as the desktop app said it. */
  | { kind: 'key'; name: string }
  /** Enter, with the page's own keyboard, not on a button. */
  | { kind: 'enter' }
  /** Escape with the page's own keyboard. */
  | { kind: 'escape' }
  /** A click on the line's own yes. */
  | { kind: 'yes' }
  /** A click on the line's own Esc ("not now", "close", "undo"). */
  | { kind: 'no' }
  | { kind: 'pick'; option: string; index: number }
  /** A press outside everything the notch is made of. */
  | { kind: 'away' }
  /** Enter in the line's own field. */
  | { kind: 'submit' }
  /** Escape in the line's own field. */
  | { kind: 'field-esc' }
  | { kind: 'button'; button: string; row?: string }
  | { kind: 'go'; row: string }
  /**
   * A lit word was changed to `value`, one of its options. `typed`: the
   * person typed `value` into it, and it is the brain's to read: the word
   * stays as it is until the brain says what it read.
   */
  | { kind: 'word'; name: string; value: string; typed?: boolean }
  /** A click on the resting notch. */
  | { kind: 'open' };

/** Which side of the notch an app's things go to: the left for the apps that stood there in the prototype's dock. */
export const notchLeftOf = (src: string | undefined): boolean =>
  src !== undefined && ['desk', 'mail', 'sheets', 'pay', 'cal'].includes(src);

/** Yes to the line that is up, as each kind of line takes it. Null: the line has no yes (choices, a piece of work, a fuse). */
function yesTo(model: NotchPageModel, now: number, facts: NotchPageFacts): NotchPageStep | null {
  const l = model.line;
  if (!l || !model.cur) return null;
  // What a yes does to the line is the line's own rule: on most it is held, dimmed, for the brain; on one
  // that shows only Esc it is told and the line stays.
  const yes = (): NotchPageStep => answered(model, 'yes', now, {}, l.after?.yes === 'hold' ? [{ do: 'nod' }] : []);
  if (l.kind === 'say') return answered(model, 'yes', now);
  if (l.kind === 'offer') return l.options?.length ? null : yes();
  if (l.kind === 'sheet') {
    if (!l.yes) return null;
    const whole = l.gate?.whole;
    if (whole === undefined) return yes();
    // A sheet that must be seen whole: until its end has been on screen for a moment, the yes goes down a
    // page and answers nothing. The press that brought the end up is not the yes, nor a quick one behind it.
    const seenAt = facts.sheetSeenAt ?? null;
    if (seenAt !== null && now - seenAt >= whole) return yes();
    if (seenAt !== null) return { model, out: [] };
    return { model, out: [{ do: 'scrollSheet' }] };
  }
  if (l.kind === 'ask') {
    const text = facts.askText ?? '';
    if (!text || model.cur.done) return { model, out: [] };
    return answered(model, 'ask', now, { text }, [{ do: 'sfx', name: 'yes' }], [{ do: 'blurAsk' }]);
  }
  return null;
}

/** Choices have no yes: the row of them nods, to say "pick one". */
const nudge = (model: NotchPageModel, facts: NotchPageFacts): NotchPageStep => ({ model, out: facts.choices ? [{ do: 'nudge' }] : [] });

/** Esc on the line that is up, as each kind of line takes it. */
function escTo(model: NotchPageModel, now: number): NotchPageStep {
  const l = model.line;
  if (!l || !model.cur) return { model, out: [] };
  const turnedDown = (): NotchPageStep => answered(model, 'no', now, {}, [], [{ do: 'shake' }, { do: 'sfx', name: 'no' }]);
  switch (l.kind) {
    // Esc on a result is "seen": it goes, like yes.
    case 'say': return answered(model, 'done', now);
    case 'offer': return turnedDown();
    case 'sheet': return answered(model, 'no', now);
    // Once it was asked, it is answered: an Esc after that says nothing more for this line.
    case 'ask': return model.cur.done ? { model, out: [] } : answered(model, 'no', now);
    case 'work': return answered(model, 'stop', now, {}, [{ do: 'shake' }, { do: 'sfx', name: 'no' }]);
    case 'send': {
      // Taken back, for good on this page: should the line come to be answered again (the brain never said it
      // has the undo), Esc says the same undo again, and "it ran out" is never said after it. Not before the
      // fuse is lit (a sheet of paper that is still folding away): there is nothing to take back yet.
      if (model.undoable !== model.drawn) return { model, out: [] };
      const back = { ...model, cur: { ...model.cur, undone: true } };
      return answered(back, 'undo', now, {}, [{ do: 'unfuse' }, { do: 'shake' }, { do: 'sfx', name: 'no' }]);
    }
    default: return turnedDown();
  }
}

/**
 * What the person did, and what comes of it. `facts` is what only the page
 * could see at that moment.
 */
export function notchInput(model: NotchPageModel, input: NotchPageInput, now: number, facts: NotchPageFacts = {}): NotchPageStep {
  const none = { model, out: [] };
  switch (input.kind) {
    case 'key': {
      if (!model.born) return none;
      if (input.name === 'talk-start') return { model, out: [{ do: 'talk', held: true }] };
      // Let go, or ended by a slip: either way the keys are no longer held.
      if (input.name === 'talk-end' || input.name === 'talk-cancel') return { model, out: [{ do: 'talk', held: false }] };
      if (input.name === 'esc-twice') return { model, out: [{ do: 'shake' }, { do: 'sfx', name: 'no' }, { do: 'send', message: { type: 'stop' } }] };
      if (input.name === 'esc') {
        if (facts.picking) return { model, out: [{ do: 'closePick' }] };
        // Esc on a line is a no. One that came by itself takes none for its first moment, like a yes: the key
        // may have been on its way to the app in front.
        if (notchTooSoon(model, 'esc', now) || !open(model)) return none;
        return escTo(model, now);
      }
      if (input.name !== 'yes') return none;
      // Yes from the keys: to what is offered; with nothing offered, open up.
      if (!facts.shown) return none;
      // A line that only just appeared cannot be answered by keys already on their way down.
      if (notchTooSoon(model, 'key', now)) return none;
      if (!model.cur) return { model, out: [{ do: 'send', message: { type: 'open' } }] };
      if (model.cur.done) return none;
      // Something is typed into a word's field and not taken yet: the yes takes it, as Enter would. It does
      // not answer the line as it stood before the typing.
      if (facts.typed) return { model, out: [{ do: 'commit' }] };
      return yesTo(model, now, facts) ?? nudge(model, facts);
    }
    case 'escape':
      if (!open(model)) return none;
      if (facts.picking) return { model, out: [{ do: 'closePick' }] };
      return notchTooSoon(model, 'esc', now) ? none : escTo(model, now);
    case 'enter':
      if (!open(model) || notchTooSoon(model, 'key', now)) return none;
      return yesTo(model, now, facts) ?? none;
    case 'yes':
      // A click on the line's own yes is not an answer when it cannot have been meant for this line.
      if (!open(model) || notchTooSoon(model, 'click', now)) return none;
      return yesTo(model, now, facts) ?? none;
    case 'no':
      return open(model) ? escTo(model, now) : none;
    case 'pick':
      if (!model.cur || model.cur.done || notchTooSoon(model, 'click', now)) return none;
      return answered(model, 'pick', now, { option: input.option, index: input.index }, [{ do: 'nod' }]);
    case 'away': {
      if (!model.born) return none;
      const out: NotchPageOut[] = facts.picking ? [{ do: 'closePick' }] : [];
      // What a press elsewhere is, is the brain's to say (`away`, written into the line). And nothing is, in
      // its first moment: the press was on its way before the line was there.
      if (model.line?.away !== 'no' || notchTooSoon(model, 'key', now) || !open(model)) return { model, out };
      const step = escTo(model, now);
      return { model: step.model, out: [...out, ...step.out] };
    }
    case 'submit':
      return model.line?.kind === 'ask' && model.cur && !model.cur.done ? yesTo(model, now, facts) ?? none : none;
    case 'field-esc': {
      const out: NotchPageOut[] = [{ do: 'blurAsk' }];
      if (!model.cur) return { model, out };
      const step = escTo(model, now);
      return { model: step.model, out: [...out, ...step.out] };
    }
    case 'button':
      return open(model) ? { model, out: answer(model, 'button', now, input.row === undefined ? { button: input.button } : { button: input.button, row: input.row }) } : none;
    case 'go':
      return open(model) ? { model, out: answer(model, 'go', now, { row: input.row }) } : none;
    case 'word': {
      // The word stands as it was changed, whether or not the line can still be answered: drawn again, it is drawn so.
      const next = model.line && !input.typed ? { ...model, line: notchWithWord(model.line, input.name, input.value) } : model;
      // The brain gives an offer its time again when a word of it is changed.
      if (!open(model)) return { model: next, out: [] };
      return { model: next, out: answer(next, 'word', now, input.typed ? { word: input.name, text: input.value } : { word: input.name, value: input.value }) };
    }
    case 'open':
      return facts.resting && model.born && facts.shown ? { model, out: [{ do: 'send', message: { type: 'open' } }] } : none;
  }
}

/**
 * Time passed. A result or a lit fuse whose time is up runs out, unless what
 * was scheduled for it was made void by a drawing since.
 */
export function notchTick(model: NotchPageModel, now: number, facts: NotchPageFacts = {}): NotchPageStep {
  const due = model.due;
  const l = model.line;
  if (!due || due.fired || due.tok !== model.tok || now < due.at || !l || l.id !== due.id || !model.cur || model.cur.id !== due.id) return { model, out: [] };
  // Kept, as fired: drawn again, what is left of it is nothing, not all of it.
  const timed = { ...model, due: { ...due, fired: true as const } };
  if (l.kind === 'say') return answered(timed, 'done', now);
  if (l.kind !== 'send' || model.cur.done || model.cur.undone) return { model: timed, out: [] };
  if (l.blocks?.length) {
    // The fuse ran out, and that is said. Whether the letter was seen is said beside it, and only when it
    // was. Without that word the brain sends nothing, and says so. Nothing is left to take back.
    const vouch = facts.letterSeen === true;
    return answered(timed, 'done', now, vouch ? { seen: true } : {}, [{ do: 'unfuse' }, ...(vouch ? [{ do: 'depart', left: notchLeftOf(l.src) } as const] : []), { do: 'clearHint' }]);
  }
  // It leaves along the edge, toward where it is going: to the side its app is on, and to the right when it goes to a person.
  return answered(timed, 'done', now, {}, [{ do: 'unfuse' }, { do: 'depart', left: notchLeftOf(l.src) }, { do: 'clearHint' }]);
}

/** When `notchTick` is next worth asking, or null. */
export const notchWakeAt = (model: NotchPageModel): number | null => (model.due && !model.due.fired && model.due.tok === model.tok ? model.due.at : null);

// --- what the brain said ---

/** A word or two on a message that could not be read, for the log: what it said it was, never what was in it. */
export function notchNamed(raw: unknown): string {
  const word = (value: unknown): string => (typeof value === 'string' ? value.replace(/[^\w-]/g, '').slice(0, 20) : '');
  const m = typeof raw === 'object' && raw !== null ? raw as { type?: unknown; line?: { kind?: unknown } | null } : {};
  return [word(m.type) || 'not a message', word(m.line?.kind)].filter(Boolean).join(' ');
}

/**
 * A message from the brain. It is read whole before anything changes: one
 * that is not a message is dropped, and the notch stays as it was. One of a
 * kind this page has never heard of (a newer brain) is passed over without a
 * word. `still`: motion is reduced, and a line does not come in along the edge.
 */
export function notchMessage(model: NotchPageModel, raw: unknown, still = false): NotchPageStep {
  const none = { model, out: [] };
  const read = readNotchToPage(raw);
  if (!read.message) {
    // A brain of another version: nothing of what it says is this page's to draw.
    if (read.why === 'version') return { model, out: [{ do: 'version', v: read.v }] };
    // A kind this page has never heard of. If it was the next in the row, it is counted as read.
    if (read.why === 'unknown') return model.born && read.seq === model.seq + 1 ? { model: { ...model, seq: read.seq }, out: [] } : none;
    // It cannot be read. If it was numbered it is counted as read all the same, so that the next is not taken for a gap.
    const seq = model.born && read.seq !== undefined && read.seq > model.seq ? read.seq : model.seq;
    return { model: { ...model, seq }, out: [{ do: 'outOfStep', what: notchNamed(raw) }] };
  }
  const message = read.message;
  switch (message.type) {
    case 'ack':
      return { model, out: [{ do: 'ack', n: message.n, took: message.took, ...(message.unread ? { unread: true } : {}) }] };
    case 'refuse':
      // The brain takes nothing from this page. In another version: see above. In this one, it only does not
      // know the page (it started again, or the connection did): it is told hello.
      return { model, out: [message.v !== NOTCH_PROTOCOL_VERSION ? { do: 'version', v: message.v } : { do: 'outOfStep', what: 'the brain does not know this page', refused: true }] };
    case 'state': {
      // The same run of the brain, and a number this page has read: a copy that came twice, or late.
      const other = message.brain !== model.brain;
      if (!other && message.seq <= model.seq) return none;
      const out: NotchPageOut[] = [];
      if (read.lineLost) out.push({ do: 'outOfStep', what: notchNamed(raw) });
      // Another run of the brain: nothing held from the one before stands. Its lines are other lines, whatever
      // they are called, and what was said to it will not be answered.
      if (other && model.brain) out.push({ do: 'clearAnswers' });
      const fresh = other && model.brain !== '';
      let next: NotchPageModel = {
        ...model,
        brain: message.brain,
        seq: message.seq,
        count: Math.max(0, Math.floor(Number(message.count) || 0)),
        face: message.face && (NOTCH_MOODS as readonly string[]).includes(message.face) ? message.face : 'idle',
        where: notchWhereApp(message.where),
      };
      // An eye that was being kept is still kept, and the sound is the person's own choice: the brain keeps both.
      out.push({ do: 'whole', eye: message.eye === true, sound: message.sound === true });
      if (!fresh && next.cur && next.line && (read.lineLost || message.line?.id === next.line.id)) {
        // The line this page already shows, told again (the page said hello again): it stays as it is. Drawn
        // again it forgot that it was answered. Only, if the brain holds it answered, it is answered here too.
        if (message.line?.held) out.push({ do: 'held', line: message.line });
      } else if (message.line) {
        out.push({ do: 'appear' }, { do: 'draw', line: message.line, restore: false, instant: true });
      } else if (message.born && !model.born) {
        out.push({ do: 'rest', instant: true }, { do: 'birth', born: message.born });
      } else {
        out.push({ do: 'appear' }, { do: 'rest', instant: true });
      }
      next = { ...next, born: true };
      // What waits on the edge and the mouth are kept by the brain too: a page that comes back has them.
      out.push({ do: 'park', park: message.park ?? 0 }, { do: 'mouth', mouth: message.mouth ?? 'shut', whole: true }, { do: 'sync' }, { do: 'beat' });
      return { model: next, out };
    }
    case 'patch':
    case 'effect': {
      // Nothing is drawn before the brain has said the whole of it once.
      if (!model.born) return none;
      // A number this page has read: a copy. One that is not the next: something before it was lost on the
      // way, and the brain is asked for the whole. What did come is still taken.
      if (message.seq <= model.seq) return none;
      const out: NotchPageOut[] = message.seq !== model.seq + 1 ? [{ do: 'outOfStep', what: `${message.type} ${message.seq} came after ${model.seq}` }] : [];
      let next: NotchPageModel = { ...model, seq: message.seq };
      if (message.type === 'effect') {
        const { type: _type, seq: _seq, ...effect } = message;
        return { model: next, out: [...out, { do: 'effect', effect }] };
      }
      const { type: _type, seq: _seq, line, edit, ...kept } = message;
      if (kept.count !== undefined) next = { ...next, count: Math.max(0, Math.floor(Number(kept.count) || 0)) };
      if (kept.face !== undefined && (NOTCH_MOODS as readonly string[]).includes(kept.face)) next = { ...next, face: kept.face };
      if (kept.where !== undefined) next = { ...next, where: notchWhereApp(kept.where) };
      out.push({ do: 'kept', kept });
      if (line === null) out.push({ do: 'rest' });
      else if (line) {
        if (line.arrive && (NOTCH_ARRIVALS as readonly string[]).includes(line.arrive) && !still) {
          const n = (next.arriving?.n ?? 0) + 1;
          next = { ...notchVoid(next), arriving: { line, n } };
          out.push({ do: 'arrive', line, n });
        } else out.push({ do: 'draw', line, restore: true, instant: false });
      }
      // For a line that is still coming in along the edge, it lands as it now is.
      if (edit) {
        if (next.arriving && next.arriving.line.id === edit.id) next = { ...next, arriving: { ...next.arriving, line: notchAmended(next.arriving.line, edit) } };
        else out.push({ do: 'edit', edit });
      }
      return { model: next, out };
    }
    default:
      return none;
  }
}

/** A line that came in along the edge has landed: it is drawn, if it is still the one on its way and nothing was drawn since. */
export function notchArrived(model: NotchPageModel, n: number, tok: number): NotchPageStep {
  const arriving = model.arriving;
  if (!arriving || arriving.n !== n) return { model, out: [] };
  const next = { ...model, arriving: null };
  return { model: next, out: tok === model.tok ? [{ do: 'draw', line: arriving.line, restore: true, instant: false }] : [] };
}

// --- a line changed ---

/** A line that is not drawn yet, changed as `notchEdited` changes one that is. */
export function notchAmended(line: NotchLine, m: NotchEdit): NotchLine {
  const l = { ...line } as NotchLine;
  if (m.say) l.say = m.say;
  if (m.done !== undefined && l.kind === 'work') l.done = m.done;
  if (l.kind === 'listen') { if (m.heard !== undefined) l.heard = m.heard; if (m.over) l.over = true; }
  if (m.blocks && (l.kind === 'sheet' || l.kind === 'ask')) l.blocks = m.blocks;
  if (m.away) l.away = m.away;
  return l;
}

/** The line that is up, changed in place by the brain. Null when the change is for another line. */
export function notchEdited(model: NotchPageModel, m: NotchEdit): NotchPageModel | null {
  const l = model.line;
  if (!l || l.id !== m.id) return null;
  return { ...model, line: notchAmended(l, m) };
}

/** A lit word set to `value` wherever it stands in the line, with the value among its options. */
export function notchWithWord(line: NotchLine, name: string, value: string): NotchLine {
  let changed = false;
  const parts = (list: readonly NotchPart[] | undefined): NotchPart[] | undefined => {
    if (!list) return undefined;
    return list.map((part) => {
      if (typeof part !== 'object' || !('word' in part) || part.word.name !== name) return part;
      changed = true;
      const options = part.word.options.includes(value) ? part.word.options : [...part.word.options, value];
      return { word: { ...part.word, value, options } };
    });
  };
  const block = (b: NotchBlock): NotchBlock => {
    if (b.kind === 'row' || b.kind === 'note') return { ...b, say: parts(b.say) ?? b.say } as NotchBlock;
    if (b.kind === 'paper') return { ...b, to: parts(b.to) ?? b.to, lines: b.lines.map((one) => parts(one) ?? one) } as NotchBlock;
    return b;
  };
  const next = { ...line, say: parts(line.say) ?? line.say } as NotchLine;
  if ('blocks' in next && Array.isArray(next.blocks)) (next as { blocks: NotchBlock[] }).blocks = next.blocks.map(block);
  return changed ? next : line;
}

// --- what follows from the line that is up ---

/**
 * Whether Esc is to be taken from the app in front, and if not yet, in how
 * many ms to ask again. A piece of work is on the notch for as long as it
 * takes, and the person goes back to their own app meanwhile: Esc there is
 * theirs, taken for the work only while they point at the notch. A line that
 * came by itself takes no Esc in its first moment.
 */
export function notchWantsEsc(model: NotchPageModel, now: number, facts: { alive: boolean; work: boolean; pointerOnNotch: boolean; picking: boolean }): { want: boolean; again: number | null } {
  const up = open(model) && (!facts.work || facts.pointerOnNotch);
  const early = up && notchTooSoon(model, 'esc', now);
  const again = early ? Math.max(0, (model.line?.gate?.esc ?? 0) - notchSince(model, now)) + 20 : null;
  return { want: facts.alive && model.born && ((up && !early) || facts.picking), again };
}

/** Whether a question that waits for a yes or a no is up: which lines do is the brain's to say (`asking`). */
export const notchAsking = (model: NotchPageModel, alive: boolean): boolean =>
  alive && model.born && open(model) && model.line?.asking === true;

/** The offer whose hand the brain is to be told of: one that folds, up and not answered. */
export function notchHandLine(model: NotchPageModel, alive: boolean): NotchLine | null {
  const l = model.line;
  return alive && model.born && open(model) && l && l.kind === 'offer' && (l.fold ?? 0) > 0 ? l : null;
}
