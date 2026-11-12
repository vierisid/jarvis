/**
 * The line: Jarvis is drawn from the top edge of the screen. Things arrive and
 * leave along it as bumps of the notch's own ink, wait on it beside the notch
 * while the person cannot be disturbed, and the notch itself is born out of
 * it. Names and numbers are the prototype's.
 *
 * One difference: this page is a window as wide as the notch can grow, not
 * the screen. A bump starts just past the window's edge, not at the far side
 * of the display.
 */
import type { NotchArrival, NotchBirth } from '../../../../src/notch/protocol.ts';
import { SVGNS, clamp, type Frames, type Timers } from './dom.ts';
import type { Eyes } from './eyes.ts';
import { flattenPath, hanging, type Point } from './outline.ts';
import type { Shape } from './shape.ts';

/** A bump on the edge: `h` tall, `w` to each side of `x`. */
export const bumpD = (x: number, h: number, w = 36): string =>
  `M${x - w} 0 C${x - w * .36} 0 ${x - w * .42} ${h} ${x} ${h} C${x + w * .42} ${h} ${x + w * .36} 0 ${x + w} 0Z`;

export interface EdgeDeps {
  line: SVGSVGElement;
  blob: SVGSVGElement;
  nin: HTMLElement;
  frames: Frames;
  timers: Timers;
  shape: Shape;
  eyes: Eyes;
  reduce: boolean;
  width(): number;
  /** Told whenever a bump moved, came or went: the silhouette changed. */
  changed(): void;
}

export interface Edge {
  /** Something comes in along the edge and is swallowed; then it is said. */
  arrive(kind: NotchArrival, then: () => void): void;
  /** Something Jarvis sent leaves the same way. */
  depart(left: boolean): void;
  /** A new agent: the notch swells and a piece of it hops away. */
  bud(): void;
  /** How many things wait on the edge beside the notch. */
  park(count: number): void;
  birth(kind: NotchBirth, then: () => void): void;
  /** At once: the eyes never float without a body. */
  hide(): void;
  appear(): void;
  /** True while the notch's body is on screen. */
  shown(): boolean;
  moving(): boolean;
  /** Every bump as a polygon in the window's px, `inset` px inside its edge. */
  polygons(inset: number): Point[][];
}

interface Bump { el: SVGPathElement; d: string; h: number }

export function createEdge(deps: EdgeDeps): Edge {
  const { line, blob, nin, frames, timers, shape, eyes, reduce } = deps;
  const group = (cls: string): SVGGElement => {
    const g = line.querySelector<SVGGElement>('.' + cls);
    if (!g) throw new Error('notch: missing ' + cls);
    return g;
  };
  const bumpsG = group('bumps'), parkG = group('park');
  const live = new Set<Bump>();
  const parked: (Bump & { x: number })[] = [];
  let wanted = 0, hidden = false;

  function bump(o: { x0: number; x1: number; ms?: number; hop?: boolean; delay?: number; big?: number }, done?: () => void): void {
    if (reduce) { done?.(); return; }
    const { x0, x1, ms = 700, hop = false, delay = 0, big = 1 } = o;
    const b: Bump = { el: document.createElementNS(SVGNS, 'path'), d: '', h: 0 };
    bumpsG.append(b.el);
    live.add(b);
    const t0 = performance.now() + delay;
    frames.run((ts) => {
      const t = clamp((ts - t0) / ms, 0, 1), e = t * t * (3 - 2 * t);
      b.h = hop ? 3 + 9 * Math.abs(Math.sin(t * Math.PI * 3.5)) : (3 + 7 * Math.sin(Math.PI * Math.min(1, t * 1.2))) * big;
      b.d = ts < t0 ? '' : bumpD(x0 + (x1 - x0) * e, b.h);
      b.el.setAttribute('d', b.d);
      deps.changed();
      if (t < 1) return true;
      b.el.remove();
      live.delete(b);
      deps.changed();
      done?.();
      return false;
    });
  }

  function arrive(kind: NotchArrival, then: () => void): void {
    const left = kind !== 'right', box = shape.box();
    eyes.setMood('look');
    eyes.glance(left);
    const land = (): void => { shape.kick(230); then(); };
    if (reduce) { timers.after(200, land); return; }
    const x0 = left ? -44 : deps.width() + 44, x1 = left ? box.left - 2 : box.right + 2;
    // It leans toward what is coming.
    shape.N.vox += left ? -70 : 70;
    shape.wake();
    if (kind === 'urgent') {
      // Two, fast.
      bump({ x0, x1, ms: 380, big: 1.25 });
      bump({ x0, x1, ms: 380, delay: 170, big: 1.25 }, land);
      return;
    }
    bump({ x0, x1, ms: kind === 'hop' ? 950 : 700, hop: kind === 'hop' }, land);
  }

  function depart(left: boolean): void {
    if (reduce) return;
    const box = shape.box();
    shape.N.vh -= 150;
    shape.wake();
    bump({ x0: left ? box.left + 4 : box.right - 4, x1: left ? -50 : deps.width() + 50, ms: 640 });
  }

  function bud(): void {
    if (reduce) return;
    const box = shape.box();
    shape.N.vw += 260;
    shape.N.vox -= 60;
    shape.wake();
    timers.after(240, () => bump({ x0: box.left + 6, x1: -50, ms: 1200, hop: true }));
  }

  function park(count: number): void {
    wanted = Math.max(0, Math.min(8, Math.floor(count)));
    const box = shape.box();
    // More to hold: each comes in along the edge and stays beside the notch.
    for (let i = parked.length + live.size; i < wanted && parked.length + live.size < wanted; i++) {
      const left = i % 2 === 0, k = Math.floor(i / 2);
      const x = left ? box.left - 30 - 34 * k : box.right + 30 + 34 * k;
      const settle = (): void => {
        if (parked.length >= wanted) return;
        const p: Bump & { x: number } = { el: document.createElementNS(SVGNS, 'path'), d: bumpD(x, 5, 16), h: 5, x };
        p.el.setAttribute('d', p.d);
        parkG.append(p.el);
        parked.push(p);
        deps.changed();
      };
      if (reduce) settle(); else bump({ x0: left ? -44 : deps.width() + 44, x1: x, ms: 620 }, settle);
    }
    // Fewer: they are pulled in, one after another.
    let n = 0;
    while (parked.length > wanted) {
      const p = parked.pop();
      if (!p) break;
      const into = p.x < box.left ? box.left + 4 : box.right - 4, delay = n++ * 190;
      timers.after(delay, () => { p.el.remove(); deps.changed(); });
      bump({ x0: p.x, x1: into, ms: 300, delay, big: .7 }, () => shape.kick(150));
    }
  }

  function hide(): void {
    hidden = true;
    nin.style.transition = 'none';
    nin.style.opacity = '0';
    blob.style.opacity = '0';
    void nin.offsetWidth;
    nin.style.transition = '';
    deps.changed();
  }

  function appear(): void {
    hidden = false;
    blob.style.opacity = '';
    nin.style.opacity = '';
    deps.changed();
  }

  /** The body alone comes back; what it says stays unseen a little longer. */
  function bodyBack(): void {
    hidden = false;
    blob.style.opacity = '';
    deps.changed();
  }

  function birth(kind: NotchBirth, then: () => void): void {
    const w = shape.N.tw, h = shape.N.th, cx = deps.width() / 2;
    const open = (): void => { appear(); shape.fit(); then(); };
    if (reduce) { open(); return; }
    hide();
    shape.morph(40, 8, true);
    if (kind === 'meet') {
      // Two come from both sides and meet.
      bump({ x0: -44, x1: cx - 12, ms: 900 });
      bump({ x0: deps.width() + 44, x1: cx + 12, ms: 900 }, () => { shape.kick(270); open(); });
      return;
    }
    if (kind === 'eye') {
      // A flat lid on the edge opens like an eye.
      shape.morph(w, 8, true);
      bodyBack();
      timers.after(520, () => { shape.kick(160); open(); });
      return;
    }
    if (kind === 'gather') {
      // The edge gathers itself from both sides.
      for (const i of [0, 1, 2]) {
        bump({ x0: -44, x1: cx - 10, ms: 760, delay: i * 210, big: .6 }, () => shape.kick(90));
        bump({ x0: deps.width() + 44, x1: cx + 10, ms: 760, delay: i * 210, big: .6 }, i === 2 ? () => { shape.kick(240); open(); } : undefined);
      }
      timers.after(760, bodyBack);
      return;
    }
    if (kind === 'bead') {
      // A bead on the edge swells.
      shape.morph(12, 8, true);
      bodyBack();
      timers.after(420, () => { shape.kick(220); open(); });
      return;
    }
    if (kind === 'trace') {
      // The outline is drawn, then what is inside appears.
      shape.morph(w, h, true);
      blob.style.setProperty('--blen', String(shape.traceLength()));
      blob.classList.add('tracing');
      bodyBack();
      shape.draw();
      timers.after(780, () => { blob.classList.remove('tracing'); nin.style.opacity = ''; then(); });
      return;
    }
    // One runs in from the side and opens.
    bump({ x0: -44, x1: cx, ms: 950 }, () => { shape.kick(230); open(); });
  }

  function polygons(inset: number): Point[][] {
    const out: Point[][] = [];
    const scale = window.devicePixelRatio || 1;
    for (const b of [...live, ...parked]) {
      // A bump thinner than the way in has no inside.
      if (!b.d || (inset > 0 && b.h <= inset + .5)) continue;
      const points = hanging(flattenPath(b.d, scale), inset);
      if (points.length >= 3) out.push(points);
    }
    return out;
  }

  return { arrive, depart, bud, park, birth, hide, appear, polygons, shown: () => !hidden, moving: () => live.size > 0 };
}
