/**
 * The eyes: two bars with a small library of looks and gestures. A look is a
 * value of `data-mood` on the notch, drawn by the stylesheet; a gesture is a
 * class that plays once. Names and timings are the prototype's.
 */
import type { NotchGesture, NotchMood } from '../../../../src/notch/protocol.ts';
import type { Timers } from './dom.ts';
import type { Shape } from './shape.ts';

/** The looks in which the eyes follow the pointer. */
const FOLLOW: ReadonlySet<string> = new Set(['idle', 'look', 'listen', 'urgent', 'curious', 'careful', 'surprised']);

export interface EyesDeps {
  nin: HTMLElement;
  eyes: HTMLElement;
  shape: Shape;
  timers: Timers;
  reduce: boolean;
  /** True while something is on the notch: waking up then looks at it. */
  busy(): boolean;
}

export interface Eyes {
  setMood(m: NotchMood): void;
  mood(): NotchMood;
  gaze(x: number, y: number): void;
  /** Turns the eyes to one side by hand, for something coming along the edge. */
  glance(left: boolean): void;
  gesture(g: NotchGesture, ms?: number): void;
  /** The pointer moved: the eyes follow it, not on every move, and settle when it rests. */
  pointer(x: number, y: number): void;
}

export function createEyes(deps: EyesDeps): Eyes {
  const { nin, eyes, shape, timers, reduce } = deps;
  const centre = (): void => { eyes.style.setProperty('--px', '0px'); eyes.style.setProperty('--py', '0px'); };
  const mood = (): NotchMood => (nin.dataset.mood ?? 'idle') as NotchMood;

  function setMood(m: NotchMood): void {
    shape.shapeFor(m);
    if (nin.dataset.mood !== m && !reduce) {
      eyes.classList.add('sq');
      timers.after(80, () => eyes.classList.remove('sq'));
    }
    nin.dataset.mood = m;
    if (!FOLLOW.has(m) && m !== 'track') centre();
  }

  function gaze(x: number, y: number): void {
    const r = eyes.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 240);
    eyes.style.setProperty('--px', (dx / d * 2.3 * k).toFixed(2) + 'px');
    eyes.style.setProperty('--py', (dy / d * 1.8 * k).toFixed(2) + 'px');
  }

  function gesture(g: NotchGesture, ms = 520): void {
    if (reduce) return;
    shape.shapeGesture(g);
    if (g === 'wake') {
      setMood('sleepy');
      timers.after(800, () => {
        setMood(deps.busy() ? (mood() === 'sleepy' ? 'look' : mood()) : 'idle');
        gesture('blink', 120);
        timers.after(260, () => gesture('blink', 120));
        timers.after(700, () => gesture('peek-l', 420));
        timers.after(1200, () => gesture('peek-r', 420));
      });
      return;
    }
    if (g === 'doze') {
      setMood('sleepy');
      timers.after(1100, () => setMood('closed'));
      return;
    }
    // The shrug is the shoulders' alone.
    if (g === 'shrug') return;
    eyes.classList.remove(g);
    void eyes.offsetWidth;
    eyes.classList.add(g);
    timers.after(ms, () => eyes.classList.remove(g));
  }

  let lastMove = 0, lastDart = 0, dartTimer = 0, calmTimer = 0;
  function pointer(x: number, y: number): void {
    if (reduce) return;
    const now = lastMove = performance.now();
    const dart = (): void => { lastDart = performance.now(); if (FOLLOW.has(mood())) gaze(x, y); };
    timers.cancel(dartTimer);
    if (now - lastDart > 140) dart(); else dartTimer = timers.after(150, dart);
    timers.cancel(calmTimer);
    calmTimer = timers.after(2400, () => { if (mood() !== 'track') centre(); });
  }

  // A little life of its own: it blinks, and now and then looks to a side.
  (function life(): void {
    timers.after(2600 + Math.random() * 3600, () => {
      const m = mood();
      if (!reduce && (m === 'idle' || m === 'look' || m === 'listen' || m === 'careful' || m === 'curious')) {
        const r = Math.random();
        if (r < .6) gesture('blink', 120);
        else if (r < .8) { gesture('blink', 120); timers.after(250, () => gesture('blink', 120)); }
        else if (m === 'idle' && performance.now() - lastMove > 1500) gesture(r < .9 ? 'peek-l' : 'peek-r', 640);
        else gesture('blink', 120);
      }
      life();
    });
  })();

  return {
    setMood, mood, gaze, gesture, pointer,
    glance(left) { eyes.style.setProperty('--px', left ? '-2.4px' : '2.4px'); eyes.style.setProperty('--py', '-.6px'); },
  };
}
