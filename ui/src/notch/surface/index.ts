/**
 * The notch's surface: it draws what the brain says and reports what the
 * person did. It decides nothing. The brain's messages come in through
 * `receive`; the person's answers go out through `send`.
 *
 * It is the prototype's surface (notch-poc v15) with its scripted world cut
 * away: `show` below is the prototype's `show`, and each kind of line maps to
 * one of its `tell`, `propose`, `sheet`, `work` and `sending`.
 */
import { NOTCH_NAME } from '../../../../src/notch/name.ts';
import {
  NOTCH_APPS, NOTCH_ARRIVALS, NOTCH_AT_EVERY_MS, NOTCH_FUSE_SEEN_MS, NOTCH_HAND_AGAIN_MS, NOTCH_MOODS, NOTCH_PROTOCOL_VERSION, notchWhereApp,
  readNotchToPage,
} from '../../../../src/notch/protocol.ts';
import type {
  NotchAnswerAct, NotchApp, NotchBlock, NotchEdit, NotchEffect, NotchFromPage, NotchKept, NotchLine, NotchMood, NotchMouth, NotchPart,
  NotchToPage, NotchWhereApp, NotchWord,
} from '../../../../src/notch/protocol.ts';
import { createNotchAnswers, type NotchPageAnswer } from './answers.ts';
import { renderBlocks } from './blocks.ts';
import { SKELETON, btn, createFrames, createTimers, el, need, realNotchPageClock, type NotchPageClock } from './dom.ts';
import { createEdge } from './edge.ts';
import { createEyes } from './eyes.ts';
import { duo, mkHint, setKeyPairs, type Hint } from './hints.ts';
import { ICON } from './icons.ts';
import { flattenPath, hanging, inside, type Point } from './outline.ts';
import { createSentence } from './sentence.ts';
import { OX, WK, createShape } from './shape.ts';
import { createSounds } from './sounds.ts';

export interface NotchSurfaceOptions {
  /** Ask the desktop app for the keyboard (true) or give it back (false). */
  focus?: (take: boolean) => void;
  /** Force reduced motion on or off; default follows prefers-reduced-motion. */
  reducedMotion?: boolean;
  /** The time the surface goes by: when a line was drawn, and when what it scheduled is due. The browser's when not given. */
  clock?: NotchPageClock;
}

export interface NotchSurface {
  /** Everything the brain says goes in here. */
  receive(message: NotchToPage): void;
  /**
   * The silhouette as closed polygons in CSS px of the window: the notch's
   * body, shoulders included, and every bump on the top edge. `inset` moves
   * every polygon that many px inwards. Nothing is on screen: no polygons.
   */
  outlines(inset: number): [number, number][][];
  /** Called every animation frame in which the silhouette changed, and once when it settled. */
  onOutline(listener: (settled: boolean) => void): void;
  /** The pointer, anywhere on the screen, in this page's px; `down` is the main button. */
  pointer(x: number, y: number, down: boolean): void;
  /**
   * What the keys said, from anywhere on the desktop: the talk pair held and
   * let go, the yes pair tapped, Esc, Esc twice. Anything else is ignored.
   */
  key(name: string): void;
  /** Which keys the hints show (they are set per machine). */
  setPairs(pairs: unknown): void;
  /**
   * The camera housing of the display, in this page's px: how wide and how
   * tall. The notch draws itself round it. Anything that is not two sizes a
   * housing can have means there is none.
   */
  setHousing(w: unknown, h: unknown): void;
  /** Told whenever the notch starts or stops having something Esc would close. */
  onWantEsc(listener: (want: boolean) => void): void;
  /** Told whenever the notch starts or stops showing a question that waits for a yes or a no. */
  onAsking(listener: (asking: boolean) => void): void;
  /**
   * Told whenever the page is out of step with the brain, with a word or two
   * on how: something the brain said could not be read and was dropped (all
   * of it, or the line of a `state`), a message's number was not the next (one
   * before it was lost on the way), an answer was never acknowledged, or the
   * brain says it does not know this page. The notch may no longer be what
   * the brain believes it shows, and the brain is to be asked for the whole
   * of it. Not told of a message that is well formed and of a kind this page
   * does not know.
   */
  onDropped(listener: (what: string) => void): void;
  /**
   * Told when the brain speaks another version of the messages than this
   * page (`v` is the brain's): by a `state` of that version, or by its
   * refusal of this page's hello. Nothing of what such a brain says is drawn.
   */
  onVersion(listener: (v: number) => void): void;
  /**
   * The page is of no use to this brain (another version, and loading it
   * again did not help): whatever is on the notch is taken off, Esc is given
   * back, and nothing more is drawn or said until a `state` of this page's
   * own version is read.
   */
  retire(): void;
  destroy(): void;
}

type Body = 'rest' | 'line' | 'choices' | 'sheet' | 'ask' | 'work';

/** What `show` draws: the prototype's argument, unchanged. */
interface View {
  body: Body;
  say?: readonly NotchPart[] | Node;
  hint?: Hint | Hint[] | null;
  opts?: { label: string; pick: () => void }[] | null;
  sheet?: Node | null;
  mood?: NotchMood;
  mark?: 'check' | 'fail' | '';
  who?: string;
  src?: NotchApp | '';
  /** The sheet's rows come in one after another. */
  stag?: boolean;
  /**
   * Yes is the pair of keys, as on a line, though this is a sheet: it asks for
   * a decision and has no text field, so the notch does not have the keyboard
   * and Enter would go to the app in front.
   */
  pairYes?: boolean;
}

/** The line on the notch and what the person can do with it. */
interface Current {
  id: string;
  onYes?: () => void;
  onEsc?: () => void;
  /** Answered: nothing more can be done with it until the brain says what next. */
  done?: boolean;
  /** A fuse that was taken back. Whatever comes after, this page never says of it that it ran out. */
  undone?: boolean;
}

const DEFAULT_MOOD: Record<Exclude<Body, 'rest'>, NotchMood> = { line: 'look', choices: 'look', sheet: 'read', ask: 'listen', work: 'work' };

/** How long a look that was asked for at rest is worn before the notch goes back to the face it rests with. */
export const NOTCH_PASSING_MOOD_MS = 4000;

/** The largest housing the notch draws itself round, in px. A MacBook's is about 200 by 40. */
export const NOTCH_HOUSING_MAX = { w: 400, h: 80 };

/** A housing as the desktop app told it, or null: both sizes, whole, and ones a housing can have. */
export function notchHousing(w: unknown, h: unknown): { w: number; h: number } | null {
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 1 || h < 1 || w > NOTCH_HOUSING_MAX.w || h > NOTCH_HOUSING_MAX.h) return null;
  return { w: Math.round(w), h: Math.round(h) };
}

export function createNotchSurface(
  root: HTMLElement,
  send: (message: NotchFromPage) => void,
  options: NotchSurfaceOptions = {},
): NotchSurface {
  const reduce = options.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const askFocus = options.focus ?? (() => {});
  root.classList.add('jarvis-notch');
  root.classList.toggle('notch-still', reduce);
  root.innerHTML = SKELETON;

  const wrap = need<HTMLElement>(root, '.wrap'), blob = need<SVGSVGElement>(root, '.blob'), notch = need<HTMLElement>(root, '.notch');
  const nin = need<HTMLElement>(root, '.nin'), lead = need<HTMLElement>(root, '.lead'), eyesEl = need<HTMLElement>(root, '.eyes');
  const iconEl = need<HTMLElement>(root, '.appicon'), badgeEl = need<HTMLElement>(root, '.badge');
  const sayEl = need<HTMLElement>(root, '.say'), hintEl = need<HTMLElement>(root, '.hint');
  // Hebrew and Arabic read from the right. Each word of a line is a box of its own, and boxes are laid out
  // left to right unless the line is told to find its own direction: the words stood in the wrong order.
  sayEl.dir = 'auto';
  const pickEl = need<HTMLElement>(root, '.pick'), optsEl = need<HTMLElement>(root, '.opts'), sheetEl = need<HTMLElement>(root, '.sheet');
  const measure = need<HTMLElement>(root, '.measure'), lineSvg = need<SVGSVGElement>(root, '.line');

  const width = (): number => root.clientWidth || window.innerWidth;
  const listeners = new Set<(settled: boolean) => void>();
  let dirty = false, flushing = false, alive = true;
  const settled = (): boolean => !shape.running() && !edge.moving();
  const flush = (): void => {
    if (!dirty || !alive) return;
    dirty = false;
    const now = settled();
    for (const listener of listeners) listener(now);
  };
  // The silhouette changed. Inside a frame the report waits for the frame's
  // end, so everything that moved in it is in one report.
  const changed = (): void => {
    dirty = true;
    if (frames.inFrame() || flushing) return;
    flushing = true;
    queueMicrotask(() => { flushing = false; flush(); });
  };

  const clock = options.clock ?? realNotchPageClock;
  const timers = createTimers(clock);
  const frames = createFrames(flush);
  const sounds = createSounds();
  // The display's camera housing, when it has one (a MacBook's). Told by the desktop app.
  let cam: { w: number; h: number } | null = null;
  const shape = createShape({ wrap, notch, nin, measure, blob, frames, reduce, width, changed, housing: () => cam });
  const eyes = createEyes({ nin, eyes: eyesEl, shape, timers, reduce, busy: () => cur !== null, rest: () => restMood });
  const edge = createEdge({ line: lineSvg, blob, nin, frames, timers, shape, eyes, reduce, width, changed });

  let line: NotchLine | null = null;
  let cur: Current | null = null;
  let count = 0, shownCount = 0;
  /** Every `show` makes whatever was scheduled for the line before it void. */
  let tok = 0, shownAt = 0;
  /** What `tok` was when the last thing was drawn. Not `tok` any more: what was scheduled for it is void. */
  let shownTok = 0;
  /**
   * When the line that is up runs out, for a result and a burning fuse: so
   * that drawn again in the middle (the keys of the machine changed, the page
   * said hello again) it goes on from where it was, and does not start again.
   */
  let due: { id: string; at: number } | null = null;
  /**
   * The run of the brain this page was last told the whole by, and the number
   * of the last message it read from it. A message whose number is not the
   * next was not the next the brain sent.
   */
  let brain = '', seq = -1;
  /** A look given at rest goes back to the resting face after this long. */
  let moodBack = 0;
  let restMood: NotchMood = 'idle';
  /** The app in front on this machine, as the brain last said. */
  let front: NotchWhereApp | null = null;
  let born = false;

  // Esc is taken from the app in front only while it would do something here.
  const escListeners = new Set<(want: boolean) => void>();
  let wantedEsc = false;
  let escLater = 0;
  /** Whether the pointer is on the notch itself: on its body or on a sheet. */
  let pointerOnNotch = false;
  const syncEsc = (): void => {
    // A piece of work is on the notch for as long as it takes, which can be
    // minutes, and the person goes back to their own app meanwhile. Esc there
    // is theirs: it is taken for the work (it stops it) only while they point
    // at the notch. The stop hint can also be clicked.
    const up = cur !== null && !cur.done && (nin.dataset.body !== 'work' || pointerOnNotch);
    // A line that came by itself takes no Esc in its first moment (the key may be on its way to the app in
    // front). It is not taken from that app either, then: it reached nobody.
    const early = up && escTooSoon();
    if (early && !escLater) escLater = timers.after(Math.max(0, (line?.gate?.esc ?? 0) - sinceShown()) + 20, () => { escLater = 0; syncEsc(); });
    const want = alive && born && ((up && !early) || sentence.picking());
    syncAsking();
    syncHand();
    if (want === wantedEsc) return;
    wantedEsc = want;
    for (const listener of escListeners) listener(want);
  };

  // A question that waits for a yes or a no: an approval (a line with a yes, or
  // a sheet that stays and has a yes), choices, or a question back. The window
  // is told, so that it does not stay hidden behind a fullscreen video with a
  // task standing still on it. A sheet that stays only to be read (a long
  // answer) is not a question: it must not come over a film.
  const askingListeners = new Set<(asking: boolean) => void>();
  let wasAsking = false;
  function syncAsking(): void {
    // Which lines wait for the person is the brain's to say (`asking`, written into the line): an offer, a
    // question, a sheet that stays for a yes, a letter under its fuse and the work that leads into it.
    const asking = alive && born && cur !== null && !cur.done && line?.asking === true;
    if (asking === wasAsking) return;
    wasAsking = asking;
    for (const listener of askingListeners) listener(asking);
  }

  const later = (ms: number, fn: () => void): number => { const mine = tok; return timers.after(ms, () => { if (mine === tok) fn(); }); };
  /** Said to listeners when the page is out of step with the brain: it is to be asked for the whole again. */
  const dropListeners = new Set<(what: string) => void>();
  const outOfStep = (what: string): void => { for (const listener of dropListeners) listener(what); };
  /** How long ago the line that is up was drawn, in whole ms. */
  const sinceShown = (): number => Math.max(0, Math.round(clock.now() - shownAt));

  const answers = createNotchAnswers({
    send,
    timers,
    // The brain never said it has it. If it is the answer that dimmed the line that is up, the line can be
    // answered again (it was dimmed for good, and Esc and yes did nothing); the brain takes a number once,
    // so the answer that comes of that cannot count beside the first. Then the brain is asked what the
    // notch shows: it may have gone on without this page.
    lost: (given) => {
      if (!alive) return;
      if (cur && cur.done && cur.id === given.id && line?.after?.[given.act] === 'hold') reopen();
      outOfStep(`no word that the brain has the ${given.act}`);
    },
    // It came for a line the brain no longer shows: this page is behind. It says how far it has read, and
    // the brain tells it the whole again if it sent more than that.
    late: () => { if (alive && born) send({ type: 'at', seq }); },
  });
  /**
   * Says what the person did with the line that is up, with how long after
   * it was drawn. What that does to the line is `ended`, and is the line's
   * own rule.
   */
  const answer = (act: NotchAnswerAct, more: Partial<NotchPageAnswer> = {}): void => {
    if (cur) answers.say({ type: 'answer', id: cur.id, act, since: sinceShown(), ...more }, line?.after?.[act] === 'hold');
  };
  /** Answered: it stays as it is, dimmed, until the brain says what comes next. */
  const settle = (): void => {
    if (cur) cur.done = true;
    nin.classList.add('answered');
    syncEsc();
  };
  /** A line whose answer the brain never had can be answered again. */
  const reopen = (): void => {
    if (!cur) return;
    cur.done = false;
    nin.classList.remove('answered');
    syncEsc();
  };
  /** What the answer `act` does to the line, as the brain wrote it into the line: it goes, it is held, or it stays as it is. */
  const ended = (act: NotchAnswerAct): void => {
    const what = line?.after?.[act];
    if (what === 'rest') rest();
    else if (what === 'hold') settle();
  };

  // A hand on the line: the pointer is on the notch (as the desktop app tells it too: hover does not reach a
  // page in a window that is never the active one on every system), a field is being typed in, or a word's
  // choices are open. Not "whatever was clicked last": a click on the eyes or on a lit word left that button
  // the focused element for good. The page only says so. Whether an offer folds is the brain's.
  const handNow = (): boolean => {
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && nin.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    return wrap.matches(':hover') || pointerOnNotch || typing || sentence.picking();
  };
  let handFor = '', handSaid = false, handTimer = 0;
  function syncHand(): void {
    const l = alive && born && cur && !cur.done && line && line.kind === 'offer' && (line.fold ?? 0) > 0 ? line : null;
    if (!l || l.id !== handFor) {
      // Another line, or none: what was said of the last one went with it (the brain forgets it with the line).
      timers.cancel(handTimer);
      handTimer = 0;
      handSaid = false;
      handFor = l?.id ?? '';
    }
    if (!l) return;
    const on = handNow();
    if (on !== handSaid) {
      handSaid = on;
      send({ type: 'hand', id: l.id, on });
    }
    // Said again while it is there, so that one saying lost on the way is not a fold under a hand; and
    // looked at again, so that a hand that left without a sign is found gone.
    if (!handTimer) handTimer = timers.after(NOTCH_HAND_AGAIN_MS, () => {
      handTimer = 0;
      if (handSaid && handFor && handNow()) send({ type: 'hand', id: handFor, on: true });
      syncHand();
    });
  }

  // How far this page has read, said every so often for as long as it is up: the last thing the brain said
  // may be the one that was lost, and no gap shows until the next comes.
  let beat = 0;
  function startBeat(): void {
    if (beat) return;
    beat = timers.after(NOTCH_AT_EVERY_MS, () => {
      beat = 0;
      if (!alive || !born) return;
      send({ type: 'at', seq });
      startBeat();
    });
  }

  const sentence = createSentence({
    nin, pick: pickEl, opts: optsEl, sheet: sheetEl,
    refit: () => { shape.fit(false, true); more(); syncEsc(); },
    changed: (word: NotchWord, value: string, button: HTMLElement) => {
      // The eyes go to the word that changed.
      const r = button.getBoundingClientRect();
      eyes.gaze(r.left + r.width / 2, r.top + 8);
      // The brain gives an offer its time again when a word of it is changed.
      if (cur && !cur.done) answer('word', { word: word.name, value });
    },
    refused: () => { eyes.gesture('shake'); sounds.sfx('no'); },
    focus: askFocus,
    after: (ms, fn) => timers.after(ms, fn),
    cancel: (id) => timers.cancel(id),
  });

  /** The old sentence fades where it stood, so the new one never jumps in over it. */
  function ghost(): void {
    if (reduce || !sayEl.firstChild || sayEl.querySelector('input, .voice')) return;
    const g = sayEl.cloneNode(true) as HTMLElement;
    g.className = 'say ghost';
    g.removeAttribute('aria-live');
    g.setAttribute('aria-hidden', 'true');
    const r = sayEl.getBoundingClientRect(), cs = getComputedStyle(sayEl);
    g.style.left = sayEl.offsetLeft + 'px';
    g.style.top = sayEl.offsetTop + 'px';
    g.style.width = Math.ceil(r.width) + 1 + 'px';
    g.style.fontWeight = cs.fontWeight;
    g.style.color = cs.color;
    if (r.height < 30) g.style.whiteSpace = 'nowrap';
    sayEl.parentNode?.append(g);
    timers.after(230, () => g.remove());
  }

  function fadeOut(elm: HTMLElement): void {
    if (reduce || !elm.firstChild || elm.querySelector('input')) return;
    const g = elm.cloneNode(true) as HTMLElement;
    g.classList.add('ghostly');
    g.classList.remove('stag', 'more');
    g.setAttribute('aria-hidden', 'true');
    g.style.top = elm.offsetTop + 'px';
    g.style.left = elm.offsetLeft + 'px';
    g.style.width = elm.offsetWidth + 'px';
    elm.parentNode?.append(g);
    timers.after(170, () => g.remove());
  }

  /** Two clicks closer together than this are one double click. */
  const DOUBLE_CLICK_MS = 500;
  /** Whether the end of the sheet is on screen now. */
  const sheetAtEnd = (): boolean => sheetEl.scrollTop + sheetEl.clientHeight >= sheetEl.scrollHeight - 6;
  /** Whether the end of the sheet that is up has been on screen at some moment, and since when. */
  let sheetSeen = false;
  let sheetSeenAt = 0;
  const sawSheetEnd = (): void => { if (!sheetSeen) { sheetSeen = true; sheetSeenAt = clock.now(); } };

  /**
   * Whether this page says of itself that it is not shown. Not every window that is hidden tells its
   * page (on Windows a hidden notch still reads "visible"), so this can only ever take a yes away.
   */
  const outOfSight = (): boolean => { try { return document.visibilityState === 'hidden'; } catch { return false; } };
  /** The letter under a fuse that was out of sight at some moment while it burnt: this page does not vouch for it. */
  let unseenLetter = '';
  const onVisibility = (): void => { if (outOfSight() && line?.kind === 'send' && line.blocks?.length) unseenLetter = line.id; };

  /** A sheet with more below fades at its lower edge. */
  function more(): void {
    requestAnimationFrame(() => {
      if (!alive) return;
      const end = sheetAtEnd();
      if (end) sawSheetEnd();
      sheetEl.classList.toggle('more', !end);
    });
  }

  /**
   * Whether a yes would land too soon after the line was drawn. How long
   * that is, is written into the line by the brain (`gate.dead`): a moment
   * for any line, because the key may already have been on its way down, and
   * longer for a line that came by itself, because the person may be in the
   * middle of a yes to something else, or of a shortcut that ends like one.
   * Only the page can count it: from when it drew the line.
   */
  const tooSoon = (): boolean => clock.now() - shownAt < (line?.gate?.dead ?? 0);
  /** Whether an Esc, or a click on a yes or a choice, would land too soon: on a line that came by itself, in its first moment (`gate.esc`). */
  const escTooSoon = (): boolean => clock.now() - shownAt < (line?.gate?.esc ?? 0);

  /** When the last two clicks on the notch came. */
  let clickAt = 0;
  let clickBefore = 0;
  const noteClick = (): void => { clickBefore = clickAt; clickAt = clock.now(); };
  /**
   * Whether a click on a yes or on a choice cannot have been meant for the
   * line that is up. Two cases. The line came by itself a moment ago: the
   * pointer was already on its way to what was there before, as a key would
   * have been (the same 0.7 s). Or the click is the second of two quick ones
   * and the first was made before this line was shown: a double click, whose
   * second half lands on whatever the first half brought up (the yes of a
   * request, straight after the yes of "Read it?").
   */
  const clickTooSoon = (): boolean =>
    escTooSoon() || (clickBefore > 0 && clickBefore < shownAt && clickAt - clickBefore < DOUBLE_CLICK_MS);

  function paintCount(body: Body): void {
    const n = body === 'rest' ? count : 0;
    nin.dataset.wait = n ? 'count' : '';
    badgeEl.textContent = n ? String(n) : '';
    badgeEl.setAttribute('aria-label', n ? `${n} waiting for you` : '');
    if (body !== 'rest') return;
    // Something more waits than a moment ago: a ripple runs along the lip.
    if (n > shownCount) shape.morphPlay('ripple');
    shownCount = n;
  }

  function show(v: View, instant = false): void {
    tok++;
    shownAt = clock.now();
    wrap.classList.remove('fusing', 'talk');
    if (shape.N.mode === 'talk') { shape.N.tgt = null; shape.morphStop(); }
    sentence.reset();
    iconEl.classList.remove('from');
    nin.classList.remove('answered');
    nin.querySelectorAll('.ghost, .ghostly').forEach((g) => g.remove());
    if (!instant) {
      ghost();
      if (nin.dataset.body !== v.body || v.stag) { fadeOut(sheetEl); fadeOut(optsEl); }
      fadeOut(hintEl);
    }
    nin.dataset.body = v.body;
    wrap.dataset.body = v.body;
    nin.dataset.mark = v.mark ?? '';
    if (v.mark === 'check') sounds.sfx('done'); else if (v.mark === 'fail') sounds.sfx('fail');
    paintCount(v.body);

    const say = v.say ?? [];
    sayEl.replaceChildren(say instanceof Node ? say : sentence.nodes(say));
    const hints = v.hint ? (Array.isArray(v.hint) ? v.hint : [v.hint]) : [];
    // For a screen reader: what yes means, or what the choices are.
    if (!(say instanceof Node)) {
      const yes = hints.find((h) => !('beads' in h) && h.act && (h.cap ?? 'enter') === 'enter');
      const spoken = v.opts?.length ? 'Choices: ' + v.opts.map((o, i) => `${i + 1}, ${o.label}`).join('; ') + '.'
        : yes && !('beads' in yes) ? `Yes means ${yes.act}.` : '';
      if (spoken) sayEl.append(el('span', 'sr', ' ' + spoken));
    }
    // A click on the line's own yes or Esc takes the same moment as the keys do: a click that was on its way
    // to what was there before (a second click of a double click, a press meant for the app behind) is not an answer.
    // A click on the line's own yes is not an answer when it cannot have been meant for this line (`clickTooSoon`).
    const ctx = { body: v.pairYes ? 'line' : v.body, onYes: () => { if (cur && !cur.done && !clickTooSoon()) cur.onYes?.(); }, onEsc: () => { if (cur && !cur.done) cur.onEsc?.(); } };
    hintEl.replaceChildren(...hints.map((h) => mkHint(h, ctx)));
    optsEl.replaceChildren(...(v.opts ?? []).map((o, i) => {
      const b = btn('btn', null, o.pick);
      b.append(el('span', 'cap', String(i + 1)), o.label);
      return b;
    }));
    sheetEl.replaceChildren(...(v.sheet ? [v.sheet] : []));
    sheetEl.scrollTop = 0;
    sheetEl.classList.toggle('stag', !!v.stag);

    if (v.who) {
      // The first letter whole: a name that begins with an emoji is two halves to charAt, and one was drawn.
      iconEl.replaceChildren(el('span', 'who', [...v.who][0] ?? ''));
      nin.dataset.icon = '1';
    } else if (v.src && (NOTCH_APPS as readonly string[]).includes(v.src)) {
      iconEl.innerHTML = ICON[v.src];
      nin.dataset.icon = '1';
      iconEl.classList.add('from');
    } else if (v.body === 'rest' && restIcon()) {
      nin.dataset.icon = '1';
    } else {
      iconEl.replaceChildren();
      nin.dataset.icon = '0';
    }
    eyesEl.setAttribute('aria-label', v.body === 'rest' ? `Open ${NOTCH_NAME}` : NOTCH_NAME);
    eyes.setMood(v.mood ?? (v.body === 'rest' ? restMood : DEFAULT_MOOD[v.body]));
    // Where the text starts: options and choices line up under it.
    nin.style.setProperty('--tx', lead.offsetLeft + lead.offsetWidth + 10 + 'px');
    shape.fit(instant);
    more();
    syncEsc();
    shownTok = tok;
  }

  /**
   * At rest, the icon of the app in front sits beside the eyes: this is where
   * you are, and I am watching it. Not while the eyes are closed or turned
   * aside: then I am not watching, and say so by showing no app. The icon is
   * the app's own picture, drawn as a picture and never as markup. True when
   * one was drawn.
   */
  function restIcon(): boolean {
    const icon = front?.icon;
    if (!icon || restMood === 'closed' || restMood === 'away') return false;
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'sync';
    img.draggable = false;
    img.src = icon;
    iconEl.replaceChildren(img);
    return true;
  }

  /** The app in front changed, or the face did, while the notch rests: the icon follows. */
  function repaintRestIcon(): void {
    if (!born || cur) return;
    const had = nin.dataset.icon === '1';
    iconEl.classList.remove('from');
    if (restIcon()) nin.dataset.icon = '1';
    else { iconEl.replaceChildren(); nin.dataset.icon = '0'; }
    if (had !== (nin.dataset.icon === '1')) {
      nin.style.setProperty('--tx', lead.offsetLeft + lead.offsetWidth + 10 + 'px');
      shape.fit();
    }
  }

  function rest(instant = false): void {
    dropKeyboard();
    cur = null;
    line = null;
    due = null;
    show({ body: 'rest' }, instant);
  }

  let pressedAt = -1000, pressed = '';
  /** What of a map is on the screen now, for the line that is up: it is drawn again with more in it, not from nothing. */
  let mapKnown = new Set<string>(), mapFor = '';
  const blocksOf = (blocks: readonly NotchBlock[]): HTMLElement => renderBlocks(blocks, {
    known: mapKnown,
    still: reduce,
    plain: (parts) => sentence.plain(parts),
    button: (id, row) => {
      // A double click is one press: the second answer was kept for the next thing that waited on this line.
      const now = clock.now();
      const which = `${id}\n${row ?? ''}`;
      if (which === pressed && now - pressedAt < 400) return;
      pressed = which;
      pressedAt = now;
      if (cur && !cur.done) answer('button', row === undefined ? { button: id } : { button: id, row });
    },
    go: (row) => { if (cur && !cur.done) answer('go', { row }); },
  });

  const beads = (done: number, steps: number): void => {
    hintEl.querySelectorAll('.beads i').forEach((b, j) => {
      b.classList.toggle('on', j < done);
      b.classList.toggle('now', j === done && done < steps);
    });
    const counter = hintEl.querySelector('.count');
    if (counter) counter.textContent = `${Math.min(done, steps)}/${steps}`;
  };

  /**
   * A text field that is going away gives the keyboard back first. One that
   * is taken out of the page while it has the keyboard would keep it, and
   * whatever was typed next would go nowhere.
   */
  const dropKeyboard = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== nin && nin.contains(active)) active.blur();
  };

  /** What a line that has stopped listening offers: Esc, so that what was heard is not acted on. */
  const HEARD_HINT: Hint = { cap: 'esc', act: 'not this' };

  /** No: the eyes shake, and it goes. */
  const refuse = (): void => {
    answer('no');
    eyes.gesture('shake');
    sounds.sfx('no');
    ended('no');
  };

  /** Where in a sequence a line is, in small words after its keys: "step 3/11". */
  function stepNote(l: NotchLine, instant: boolean): void {
    if (typeof l.step !== 'string' || !l.step) return;
    hintEl.append(el('span', 'count', [...l.step].slice(0, 24).join('')));
    shape.fit(instant, true);
  }

  /**
   * Shows a line, and if it cannot be drawn (a block the page does not know,
   * a part that is not one) leaves the notch as it was: the line before it,
   * still answerable as itself. It used to be half replaced: the old line on
   * the screen, and the keys answering for the new one that nobody saw.
   */
  function drawLine(l: NotchLine, instant = false): void {
    // `live`: what the line that is up has scheduled still stands (a line on its way in along the edge has
    // already made it void).
    const before = { line, cur, due, tok, live: tok === shownTok };
    // Drawn anew, an answer to it is a new answer (./answers.ts).
    try { showLine(l, instant); answers.fresh(); } catch (error) {
      console.error('[notch] a line could not be drawn', error);
      line = before.line;
      cur = before.cur;
      due = before.due;
      if (!cur) { try { rest(true); } catch { /* nothing more can be done here */ } return; }
      // A draw that got as far as the screen has replaced some or all of the line that stays, and made void
      // what it had scheduled. A result then stayed up for ever, and the screen could show the line that
      // failed while the keys answered for the other. Then the line that stays is drawn again as it stands,
      // with what is left of its time. When nothing of it was touched it is left alone: drawing it again
      // would empty a field being typed in. (An offer's fold is the brain's now, and no draw can stop it.)
      if (tok === before.tok && before.live) return;
      try { again(); } catch { try { rest(true); } catch { /* nothing more can be done here */ } }
    }
  }

  /** Draws the line that is up again as it stands, unless it was answered: with what is left of its time, not all of it. */
  function again(): void {
    if (line && cur && !cur.done) showLine(structuredClone(line), true, true);
  }

  /**
   * `same` says this is the line that is already up, drawn again: its time
   * goes on from where the page has it, and does not start again.
   */
  function showLine(l: NotchLine, instant = false, same = false): void {
    // What is left of its time: by the page's own count when it is the line it already shows, or else as the
    // brain says (for a page that came up in the middle of it), or else all of it.
    const timed = l.kind === 'say' || l.kind === 'send' ? l : null;
    const own = same && timed && due?.id === l.id ? Math.max(0, due.at - clock.now()) : undefined;
    const total = timed ? Math.max(0, timed.ms) : 0;
    const left = Math.min(total, Math.max(0, own ?? timed?.left ?? total));
    // A fuse this page did not show from its start, with too little left for anybody to read it and press
    // Esc, was not seen to burn: the page cannot say it ran out (NOTCH_FUSE_SEEN_MS).
    const seen = own !== undefined || timed?.left === undefined || left >= Math.min(total, NOTCH_FUSE_SEEN_MS);
    // A fuse that was taken back stays taken back when it is drawn again.
    const undone = same && cur?.id === l.id && cur.undone === true;
    due = null;
    dropKeyboard();
    line = l;
    cur = undone ? { id: l.id, undone: true } : { id: l.id };
    // Another line: whatever map the last one drew is gone with it.
    if (l.id !== mapFor) { mapFor = l.id; mapKnown.clear(); }
    const common = { mood: l.mood, mark: l.mark, who: l.who, src: l.src } satisfies Partial<View>;
    const me = cur;
    // A yes is seen: the eyes nod and the bottom edge gulps, as it is given.
    const nod = (): void => { sounds.sfx('yes'); if (!reduce) { shape.kick(240); eyes.gesture('nodg'); } };
    // What a yes does to the line is the line's own rule: on most it is held, dimmed, for the brain; on one
    // that shows only Esc it is told and the line stays.
    const yes = (): void => { if (l.after?.yes === 'hold') nod(); answer('yes'); ended('yes'); };

    if (l.kind === 'say') {
      me.onYes = () => { answer('yes'); ended('yes'); };
      // Esc on a result is "seen": it goes, like yes.
      me.onEsc = () => { answer('done'); ended('done'); };
      show({ body: 'line', say: l.say, ...common }, instant);
      due = { id: l.id, at: clock.now() + left };
      later(left, () => { answer('done'); ended('done'); });
      return;
    }
    if (l.kind === 'offer') {
      // When it folds is not the page's to say: the brain folds it, and is told when a hand is on it (`syncHand`).
      me.onEsc = refuse;
      if (l.options?.length) {
        const options = l.options;
        show({
          body: 'choices', say: l.say, hint: { cap: 'esc', act: 'not now', touch: true }, ...common,
          opts: options.map((label, index) => ({ label, pick: () => { if (me.done || clickTooSoon()) return; nod(); answer('pick', { option: label, index }); ended('pick'); } })),
        }, instant);
      } else if (l.keys === 'esc') {
        // Only Esc is shown. A yes is told and nothing more: the brain says what it says to that, on this same line.
        me.onYes = yes;
        show({ body: 'line', say: l.say, hint: { cap: 'esc', act: 'not now' }, ...common }, instant);
      } else if (l.keys === 'talk') {
        me.onYes = yes;
        show({ body: 'line', say: l.say, hint: [{ cap: 'jk', act: l.yes ?? 'hold and talk', mute: true }, { cap: 'esc', label: 'not now', touch: true }], ...common }, instant);
      } else {
        me.onYes = yes;
        show({ body: 'line', say: l.say, hint: [{ act: l.yes ?? 'yes' }, { cap: 'esc', label: 'not now', touch: true }], ...common }, instant);
      }
      stepNote(l, instant);
      return;
    }
    if (l.kind === 'sheet') {
      sheetSeen = false;
      // A sheet that must be seen whole: until its end has been on screen, the yes goes down a page
      // and answers nothing. What is about to leave is not sent on a yes to the part that was read.
      // For how long its end must have been there is the brain's to say (`gate.whole`).
      const whole = l.gate?.whole;
      if (l.yes) me.onYes = whole !== undefined ? () => {
        if (sheetAtEnd()) sawSheetEnd();
        // The end must have been there for a moment: the press that brought it up is not the yes, and a
        // second quick press behind it is not one either. Reading takes longer than that.
        if (sheetSeen && clock.now() - sheetSeenAt >= whole) { yes(); return; }
        if (sheetSeen) return;
        sheetEl.scrollTop = Math.min(sheetEl.scrollHeight, sheetEl.scrollTop + Math.max(80, sheetEl.clientHeight - 64));
        more();
      } : yes;
      me.onEsc = () => { answer('no'); ended('no'); };
      show({
        body: 'sheet', say: l.say, sheet: blocksOf(l.blocks), stag: true, ...common,
        // A sheet that asks for a decision says what each key means: the pair is yes, Esc is no.
        ...(l.stay ? { pairYes: true } : {}),
        hint: l.yes ? [{ act: l.yes }, l.stay ? { cap: 'esc', act: l.no ?? 'no' } : { cap: 'esc', label: 'close' }] : { cap: 'esc', act: l.stay && l.no ? l.no : 'close' },
      }, instant);
      stepNote(l, instant);
      return;
    }
    if (l.kind === 'ask') {
      const input = el('input', 'ask');
      input.type = 'text';
      input.placeholder = l.placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
      // What the brain reads at most (protocol.ts). More would be dropped unread.
      input.maxLength = 4000;
      input.setAttribute('aria-label', l.placeholder);
      const submit = (): void => {
        const text = input.value.trim();
        if (!text || me.done) return;
        sounds.sfx('yes');
        answer('ask', { text });
        ended('ask');
        input.blur();
      };
      // The window has no keyboard until it asks: a press on the field asks.
      input.addEventListener('pointerdown', () => { askFocus(true); });
      input.addEventListener('blur', (e) => {
        const to = e.relatedTarget;
        const stays = to instanceof HTMLElement && nin.contains(to) && (to.tagName === 'INPUT' || to.tagName === 'TEXTAREA');
        if (input.isConnected && !stays) askFocus(false);
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); input.blur(); me.onEsc?.(); }
      });
      me.onYes = submit;
      // Once it was asked, it is answered: an Esc after that says nothing more for this line.
      me.onEsc = () => { if (me.done) return; answer('no'); ended('no'); };
      show({ body: 'ask', say: input, hint: { act: l.yes }, sheet: blocksOf(l.blocks), stag: true, ...common }, instant);
      // Opened to type in: the keyboard comes with it. Not for a line that is
      // only being drawn again (a page that came back): that would take the
      // keyboard from whatever the person is doing now.
      if (l.focus && !instant) {
        askFocus(true);
        input.focus({ preventScroll: true });
      }
      return;
    }
    if (l.kind === 'work') {
      me.onEsc = () => { eyes.gesture('shake'); sounds.sfx('no'); answer('stop'); ended('stop'); };
      show({
        body: 'work', say: l.say, ...common,
        // How many steps there will be is not always known: then there are no beads to light.
        hint: [...(l.steps > 0 ? [{ beads: l.steps } satisfies Hint] : []), ...(l.canTalk ? [{ cap: 'space', act: 'talk', mute: true } satisfies Hint] : []), { cap: 'esc', act: 'stop' }],
      }, instant);
      if (l.steps > 0) beads(l.done, l.steps);
      return;
    }
    if (l.kind === 'send') {
      // What goes out, on paper under the sentence, for as long as the fuse burns.
      const going = l.blocks?.length ? l.blocks : null;
      const go = (): void => {
        if (cur !== me) return;
        me.onEsc = () => {
          // Taken back, for good on this page: should the line come to be answered again (the brain never
          // said it has the undo), Esc says the same undo again, and "it ran out" is never said after it.
          me.undone = true;
          wrap.classList.remove('fusing');
          eyes.gesture('shake');
          sounds.sfx('no');
          answer('undo');
          ended('undo');
        };
        if (going) {
          sheetSeen = false;
          // Drawn anew, not again: whether it was out of sight is counted from here.
          if (!same) unseenLetter = outOfSight() ? l.id : '';
          const paper = blocksOf(going);
          paper.classList.add('going');
          show({ body: 'sheet', say: l.say, sheet: paper, stag: !same, hint: { cap: 'esc', act: 'undo' }, ...common, mood: l.mood ?? 'write' }, instant);
        } else {
          show({ body: 'line', say: l.say, hint: { cap: 'esc', act: 'undo' }, ...common, mood: l.mood ?? 'write' }, instant);
        }
        if (!seen || me.undone) return;
        due = { id: l.id, at: clock.now() + left };
        shape.burn(total, left);
        later(left, () => {
          if (me.done || me.undone) return;
          wrap.classList.remove('fusing');
          if (going) {
            // The fuse ran out, and that is said. Whether the letter was seen is said beside it, and only
            // when it was: drawn here, its end on the screen, and this page in sight for all of it. Without
            // that word the brain sends nothing, and says so.
            const vouch = (sheetSeen || sheetAtEnd()) && unseenLetter !== l.id && !outOfSight();
            if (vouch) edge.depart(leftOf(l.src));
            answer('done', vouch ? { seen: true } : {});
            ended('done');
            return;
          }
          // It leaves along the edge, toward where it is going: to the side
          // its app is on, and to the right when it goes to a person.
          edge.depart(leftOf(l.src));
          answer('done');
          ended('done');
        });
      };
      // A sheet of paper folds away before it goes. Not for a letter that stays up while its fuse burns.
      const paper = going ? null : sheetEl.querySelector('.paper');
      if (paper && !reduce && !instant) {
        paper.classList.add('fold');
        timers.after(190, go);
      } else go();
      return;
    }
    // listen: the words appear as they are made out, and the lip moves with the voice.
    const voice = el('span', 'voice'), wave = el('span', 'wave');
    for (let i = 0; i < 9; i++) wave.append(el('i'));
    voice.append(wave, el('span', 'heard', l.heard));
    // Esc turns away what is being said, or what was just heard: it will not be acted on.
    me.onEsc = refuse;
    show({ body: 'line', say: voice, hint: l.over ? HEARD_HINT : { cap: 'jk', act: 'let go when done', mute: true }, ...common, mood: l.mood ?? 'listen' }, instant);
    if (l.over) return;
    wrap.classList.add('talk');
    shape.morphPlay('talk');
  }

  /** The keys came up on a line that was listening: the lip is still, and Esc is what is left to press. */
  function heardOver(): void {
    wrap.classList.remove('talk');
    if (shape.N.mode === 'talk') { shape.N.tgt = null; shape.morphStop(); }
    const ctx = { body: 'line', onYes: () => {}, onEsc: () => { if (cur && !cur.done) cur.onEsc?.(); } };
    hintEl.replaceChildren(mkHint(HEARD_HINT, ctx));
    shape.fit(false, true);
  }

  /** Draws a sheet's blocks again once nothing is being typed in it, for as long as it is still that line. */
  let laterFor = '';
  function blocksLater(id: string): void {
    if (laterFor === id) return;
    laterFor = id;
    const check = (): void => {
      const l = line;
      if (!l || l.id !== id || (l.kind !== 'sheet' && l.kind !== 'ask')) { laterFor = ''; return; }
      if (sentence.typed() && sheetEl.contains(document.activeElement)) { timers.after(400, check); return; }
      laterFor = '';
      update({ id, blocks: l.blocks });
    };
    timers.after(400, check);
  }

  /** The line that is on its way in along the edge, not yet on the notch. */
  let arriving: NotchLine | null = null;
  /** Changes a line that is not drawn yet, as `update` changes one that is. */
  function amend(l: NotchLine, m: NotchEdit): void {
    if (m.say) l.say = m.say;
    if (m.done !== undefined && l.kind === 'work') l.done = m.done;
    if (l.kind === 'listen') { if (m.heard !== undefined) l.heard = m.heard; if (m.over) l.over = true; }
    if (m.blocks && (l.kind === 'sheet' || l.kind === 'ask')) l.blocks = m.blocks;
    if (m.away) l.away = m.away;
  }

  function update(m: NotchEdit): void {
    const l = line;
    if (!l || l.id !== m.id) return;
    // What a press elsewhere is can change with what the line holds (a file that was handed over): the brain says so with the change.
    if (m.away) l.away = m.away;
    if (m.say) {
      l.say = m.say;
      if (l.kind !== 'ask' && l.kind !== 'listen') {
        sayEl.replaceChildren(sentence.nodes(m.say));
        shape.fit(false, true);
      }
    }
    if (m.done !== undefined && l.kind === 'work') {
      l.done = m.done;
      beads(l.done, l.steps);
      sounds.sfx('tick');
    }
    if (m.over !== undefined && l.kind === 'listen' && m.over && !l.over) {
      l.over = true;
      heardOver();
    }
    if (m.heard !== undefined && l.kind === 'listen') {
      l.heard = m.heard;
      const heard = sayEl.querySelector('.heard');
      if (heard) heard.textContent = m.heard;
      // The lip jumps with each word, while there is a voice to follow.
      if (!reduce && !l.over) shape.N.tgt = Array.from({ length: WK }, () => Math.random() * 6);
      shape.fit(false, true);
      shape.wake();
    }
    if (m.blocks && (l.kind === 'sheet' || l.kind === 'ask')) {
      l.blocks = m.blocks;
      // A field in the sheet is being typed in: drawing the sheet again would take the field away in the
      // middle of a word, and the rest of the sentence would be typed into the app in front. The sheet is
      // drawn again when the typing is over.
      if (sentence.typed() && sheetEl.contains(document.activeElement)) { blocksLater(l.id); return; }
      const top = sheetEl.scrollTop;
      sentence.reset();
      sheetEl.classList.remove('stag');
      sheetEl.replaceChildren(blocksOf(m.blocks));
      sheetEl.scrollTop = top;
      // What it shows changed: its end has not been seen until it is on screen again.
      sheetSeen = false;
      shape.fit(false, true);
      more();
    }
  }

  /** The mouth that takes a file, as the brain keeps it. `whole`: told as part of everything at once, so a mouth that is open wide is opened first. */
  let mouthNow: NotchMouth = 'shut';
  function mouth(state: NotchMouth, whole = false): void {
    if (whole && state === mouthNow) return;
    if (whole && state === 'over') mouth('open');
    mouthNow = state;
    if (state === 'open') {
      wrap.classList.add('feed');
      shape.setFeeding(true);
      shape.fit();
      shape.morphPlay('mouth');
      eyes.gesture('pop', 360);
    } else if (state === 'over') {
      if (!wrap.classList.contains('feed')) return;
      shape.N.wide = true;
      wrap.classList.add('over');
      shape.kick(150);
      sounds.sfx('tick');
    } else {
      shape.N.wide = false;
      wrap.classList.remove('over', 'feed');
      shape.setFeeding(false);
      if (shape.N.mode === 'mouth') shape.morphStop();
      shape.fit();
      shape.shapeFor(eyes.mood());
    }
  }

  /**
   * Which side of the notch an app's things come from and go to. The
   * prototype had a dock, and an app's side was where it stood in it; here
   * the same apps keep the same sides. What comes from no app comes from the
   * left, and what goes to no app (to a person) goes to the right.
   */
  function leftOf(src: NotchApp | undefined): boolean {
    return src !== undefined && (['desk', 'mail', 'sheets', 'pay', 'cal'] as readonly string[]).includes(src);
  }

  /**
   * What the notch is, apart from its line, as a `patch` changes it: only
   * what is named. (A `state` says all of it at once, below.)
   */
  function kept(m: NotchKept): void {
    if (m.sound !== undefined) sounds.set(m.sound === true);
    if (m.eye !== undefined) {
      if (m.eye) { nin.dataset.eye = 'eye'; shape.kick(-140); } else delete nin.dataset.eye;
    }
    if (m.face !== undefined && (NOTCH_MOODS as readonly string[]).includes(m.face)) {
      restMood = m.face;
      // At rest it shows at once; under a line it waits for the rest.
      if (!cur) eyes.setMood(restMood);
      repaintRestIcon();
    }
    if (m.where !== undefined) {
      front = notchWhereApp(m.where);
      repaintRestIcon();
    }
    if (m.count !== undefined) {
      count = Math.max(0, Math.floor(Number(m.count) || 0));
      if (!cur) { paintCount('rest'); shape.fit(); }
    }
    if (m.mouth) mouth(m.mouth);
    if (m.park !== undefined) edge.park(m.park);
  }

  /** Something the notch does once. */
  function effect(m: NotchEffect): void {
    if (m.gulp) {
      // The gulp after a file was dropped in. The mouth itself was shut by the brain's patch.
      shape.kick(330);
      shape.morphPlay('ripple');
      eyes.gesture('nodg');
      sounds.sfx('yes');
    }
    if (m.mood) {
      // A look that is asked for in passing is shown, and is not the face the notch rests with: that one is
      // the brain's to keep (`face`), and at rest the notch goes back to it by itself.
      eyes.setMood(m.mood);
      timers.cancel(moodBack);
      if (!cur) { const mine = tok; moodBack = timers.after(NOTCH_PASSING_MOOD_MS, () => { if (mine === tok && !cur) eyes.setMood(restMood); }); }
    }
    if (m.gesture) {
      // The eye that was kept on something opens wide when that thing changes.
      if (m.gesture === 'pop' && nin.dataset.eye) {
        nin.classList.add('eyefire');
        timers.after(650, () => nin.classList.remove('eyefire'));
        shape.kick(210);
      }
      eyes.gesture(m.gesture);
    }
    if (m.lip) {
      const aim = typeof m.aim === 'number' && Number.isFinite(m.aim) ? Math.max(.14, Math.min(.86, m.aim)) : undefined;
      shape.morphPlay(m.lip, aim === undefined ? undefined : { aim });
    }
    if (typeof m.kick === 'number' && Number.isFinite(m.kick)) shape.kick(Math.max(-400, Math.min(400, m.kick)));
    if (m.body === 'nod') shape.kick(250);
    else if (m.body === 'hops') { shape.kick(-200); timers.after(270, () => shape.kick(-180)); }
    else if (m.body === 'duck' && !cur) edge.duck();
    if (m.edge === 'depart') edge.depart(m.side !== 'right');
    else if (m.edge === 'bud') edge.bud(m.side !== 'right');
    else if (m.edge === 'carry') edge.carry(m.side === 'right', m.side !== 'right');
    // A birth only when there is nothing on the notch: it starts from the eyes.
    if (m.birth && !cur) {
      tok++;
      edge.birth(m.birth, () => {});
    }
  }

  const versionListeners = new Set<(v: number) => void>();
  /** A word or two on a message that could not be read, for the log: what it said it was, never what was in it. */
  const named = (raw: unknown): string => {
    const word = (value: unknown): string => (typeof value === 'string' ? value.replace(/[^\w-]/g, '').slice(0, 20) : '');
    const m = typeof raw === 'object' && raw !== null ? raw as { type?: unknown; line?: { kind?: unknown } | null } : {};
    return [word(m.type) || 'not a message', word(m.line?.kind)].filter(Boolean).join(' ');
  };

  function receive(raw: NotchToPage): void {
    if (!alive) return;
    // Read whole before anything changes: a message that is not one is dropped, and the notch stays as it was.
    // One of a kind this page has never heard of (a newer brain) is passed over without a word.
    const read = readNotchToPage(raw);
    if (!read.message) {
      // A brain of another version: nothing of what it says is this page's to draw.
      if (read.why === 'version') { for (const listener of versionListeners) listener(read.v); return; }
      // A kind this page has never heard of. If it was the next in the row, it is counted as read.
      if (read.why === 'unknown') { if (born && read.seq === seq + 1) seq = read.seq; return; }
      // It cannot be read. If it was numbered it is counted as read all the same, so that the next is not taken for a gap.
      if (born && read.seq !== undefined && read.seq > seq) seq = read.seq;
      outOfStep(named(raw));
      return;
    }
    const message = read.message;
    try {
      switch (message.type) {
        case 'ack':
          answers.ack(message.n, message.took);
          return;
        case 'refuse':
          // The brain takes nothing from this page. In another version: see above. In this one, it only
          // does not know the page (it started again, or the connection did): it is told hello.
          if (message.v !== NOTCH_PROTOCOL_VERSION) for (const listener of versionListeners) listener(message.v);
          else outOfStep('the brain does not know this page');
          return;
        case 'state': {
          // The same run of the brain, and a number this page has read: a copy that came twice, or late.
          const other = message.brain !== brain;
          if (!other && message.seq <= seq) return;
          if (read.lineLost) outOfStep(named(raw));
          // Another run of the brain: nothing held from the one before stands. Its lines are other lines,
          // whatever they are called, and what was said to it will not be answered.
          if (other && brain) answers.clear();
          const fresh = other && brain !== '';
          brain = message.brain;
          seq = message.seq;
          count = Math.max(0, Math.floor(Number(message.count) || 0));
          shownCount = count;
          restMood = message.face && (NOTCH_MOODS as readonly string[]).includes(message.face) ? message.face : 'idle';
          front = notchWhereApp(message.where);
          // An eye that was being kept is still kept: the brain remembers it for a page that comes back.
          if (message.eye) nin.dataset.eye = 'eye'; else delete nin.dataset.eye;
          // And whether it makes its small sounds: the person's own choice, kept by the brain.
          sounds.set(message.sound === true);
          if (!fresh && cur && line && (read.lineLost || message.line?.id === line.id)) {
            // The line this page already shows, told again (the page said hello again): it stays as it is.
            // Drawn again it forgot that it was answered: an Esc on a fuse was followed by "it ran out", a
            // yes could be given twice, and a field being typed in was emptied. And a line that could not
            // be read takes nothing off the notch either.
          } else if (message.line) {
            edge.appear();
            // A line that cannot be drawn must not leave the page unborn: it then drew nothing and heard
            // nothing more until it was loaded again. It rests, and can be shown the next thing.
            try { showLine(message.line, true); answers.fresh(); } catch (error) {
              console.error('[notch] a line could not be drawn', error);
              try { rest(true); } catch { /* nothing more can be done here */ }
            }
          } else if (message.born && !born) {
            rest(true);
            edge.birth(message.born, () => {});
          } else {
            edge.appear();
            rest(true);
          }
          born = true;
          // What waits on the edge and the mouth are kept by the brain too: a page that comes back has them.
          edge.park(message.park ?? 0);
          mouth(message.mouth ?? 'shut', true);
          syncEsc();
          startBeat();
          return;
        }
        case 'patch':
        case 'effect': {
          // Nothing is drawn before the brain has said the whole of it once.
          if (!born) return;
          // A number this page has read: a copy. One that is not the next: something before it was lost on
          // the way, and the brain is asked for the whole. What did come is still taken, as it always was.
          if (message.seq <= seq) return;
          if (message.seq !== seq + 1) outOfStep(`${message.type} ${message.seq} came after ${seq}`);
          seq = message.seq;
          if (message.type === 'effect') { effect(message); return; }
          kept(message);
          if (message.line === null) rest();
          else if (message.line) {
            if (message.line.arrive && (NOTCH_ARRIVALS as readonly string[]).includes(message.line.arrive) && !reduce) {
              const next = message.line, mine = ++tok;
              arriving = next;
              edge.arrive(message.line.arrive, () => { if (arriving === next) arriving = null; if (mine === tok) drawLine(next); });
            } else drawLine(message.line);
          }
          if (message.edit) {
            // For a line that is still coming in along the edge: it lands as it now is. (It was dropped: an
            // approval's "On screen: ...", read a moment after it was sent, never appeared on its paper.)
            if (arriving && arriving.id === message.edit.id) amend(arriving, message.edit);
            else update(message.edit);
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      // A message that cannot be drawn must not take the notch down with it.
      console.error('[notch] a message could not be shown', error);
    }
  }

  // The page is not a browser to the person: no menu of its own on a right click, no zoom, no reload, no
  // print, no find. (Zoomed, a click inside a sheet could read as a click away.)
  const noMenu = (e: Event): void => { e.preventDefault(); };
  const noZoom = (e: WheelEvent): void => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
  const noBrowserKeys = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (k === 'f5' || k === 'f3' || k === 'f7' || k === 'f12' || (mod && ['r', 'p', 'f', 'g', 's', 'u', 'o', 'j', '+', '-', '=', '0'].includes(k))) e.preventDefault();
  };
  document.addEventListener('contextmenu', noMenu);
  document.addEventListener('wheel', noZoom, { passive: false });
  document.addEventListener('keydown', noBrowserKeys, true);

  // Lit words: a click moves to the next option, a drag or the wheel scrubs.
  let scrub: { word: HTMLElement; x: number; moved: boolean } | null = null, scrubbed = 0;
  const liveOf = (target: EventTarget | null): HTMLElement | null =>
    (target instanceof Element ? target.closest<HTMLElement>('.live') : null);
  const onPointerDown = (e: PointerEvent): void => {
    const word = liveOf(e.target);
    if (word && sentence.wordOf(word)) scrub = { word, x: e.clientX, moved: false };
  };
  const onPointerMove = (e: PointerEvent): void => {
    eyes.pointer(e.clientX, e.clientY);
    if (!scrub) return;
    const d = e.clientX - scrub.x;
    if (Math.abs(d) < 18) return;
    scrub.moved = true;
    scrub.x = e.clientX;
    sentence.cycle(scrub.word, d > 0 ? 1 : -1);
    sounds.sfx('tick');
  };
  const onPointerUp = (): void => {
    if (scrub?.moved) scrubbed = clock.now();
    scrub = null;
  };
  const onClick = (e: MouseEvent): void => {
    const word = liveOf(e.target);
    if (word) {
      if (clock.now() - scrubbed > 250 && !(cur?.done)) sentence.cycle(word, 1);
      return;
    }
    // A press on "close" puts the notch to rest before this handler hears of
    // it. What was pressed is gone from the page by then, and that is how the
    // two are told apart: only a click on the resting notch itself opens it.
    if (!(e.target instanceof Node) || !e.target.isConnected) return;
    if (nin.dataset.body === 'rest' && born && edge.shown()) send({ type: 'open' });
  };
  let lastWheel = 0;
  const onWheel = (e: WheelEvent): void => {
    const word = liveOf(e.target);
    if (!word || cur?.done) return;
    e.preventDefault();
    const now = clock.now();
    if (now - lastWheel < 140) return;
    lastWheel = now;
    sentence.cycle(word, e.deltaY > 0 ? 1 : -1);
  };
  // Keys work whenever the page has the keyboard. Nothing depends on them.
  const onKey = (e: KeyboardEvent): void => {
    if (!cur || cur.done || e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (sentence.picking()) sentence.closePick();
      else if (!escTooSoon()) cur.onEsc?.();
      return;
    }
    // A line that only just appeared cannot be answered by a key already on its way down.
    if (tooSoon()) return;
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      cur.onYes?.();
    } else if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      const target = optsEl.children[n - 1] ?? sheetEl.querySelector(`.btn[data-k="${n}"]`);
      if (target instanceof HTMLElement) { e.preventDefault(); target.click(); }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const word = liveOf(document.activeElement) ?? nin.querySelector<HTMLElement>('.live');
      if (word) { e.preventDefault(); sentence.cycle(word, e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1); }
    }
  };
  const onScroll = (): void => more();
  const onResize = (): void => { shape.fit(true); };
  // The number on a choice is a key only while the notch has the keyboard, which it has only while a text
  // field of its own is being typed in. At any other time a "2" goes to the app in front: the cap promised a
  // key that typed into the person's document. So the caps are shown only while the numbers reach the notch.
  // A choice can always be clicked.
  const syncKeyboard = (): void => {
    const has = typeof document.hasFocus === 'function' && document.hasFocus();
    if (root.classList.contains('notch-nokb') === !has) return;
    root.classList.toggle('notch-nokb', !has);
    if (alive && born) shape.fit(true);
  };
  root.classList.toggle('notch-nokb', !(typeof document.hasFocus === 'function' && document.hasFocus()));

  notch.addEventListener('pointerdown', onPointerDown);
  // A hand that comes onto the line, or a field that is typed in, is said to the brain as it happens (`syncHand`).
  wrap.addEventListener('pointerenter', syncHand);
  wrap.addEventListener('pointerleave', syncHand);
  nin.addEventListener('focusin', syncHand);
  nin.addEventListener('focusout', syncHand);
  root.addEventListener('pointermove', onPointerMove, { passive: true });
  root.addEventListener('pointerup', onPointerUp);
  // Before any handler of the click itself: they ask when the click before this one came.
  root.addEventListener('click', noteClick, true);
  notch.addEventListener('click', onClick);
  notch.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('keydown', onKey);
  sheetEl.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
  window.addEventListener('focus', syncKeyboard);
  window.addEventListener('blur', syncKeyboard);
  // A font is only fetched when text first uses it, which is after that text
  // was measured: the first sentence would be sized for the fallback font and
  // left too wide. So the faces the notch writes in are asked for at once,
  // and whenever one arrives late the notch is measured again.
  const onFonts = (): void => { if (alive && born) shape.fit(true); };
  if (document.fonts) {
    for (const face of ['500 15px "Familjen Grotesk"', '600 15px "Familjen Grotesk"', '400 13.5px "Familjen Grotesk"', '500 12px "Spline Sans Mono"', '600 12px "Spline Sans Mono"']) {
      void document.fonts.load(face).catch(() => {});
    }
    void document.fonts.ready.then(onFonts);
    document.fonts.addEventListener?.('loadingdone', onFonts);
  }

  /** The body's outline as points in the window's px, top left to top right. */
  function bodyEdge(): Point[] {
    const c = shape.current();
    if (!c.d) return [];
    const scale = window.devicePixelRatio || 1;
    // Under a camera housing the path's own y = 0 is the housing's lower edge, c.y down the window.
    const points = flattenPath(c.d, scale).map(([x, y]): Point => [x + c.x, y + c.y]);
    if (!settled()) return points;
    // At rest the straight sides and the bottom sit on whole screen pixels,
    // or they are drawn as a grey line half as dark. The whole outline is
    // stretched by the fraction of a pixel that takes.
    const left = c.x + OX, right = left + c.w, bottom = c.h;
    const snap = (v: number): number => Math.round(v * scale) / scale;
    const l2 = snap(left), r2 = snap(right), b2 = snap(c.y + bottom) - c.y;
    if (right - left < 1 || bottom < 1 || b2 < 1) return points;
    const kx = (r2 - l2) / (right - left), ky = b2 / bottom;
    return points.map(([x, y]): Point => [l2 + (x - left) * kx, y > c.y ? c.y + (y - c.y) * ky : y]);
  }

  function outlines(inset: number): Point[][] {
    const polygons: Point[][] = [];
    if (edge.shown()) {
      const body = hanging(bodyEdge(), inset);
      if (body.length >= 3) polygons.push(body);
    }
    polygons.push(...edge.polygons(inset));
    return polygons;
  }

  let wasDown = false;
  function pointer(x: number, y: number, down: boolean): void {
    if (!alive) return;
    eyes.pointer(x, y);
    const pressed = down && !wasDown;
    wasDown = down;
    const on = born && outlines(0).some((polygon) => inside(polygon, x, y));
    if (on !== pointerOnNotch) { pointerOnNotch = on; syncEsc(); }
    if (!pressed || !born) return;
    // A press outside everything the notch is made of is a click away from it.
    if (on) return;
    if (sentence.picking()) sentence.closePick();
    // What a press elsewhere is, is the brain's to say (`away`, written into the line): a no to a sheet that
    // only shows something and to a field, and nothing to a sheet that asks for a decision (the person's
    // next click in their own app closed it and silently turned it down), a letter under its fuse (only Esc
    // is an undo), a question about a file that was dropped, and a field that says it stays.
    if (line?.away !== 'no') return;
    // And nothing is, in its first moment: the press was on its way before the line was there.
    if (tooSoon()) return;
    if (cur && !cur.done) cur.onEsc?.();
  }

  /** Yes from the keyboard: to what is offered; with nothing offered, open up. */
  function yesKey(): void {
    if (!born || !edge.shown()) return;
    // A line that only just appeared cannot be answered by keys already on their way down.
    if (tooSoon()) return;
    if (!cur) { send({ type: 'open' }); return; }
    if (cur.done) return;
    // Something is typed into a word's field and not taken yet: the yes takes it, as Enter would. It does
    // not answer the line as it stood before the typing (a reply was sent unchanged while what it should say
    // instead sat in the field).
    if (sentence.typed()) { sentence.commit(); return; }
    if (cur.onYes) { cur.onYes(); return; }
    // Choices have no yes: the row of them nods, to say "pick one".
    if (optsEl.firstChild) {
      optsEl.classList.remove('nudge');
      void optsEl.offsetWidth;
      optsEl.classList.add('nudge');
      timers.after(420, () => optsEl.classList.remove('nudge'));
    }
  }

  function key(name: string): void {
    if (!alive || !born) return;
    if (name === 'talk-start') {
      // It perks up the moment its keys are held.
      wrap.classList.add('att');
      shape.kick(90);
      shape.fit(false, true);
    } else if (name === 'talk-end' || name === 'talk-cancel') {
      // Let go, or ended by a slip: either way the keys are no longer held.
      wrap.classList.remove('att');
      shape.fit(false, true);
    } else if (name === 'yes') {
      yesKey();
    } else if (name === 'esc') {
      if (sentence.picking()) sentence.closePick();
      // Esc on a line is a no. One that came by itself takes none for its
      // first moment, like a yes: the key may have been on its way to the
      // app in front.
      else if (escTooSoon()) return;
      else if (cur && !cur.done) cur.onEsc?.();
    } else if (name === 'esc-twice') {
      eyes.gesture('shake');
      sounds.sfx('no');
      send({ type: 'stop' });
    }
  }

  // The pair that is held shows beside the eyes while it is held.
  const held = (): void => {
    lead.querySelector('.cap.held')?.remove();
    lead.append(duo('talk', 'span', 'cap held'));
  };
  held();

  // Nothing is on screen until the brain has said what the notch shows.
  edge.hide();

  return {
    receive, outlines, pointer, key,
    onOutline(listener) { listeners.add(listener); },
    onWantEsc(listener) { escListeners.add(listener); },
    onAsking(listener) { askingListeners.add(listener); },
    onDropped(listener) { dropListeners.add(listener); },
    onVersion(listener) { versionListeners.add(listener); },
    retire() {
      if (!alive) return;
      answers.clear();
      timers.cancel(beat);
      beat = 0;
      // Back to what it was before the brain first spoke: nothing on screen, nothing heard but a `state`.
      if (born) { try { rest(true); } catch { /* nothing more can be done here */ } }
      born = false;
      brain = '';
      seq = -1;
      edge.hide();
      syncEsc();
      changed();
    },
    setPairs(pairs) {
      if (!setKeyPairs(pairs)) return;
      held();
      // The hints on screen were drawn with the old keys: draw the line again.
      again();
    },
    setHousing(w, h) {
      const next = notchHousing(w, h);
      if ((next?.w ?? 0) === (cam?.w ?? 0) && (next?.h ?? 0) === (cam?.h ?? 0)) return;
      cam = next;
      // Everything the notch is made of starts below the housing; the ink above it is the shape's own.
      root.style.setProperty('--cam-h', (cam?.h ?? 0) + 'px');
      root.classList.toggle('housed', !!cam);
      root.ownerDocument.documentElement.classList.toggle('notch-housed', !!cam);
      if (!alive) return;
      // Its size may change with it (a notch about as wide as the housing is made a little wider).
      if (born) shape.fit(true); else shape.draw();
    },
    destroy() {
      alive = false;
      syncEsc();
      answers.clear();
      escListeners.clear();
      askingListeners.clear();
      dropListeners.clear();
      versionListeners.clear();
      frames.stop();
      timers.clear();
      sounds.stop();
      listeners.clear();
      notch.removeEventListener('pointerdown', onPointerDown);
      wrap.removeEventListener('pointerenter', syncHand);
      wrap.removeEventListener('pointerleave', syncHand);
      nin.removeEventListener('focusin', syncHand);
      nin.removeEventListener('focusout', syncHand);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      notch.removeEventListener('click', onClick);
      notch.removeEventListener('wheel', onWheel);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('click', noteClick, true);
      window.removeEventListener('focus', syncKeyboard);
      window.removeEventListener('blur', syncKeyboard);
      sheetEl.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      root.ownerDocument.documentElement.classList.remove('notch-housed');
      root.replaceChildren();
    },
  };
}
