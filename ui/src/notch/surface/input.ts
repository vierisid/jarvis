/**
 * The page's own events, read into the few things a person can do with the
 * notch (./core.ts, `NotchPageInput`): Enter, Escape, a number for a choice,
 * the arrows and the wheel and a drag on a lit word, a click on the resting
 * notch. Keys from anywhere on the desktop and the pointer as the desktop app
 * reports it come in through ./index.ts. Nothing here decides what an input
 * means for the line, nor whether it came too soon: that is ./core.ts.
 */
import type { NotchPageInput } from './core.ts';
import type { NotchRender } from './render.ts';

export interface NotchInputHooks {
  render: NotchRender;
  now(): number;
  /** Whether the line that is up can still be answered. */
  open(): boolean;
  /** Whether the line that is up was answered. */
  answered(): boolean;
  /** Whether a press that came by `via` would land too soon after the line was drawn. */
  tooSoon(via: 'key'): boolean;
  input(input: NotchPageInput): void;
  /** A click on the notch came, before any handler of the click itself. */
  clicked(): void;
  /** A hand came onto the line or left it, or a field was focused or left. */
  hand(): void;
  /** The notch is laid out anew, quickly, if the brain has spoken. */
  fit(): void;
}

export function createNotchInput(hooks: NotchInputHooks): { destroy(): void } {
  const { render } = hooks;
  const { root, wrap, notch, nin, sheetEl, optsEl, sentence, eyes, sounds } = render;

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
    if (scrub?.moved) scrubbed = hooks.now();
    scrub = null;
  };
  const onClick = (e: MouseEvent): void => {
    const word = liveOf(e.target);
    if (word) {
      if (hooks.now() - scrubbed > 250 && !hooks.answered()) sentence.cycle(word, 1);
      return;
    }
    // A press on "close" puts the notch to rest before this handler hears of it. What was pressed is gone
    // from the page by then, and that is how the two are told apart: only a click on the resting notch
    // itself opens it.
    if (!(e.target instanceof Node) || !e.target.isConnected) return;
    hooks.input({ kind: 'open' });
  };
  let lastWheel = 0;
  const onWheel = (e: WheelEvent): void => {
    const word = liveOf(e.target);
    if (!word || hooks.answered()) return;
    e.preventDefault();
    const now = hooks.now();
    if (now - lastWheel < 140) return;
    lastWheel = now;
    sentence.cycle(word, e.deltaY > 0 ? 1 : -1);
  };
  // Keys work whenever the page has the keyboard. Nothing depends on them.
  const onKey = (e: KeyboardEvent): void => {
    if (!hooks.open() || e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hooks.input({ kind: 'escape' });
      return;
    }
    // A line that only just appeared cannot be answered by a key already on its way down.
    if (hooks.tooSoon('key')) return;
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      hooks.input({ kind: 'enter' });
    } else if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      const target = optsEl.children[n - 1] ?? sheetEl.querySelector(`.btn[data-k="${n}"]`);
      if (target instanceof HTMLElement) { e.preventDefault(); target.click(); }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const word = liveOf(document.activeElement) ?? nin.querySelector<HTMLElement>('.live');
      if (word) { e.preventDefault(); sentence.cycle(word, e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1); }
    }
  };
  const onScroll = (): void => render.more();
  const onResize = (): void => { render.shape.fit(true); };
  // The number on a choice is a key only while the notch has the keyboard, which it has only while a text
  // field of its own is being typed in. At any other time a "2" goes to the app in front: the cap promised a
  // key that typed into the person's document. So the caps are shown only while the numbers reach the notch.
  // A choice can always be clicked.
  const syncKeyboard = (): void => {
    const has = typeof document.hasFocus === 'function' && document.hasFocus();
    if (root.classList.contains('notch-nokb') === !has) return;
    root.classList.toggle('notch-nokb', !has);
    hooks.fit();
  };
  root.classList.toggle('notch-nokb', !(typeof document.hasFocus === 'function' && document.hasFocus()));
  const onVisibility = (): void => render.visibility();
  const noteClick = (): void => hooks.clicked();
  const hand = (): void => hooks.hand();

  notch.addEventListener('pointerdown', onPointerDown);
  // A hand that comes onto the line, or a field that is typed in, is said to the brain as it happens.
  wrap.addEventListener('pointerenter', hand);
  wrap.addEventListener('pointerleave', hand);
  nin.addEventListener('focusin', hand);
  nin.addEventListener('focusout', hand);
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
  // A font is only fetched when text first uses it, which is after that text was measured: the first sentence
  // would be sized for the fallback font and left too wide. So the faces the notch writes in are asked for at
  // once, and whenever one arrives late the notch is measured again.
  const onFonts = (): void => hooks.fit();
  if (document.fonts) {
    for (const face of ['500 15px "Familjen Grotesk"', '600 15px "Familjen Grotesk"', '400 13.5px "Familjen Grotesk"', '500 12px "Spline Sans Mono"', '600 12px "Spline Sans Mono"']) {
      void document.fonts.load(face).catch(() => {});
    }
    void document.fonts.ready.then(onFonts);
    document.fonts.addEventListener?.('loadingdone', onFonts);
  }

  return {
    destroy() {
      document.removeEventListener('contextmenu', noMenu);
      document.removeEventListener('wheel', noZoom);
      document.removeEventListener('keydown', noBrowserKeys, true);
      notch.removeEventListener('pointerdown', onPointerDown);
      wrap.removeEventListener('pointerenter', hand);
      wrap.removeEventListener('pointerleave', hand);
      nin.removeEventListener('focusin', hand);
      nin.removeEventListener('focusout', hand);
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
    },
  };
}
