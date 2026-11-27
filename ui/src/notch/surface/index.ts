/**
 * The notch's surface: it draws what the brain says and reports what the
 * person did. It decides nothing. The brain's messages come in through
 * `receive`; the person's answers go out through `send`.
 *
 * Three parts, joined here:
 *   ./core.ts    the model and what everything comes to, with no screen and no clock
 *   ./render.ts  the drawing (the prototype's surface, notch-poc v15, with its scripted world cut away)
 *   ./input.ts   the page's own keys, clicks and wheel, read into inputs
 * What is said to the brain and kept until it has it is ./answers.ts.
 */
import { NOTCH_AT_EVERY_MS, NOTCH_AT_RESTING_MS, NOTCH_HAND_AGAIN_MS } from '../../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchLine, NotchToPage } from '../../../../src/notch/protocol.ts';
import { createNotchAnswers } from './answers.ts';
import {
  notchArrived, notchAsking, notchClicked, notchEdited, notchFuseUp, notchHandLine, notchHeld, notchHeldNow, notchInput, notchLineUp,
  notchLost, notchMessage, notchPageStart, notchPainted, notchPainting, notchRested, notchTick, notchTimed, notchTooSoon, notchVoid,
  notchWakeAt, notchWantsEsc,
  type NotchPageFacts, type NotchPageInput, type NotchPageModel, type NotchPageOut, type NotchPageStep,
} from './core.ts';
import { createFrames, createTimers, realNotchPageClock, type NotchPageClock } from './dom.ts';
import { setKeyPairs } from './hints.ts';
import { createNotchInput } from './input.ts';
import { flattenPath, hanging, inside, type Point } from './outline.ts';
import { createNotchRender } from './render.ts';
import { OX } from './shape.ts';

export { NOTCH_PASSING_MOOD_MS } from './render.ts';

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
  onDropped(listener: (what: string, refused?: boolean) => void): void;
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
  const still = options.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const askFocus = options.focus ?? (() => {});
  const clock = options.clock ?? realNotchPageClock;
  const timers = createTimers(clock);

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
  // The silhouette changed. Inside a frame the report waits for the frame's end, so everything that moved in
  // it is in one report.
  const changed = (): void => {
    dirty = true;
    if (frames.inFrame() || flushing) return;
    flushing = true;
    queueMicrotask(() => { flushing = false; flush(); });
  };
  const frames = createFrames(flush);
  // The display's camera housing, when it has one (a MacBook's). Told by the desktop app.
  let cam: { w: number; h: number } | null = null;

  /** Everything the page holds. The one place it changes is here, by the functions of ./core.ts. */
  let model: NotchPageModel = notchPageStart();

  const render = createNotchRender(root, {
    reduce: still, clock, timers, frames, width, changed, housing: () => cam, alive: () => alive,
    hooks: {
      model: () => model,
      painting: () => { model = notchPainting(model, clock.now()); },
      painted: () => { model = notchPainted(model); },
      timed: (id, left) => { model = notchTimed(model, id, left, clock.now()); wake(); },
      fuseUp: (drawn) => { model = notchFuseUp(model, drawn); },
      input: (input) => { act(input); },
      sync: () => { syncEsc(); },
      focus: askFocus,
    },
  });
  const { nin, wrap, shape, eyes, edge, sentence } = render;

  /** What only the page can see, looked at only when the model asks for it (looking at a sheet's end marks it seen). */
  const facts = (): NotchPageFacts => ({
    get shown() { return edge.shown(); },
    get resting() { return render.resting(); },
    get picking() { return sentence.picking(); },
    get typed() { return sentence.typed(); },
    get choices() { return !!render.optsEl.firstChild; },
    get sheetSeenAt() { return render.sheetSeenAt(); },
    get askText() { return render.askText(); },
    get letterSeen() { return render.letterSeen(model.line?.id ?? ''); },
  });

  // Esc is taken from the app in front only while it would do something here.
  const escListeners = new Set<(want: boolean) => void>();
  let wantedEsc = false;
  let escLater = 0;
  /** Whether the pointer is on the notch itself: on its body or on a sheet. */
  let pointerOnNotch = false;
  function syncEsc(): void {
    const { want, again: later } = notchWantsEsc(model, clock.now(), { alive, work: render.working(), pointerOnNotch, picking: sentence.picking() });
    if (later !== null && !escLater) escLater = timers.after(later, () => { escLater = 0; syncEsc(); });
    syncAsking();
    syncHand();
    if (want === wantedEsc) return;
    wantedEsc = want;
    for (const listener of escListeners) listener(want);
  }

  // A question that waits for a yes or a no: the window is told, so that it does not stay hidden behind a
  // fullscreen video with a task standing still on it.
  const askingListeners = new Set<(asking: boolean) => void>();
  let wasAsking = false;
  function syncAsking(): void {
    const asking = notchAsking(model, alive);
    if (asking === wasAsking) return;
    wasAsking = asking;
    for (const listener of askingListeners) listener(asking);
  }

  /** Said to listeners when the page is out of step with the brain: it is to be asked for the whole again. */
  const dropListeners = new Set<(what: string, refused?: boolean) => void>();
  const outOfStep = (what: string, refused = false): void => { for (const listener of dropListeners) listener(what, refused); };
  const versionListeners = new Set<(v: number) => void>();

  const answers = createNotchAnswers({
    send,
    timers,
    // The brain never said it has it: the line it held can be answered again, and the brain is asked what the notch shows.
    lost: (given) => {
      if (!alive) return;
      // A typed value given up on: the field that waited for it can send it again.
      if (given.act === 'word' && given.word !== undefined && given.text !== undefined) sentence.unheard(given.word);
      step(notchLost(model, given));
    },
    // It came for a line the brain no longer shows: this page is behind. It says how far it has read, and the
    // brain tells it the whole again if it sent more than that.
    late: () => { if (alive && model.born) send({ type: 'at', seq: model.seq }); },
    // A value typed into a lit word was read by the brain, or could not be: the field that waits for it is told.
    heard: (given, unread) => { if (alive && given.act === 'word' && given.word !== undefined && given.text !== undefined) sentence.heard(given.word, !unread); },
  });

  // A hand on the line: the pointer is on the notch (as the desktop app tells it too: hover does not reach a
  // page in a window that is never the active one on every system), a field is being typed in, or a word's
  // choices are open. Not "whatever was clicked last". The page only says so. Whether an offer folds is the brain's.
  const handNow = (): boolean => {
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && nin.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    return wrap.matches(':hover') || pointerOnNotch || typing || sentence.picking();
  };
  let handFor = '', handSaid = false, handTimer = 0;
  function syncHand(): void {
    const l = notchHandLine(model, alive);
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
    // Said again while it is there, so that one saying lost on the way is not a fold under a hand; and looked
    // at again, so that a hand that left without a sign is found gone.
    if (!handTimer) handTimer = timers.after(NOTCH_HAND_AGAIN_MS, () => {
      handTimer = 0;
      if (handSaid && handFor && handNow()) send({ type: 'hand', id: handFor, on: true });
      syncHand();
    });
  }

  // How far this page has read, said every so often for as long as it is up: the last thing the brain said
  // may be the one that was lost, and no gap shows until the next comes. Often while a line is up (what ends
  // it may be what was lost), and seldom at rest: not every few seconds all night.
  let beat = 0, beatAt = 0;
  function startBeat(): void {
    if (beat) return;
    beat = timers.after(Math.min(NOTCH_AT_EVERY_MS, NOTCH_AT_RESTING_MS), () => {
      beat = 0;
      if (!alive || !model.born) return;
      const now = clock.now();
      if (model.cur || now - beatAt >= NOTCH_AT_RESTING_MS) {
        beatAt = now;
        send({ type: 'at', seq: model.seq });
      }
      startBeat();
    });
  }

  /** The one timer the model asks for: when the result or the fuse that is up runs out. */
  let wakeTimer = 0;
  let wakeFor: number | null = null;
  function wake(): void {
    const at = notchWakeAt(model);
    if (at === wakeFor) return;
    timers.cancel(wakeTimer);
    wakeTimer = 0;
    wakeFor = at;
    if (at === null) return;
    wakeTimer = timers.after(Math.max(0, at - clock.now()), () => {
      wakeTimer = 0;
      wakeFor = null;
      if (alive) step(notchTick(model, clock.now(), facts()));
    });
  }

  /** Takes a step of the model, and does what it says, in order. */
  function step(s: NotchPageStep): void {
    model = s.model;
    for (const out of s.out) apply(out);
    wake();
  }

  function act(input: NotchPageInput): void {
    if (alive) step(notchInput(model, input, clock.now(), facts()));
  }

  /** Draws a line the model puts up. `same`: the line that is already up, drawn again. */
  function showLine(l: NotchLine, instant: boolean, same = false): void {
    const up = notchLineUp(model, l, clock.now(), same);
    model = up.model;
    render.line(l, up.timing, instant, same);
  }

  /** The brain holds the line answered: dimmed here, and a fuse on it burns no further and offers no undo. */
  function heldNow(l: NotchLine): void {
    if (!notchHeldNow(model, l)) return;
    if (l.kind === 'send') { render.unfuse(); render.clearHint(); }
    model = notchHeld(model, l);
    render.settle();
    syncEsc();
  }

  function rest(instant = false): void {
    model = notchRested(model);
    render.rest(instant);
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
    const before = model;
    const live = model.tok === model.shownTok;
    // Drawn anew, an answer to it is a new answer (./answers.ts).
    try { showLine(l, instant); answers.fresh(); heldNow(l); } catch (error) {
      console.error('[notch] a line could not be drawn', error);
      model = { ...model, line: before.line, cur: before.cur, due: before.due, drawn: before.drawn, undoable: before.undoable };
      if (!model.cur) { try { rest(true); } catch { /* nothing more can be done here */ } return; }
      // A draw that got as far as the screen has replaced some or all of the line that stays, and made void
      // what it had scheduled. A result then stayed up for ever, and the screen could show the line that
      // failed while the keys answered for the other. Then the line that stays is drawn again as it stands,
      // with what is left of its time. When nothing of it was touched it is left alone: drawing it again
      // would empty a field being typed in.
      if (model.tok === before.tok && live) return;
      try { again(); } catch { try { rest(true); } catch { /* nothing more can be done here */ } }
    }
  }

  /** Draws the line that is up again as it stands, unless it was answered: with what is left of its time, not all of it. */
  function again(): void {
    if (model.line && model.cur && !model.cur.done) showLine(structuredClone(model.line), true, true);
  }

  function apply(out: NotchPageOut): void {
    switch (out.do) {
      case 'send': send(out.message); return;
      case 'answer': answers.say(out.answer, out.once); return;
      case 'rest': rest(out.instant); return;
      case 'settle':
        if (model.cur && !model.cur.done) model = { ...model, cur: { ...model.cur, done: true } };
        render.settle();
        syncEsc();
        return;
      case 'reopen': render.reopen(); syncEsc(); return;
      case 'nod': render.nod(); return;
      case 'shake': render.shake(); return;
      case 'sfx': render.sfx(out.name); return;
      case 'unfuse': render.unfuse(); return;
      case 'depart': render.depart(out.left); return;
      case 'clearHint': render.clearHint(); return;
      case 'scrollSheet': render.scrollSheet(); return;
      case 'nudge': render.nudge(); return;
      case 'commit': sentence.commit(); return;
      case 'closePick': sentence.closePick(); return;
      case 'blurAsk': render.blurAsk(); return;
      case 'talk': render.talk(out.held); return;
      case 'draw':
        if (out.restore) { drawLine(out.line, out.instant); return; }
        // A line that cannot be drawn must not leave the page unborn: it then drew nothing and heard nothing
        // more until it was loaded again. It rests, and can be shown the next thing.
        try { showLine(out.line, true); answers.fresh(); heldNow(out.line); } catch (error) {
          console.error('[notch] a line could not be drawn', error);
          try { rest(true); } catch { /* nothing more can be done here */ }
        }
        return;
      case 'arrive': {
        const mine = model.tok;
        if (out.line.arrive) edge.arrive(out.line.arrive, () => { if (alive) step(notchArrived(model, out.n, mine)); });
        return;
      }
      case 'edit': {
        const was = model.line;
        const next = notchEdited(model, out.edit);
        if (!next || !was) return;
        model = next;
        render.update(out.edit, was);
        return;
      }
      case 'kept': render.kept(out.kept); return;
      case 'whole': render.whole(out.eye, out.sound); return;
      case 'effect':
        // A birth starts from the eyes: whatever was scheduled before it is void.
        if (out.effect.birth && !model.cur) model = notchVoid(model);
        render.effect(out.effect);
        return;
      case 'held': heldNow(out.line); return;
      case 'appear': edge.appear(); return;
      case 'birth': edge.birth(out.born, () => {}); return;
      case 'park': edge.park(out.park); return;
      case 'mouth': render.mouth(out.mouth, out.whole); return;
      case 'ack': answers.ack(out.n, out.took, out.unread); return;
      case 'clearAnswers': answers.clear(); return;
      case 'outOfStep': outOfStep(out.what, out.refused); return;
      case 'version': for (const listener of versionListeners) listener(out.v); return;
      case 'sync': syncEsc(); return;
      case 'beat': startBeat(); return;
    }
  }

  function receive(raw: NotchToPage): void {
    if (!alive) return;
    try { step(notchMessage(model, raw, still)); } catch (error) {
      // A message that cannot be drawn must not take the notch down with it.
      console.error('[notch] a message could not be shown', error);
    }
  }

  const input = createNotchInput({
    render,
    now: () => clock.now(),
    open: () => model.cur !== null && !model.cur.done,
    answered: () => model.cur?.done === true,
    tooSoon: (via) => notchTooSoon(model, via, clock.now()),
    input: act,
    clicked: () => { model = notchClicked(model, clock.now()); },
    hand: () => syncHand(),
    fit: () => { if (alive && model.born) shape.fit(true); },
  });

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
    const on = model.born && outlines(0).some((polygon) => inside(polygon, x, y));
    if (on !== pointerOnNotch) { pointerOnNotch = on; syncEsc(); }
    if (!pressed || !model.born) return;
    // A press outside everything the notch is made of is a click away from it. What that does is the line's (`away`).
    if (on) return;
    act({ kind: 'away' });
  }

  function key(name: string): void {
    if (!alive || !model.born) return;
    act({ kind: 'key', name });
  }

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
      if (model.born) { try { rest(true); } catch { /* nothing more can be done here */ } }
      model = { ...model, born: false, brain: '', seq: -1 };
      edge.hide();
      syncEsc();
      changed();
    },
    setPairs(pairs) {
      if (!setKeyPairs(pairs)) return;
      render.held();
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
      if (model.born) shape.fit(true); else shape.draw();
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
      render.destroy();
      listeners.clear();
      input.destroy();
      root.ownerDocument.documentElement.classList.remove('notch-housed');
      root.replaceChildren();
    },
  };
}
