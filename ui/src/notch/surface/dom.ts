/**
 * Small DOM helpers shared by every part of the notch, the skeleton the
 * surface builds inside its root, and the two schedulers (frames and timers)
 * that let the whole surface be stopped in one place.
 */

export const SVGNS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | null): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function btn(cls: string, label: string | null, fn?: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  if (fn) b.onclick = fn;
  return b;
}

/** Finds a part of the skeleton. The skeleton is ours, so a miss is a bug, not a state. */
export function need<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`notch: missing ${selector}`);
  return found;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const EYE = '<b></b><svg class="arc" viewBox="0 0 10 7" aria-hidden="true"><path class="up" d="M1.6 5.6Q5-1.6 8.4 5.6"/><path class="dn" d="M1.6 1.4Q5 8.6 8.4 1.4"/></svg>';

/**
 * The notch's skeleton, as in the prototype, with classes where it had ids so
 * that two surfaces can live in one document (the tests do that).
 * The svg holds the silhouette; `.nin` holds what is said; `.measure` is where
 * a copy of it is laid out to learn its size; `.line` carries the bumps that
 * travel the top edge.
 */
export const SKELETON = `
<div class="wrap lineon" data-body="rest">
  <svg class="blob" width="148" height="70" aria-hidden="true"><path class="body"/><path class="lip"/><path class="burn"/><path class="trace"/><path class="meas"/></svg>
  <div class="notch" tabindex="-1">
    <div class="nin" data-body="rest" data-mood="idle" data-icon="0" data-mark="" data-wait="">
      <div class="bar">
        <div class="lead">
          <button class="eyes" type="button" aria-pressed="false" aria-label="Open Jarvis"><i class="eye l">${EYE}</i><i class="eye r">${EYE}</i></button>
          <span class="appicon" aria-hidden="true"></span>
          <span class="mark" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.6 6.7 11.6 12.5 5"/></svg></span>
          <span class="badge"></span>
        </div>
        <div class="say" aria-live="polite"></div>
        <div class="hint"></div>
      </div>
      <div class="pick"></div>
      <div class="opts"></div>
      <div class="sheet" role="region" aria-live="polite" aria-label="Jarvis"></div>
    </div>
  </div>
</div>
<div class="measure" aria-hidden="true" inert></div>
<svg class="line" aria-hidden="true"><g class="bumps"></g><g class="park"></g></svg>`;

export type FrameFn = (ts: number) => boolean;

/**
 * One animation loop for the whole surface. The prototype let the shape and
 * every bump ask for frames on their own. Here they share one loop, so the
 * outline can be reported once per frame, after everything in it has moved.
 * A function runs every frame until it returns false.
 */
export interface Frames {
  run(fn: FrameFn): void;
  drop(fn: FrameFn): void;
  /** True while a frame's functions are being called. */
  inFrame(): boolean;
  stop(): void;
}

export function createFrames(onFrameEnd: () => void): Frames {
  const live = new Set<FrameFn>();
  let raf = 0, inside = false, stopped = false;
  const ask = () => { if (!raf && !stopped && live.size) raf = requestAnimationFrame(step); };
  const step = (ts: number) => {
    raf = 0; inside = true;
    for (const fn of [...live]) { if (live.has(fn) && !fn(ts)) live.delete(fn); }
    inside = false;
    onFrameEnd();
    ask();
  };
  return {
    run(fn) { live.add(fn); if (!inside) ask(); },
    drop(fn) { live.delete(fn); },
    inFrame: () => inside,
    stop() { stopped = true; live.clear(); if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}

/** Every delayed step goes through here, so leaving the page leaves nothing behind. */
export interface Timers {
  after(ms: number, fn: () => void): number;
  cancel(id: number): void;
  clear(): void;
}

export function createTimers(): Timers {
  const ids = new Set<number>();
  return {
    after(ms, fn) {
      const id = window.setTimeout(() => { ids.delete(id); fn(); }, ms);
      ids.add(id);
      return id;
    },
    cancel(id) { window.clearTimeout(id); ids.delete(id); },
    clear() { ids.forEach(id => window.clearTimeout(id)); ids.clear(); },
  };
}
