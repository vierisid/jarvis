/**
 * The notch is a drop of ink: two springs move it, and its edges bow with
 * their speed. One svg path is rewritten every frame from the springs. Names
 * and numbers are the prototype's, so the two can be compared line by line.
 */
import type { NotchGesture, NotchMood } from '../../../../src/notch/protocol.ts';
import { clamp, type Frames } from './dom.ts';

export type LipMode = 'talk' | 'mouth' | 'think' | 'pump' | 'ripple' | 'shiver' | 'laugh' | 'gasp' | 'zip' | 'yawn' | 'reach';

/** Everything that moves. w, h are the size now; tw, th where it is going; the v's are speeds. */
export interface ShapeState {
  w: number; h: number; vw: number; vh: number; tw: number; th: number; t: number; fast: boolean;
  /** The lower edge: how far it smiles or frets, and which way it leans. */
  lip: number; lipT: number; lean: number; leanT: number;
  /** Sideways: the whole notch shakes for no. */
  ox: number; vox: number;
  /** The shoulders lift in a shrug. */
  shr: number; vshr: number;
  wave: number[] | null; tgt: number[] | null; mode: LipMode | null; back: LipMode | null; m0: number; aim: number;
  breath: boolean; dnW: boolean; dnH: boolean; wide: boolean;
}

/** How many points of the lower edge can move on their own. */
export const WK = 13;

/** ways the lower edge can move. u runs 0..1 along the lip, t is seconds since it started */
export const MODES: Record<LipMode, (N: ShapeState, u: number, t: number, i: number) => number> = {
  talk: (N, _u, _t, i) => (N.tgt ? N.tgt[i] ?? 0 : 0),                                                // follows your voice
  mouth: (N, u, t) => (N.wide ? 12 : 6) * Math.min(1, t * 5) * Math.pow(Math.sin(Math.PI * u), 1.4),   // open for a file, wider when it is right under it
  think: (_N, u, t) => 1.7 * Math.sin(u * 9 - t * 5) * Math.sin(Math.PI * u),                          // a slow wave runs along it
  pump: (_N, u, t) => 2.4 * Math.max(0, Math.sin(t * 12)) * Math.sin(Math.PI * u),                     // a steady beat while it works
  ripple: (_N, u, t) => 4.6 * Math.exp(-Math.pow((u - t * 1.9 + .15) / .13, 2)),                       // one bump runs across: something landed
  shiver: (_N, u, t) => 1.5 * Math.sin(u * 38 + t * 62) * Math.max(0, 1 - t * 2),                      // a quick tremble: something went wrong
  laugh: (_N, u, t) => (2.2 + 3.4 * Math.abs(Math.sin(t * 15))) * Math.sin(Math.PI * u) * Math.max(0, 1 - t / 1.25),   // the smile bounces
  gasp: (_N, u, t) => 4.6 * Math.sin(Math.min(1, t / 1.05) * Math.PI) * Math.exp(-Math.pow((u - .5) / .17, 2)),        // a small round "oh"
  zip: (_N, _u, t, i) => (i % 2 ? 1.5 : -.6) * Math.min(1, t * 6) * Math.max(0, Math.min(1, (1.5 - t) * 4)),           // lips zipped: it will stay quiet
  yawn: (_N, u, t) => 8.5 * Math.pow(Math.sin(Math.min(1, t / 1.5) * Math.PI), 2) * Math.pow(Math.sin(Math.PI * u), 2), // a wide, slow one on waking
  reach: (N, u, t) => 6.5 * Math.sin(Math.min(1, t / .95) * Math.PI) * Math.exp(-Math.pow((u - N.aim) / .19, 2)),      // it leans down toward the thing it means
};
/** The one-shot ways end by themselves after this many seconds; the others run until stopped. */
export const ENDS: Partial<Record<LipMode, number>> = { ripple: .78, shiver: .55, reach: .95, laugh: 1.25, gasp: 1.05, zip: 1.5, yawn: 1.5 };

/** What the path is drawn from at one instant. */
export interface BodyShape {
  w: number; h: number;
  /** A sheet or the ask panel: rounder bottom corners. */
  big: boolean;
  shr: number;
  /** The bottom sags and the sides bow with the speed of the springs. */
  sag: number; bow: number;
  lip: number; lean: number;
  wave: readonly number[] | null;
}

/** The svg x of the notch's left edge: room for a shoulder and a shake. */
export const OX = 30;

/**
 * The silhouette. `body` is the whole closed shape with its flared shoulders,
 * `lip` the bottom part only, `edge` the open line from the left shoulder
 * round to the right one. With `inset` the same three are drawn that many px
 * inside the real edge (the top stays where it is).
 *
 * Why an inset exists at all: the window is cut a pixel and a half inside the
 * outline, so a stroke drawn on the edge itself, as the prototype drew its
 * fuse, would be cut away. What has to be seen is drawn just inside.
 */
export function bodyPaths(s: BodyShape, inset = 0): { body: string; lip: string; edge: string } {
  const { w, h } = s;
  const sh = Math.max(4, Math.min(h * .8, w * .4, 12 + clamp((w - 88) / 420, 0, 1) * 5) + s.shr);
  const r0 = Math.min(s.big ? 22 : 16, h / 2, w / 2);
  if (inset && (w - 2 * inset < 6 || h - inset < 6)) return { body: '', lip: '', edge: '' };
  const r = inset ? Math.max(1, r0 - inset) : r0, hh = h - inset;
  const L = OX + inset, R = OX + w - inset, my = (sh + hh - r) / 2, span = R - L - 2 * r, curve = (s.sag + s.lip) * 2;
  let bot = `Q${L + r + span * (.5 + s.lean * .38)} ${hh + curve} ${R - r} ${hh}`;
  if (s.wave) {
    let px = L + r, py = hh; bot = '';
    for (let i = 0; i < WK; i++) {
      const u = (i + 1) / (WK + 1), x = L + r + span * u, y = hh + (s.wave[i] ?? 0) + curve * 2 * u * (1 - u);
      bot += `Q${px} ${py} ${(px + x) / 2} ${(py + y) / 2} `; px = x; py = y;
    }
    bot += `Q${px} ${py} ${R - r} ${hh}`;
  }
  const u = `M${L} ${sh} Q${L - s.bow} ${my} ${L} ${hh - r} Q${L} ${hh} ${L + r} ${hh} ${bot} Q${R} ${hh} ${R} ${hh - r} Q${R + s.bow} ${my} ${R} ${sh}`;
  return {
    body: `M${L - sh} 0 Q${L} 0 ${u.slice(1)} Q${R} 0 ${R + sh} 0Z`,
    lip: `M${L} ${hh - r} Q${L} ${hh} ${L + r} ${hh} ${bot} Q${R} ${hh} ${R} ${hh - r}`,
    edge: u,
  };
}

/** How far inside the real edge the fuse and the birth line are drawn: the cut (1.5) plus half the fuse's width. */
export const FUSE_IN = 2.7;
/** The same for the lit lip of the mouth, which is thinner. */
const LIP_IN = 2.3;

export interface ShapeDeps {
  wrap: HTMLElement; notch: HTMLElement; nin: HTMLElement; measure: HTMLElement; blob: SVGSVGElement;
  frames: Frames;
  reduce: boolean;
  /** The width of the window, in px: the notch hangs from the middle of it. */
  width(): number;
  /** Told whenever the silhouette was redrawn. */
  changed(): void;
}

export interface Shape {
  N: ShapeState;
  draw(now?: number): void;
  wake(): void;
  morph(w: number, h: number, instant?: boolean): void;
  kick(v: number): void;
  fit(instant?: boolean, fast?: boolean): void;
  morphPlay(mode: LipMode, o?: { aim?: number }): void;
  morphStop(): void;
  shapeFor(m: NotchMood): void;
  shapeGesture(g: NotchGesture): void;
  burn(ms: number): void;
  /** The mouth that takes a file: the notch is measured that much bigger while it is open. */
  setFeeding(on: boolean): void;
  /** The birth that draws the outline first: returns the length of that line. */
  traceLength(): number;
  /** True while the springs or the lip are still moving. */
  running(): boolean;
  /** Where the notch's box is, in the window's px. */
  box(): { left: number; right: number; bottom: number; width: number };
  /** The path as drawn, and the window x of its own x = 0. */
  current(): { d: string; x: number; w: number; h: number };
}

export function createShape(deps: ShapeDeps): Shape {
  const { wrap, notch, nin, measure, blob, frames, reduce } = deps;
  const path = (cls: string): SVGPathElement => {
    const p = blob.querySelector<SVGPathElement>('.' + cls);
    if (!p) throw new Error('notch: missing path ' + cls);
    return p;
  };
  const pBody = path('body'), pLip = path('lip'), pBurn = path('burn'), pTrace = path('trace'), pMeas = path('meas');
  const N: ShapeState = {
    w: 88, h: 30, vw: 0, vh: 0, tw: 88, th: 30, t: 0, fast: false, lip: 0, lipT: 0, lean: 0, leanT: 0, ox: 0, vox: 0, shr: 0, vshr: 0,
    wave: null, tgt: null, mode: null, back: null, m0: 0, aim: .5, breath: false, dnW: false, dnH: false, wide: false,
  };
  let ticking = false, feeding = false, lastD = '', lastH = 30;

  const isBig = () => wrap.dataset.body === 'sheet' || wrap.dataset.body === 'ask';

  function draw(now = 0): void {
    const w = N.w, hh = Math.max(8, N.h), h = hh + (N.breath ? Math.sin(now / 950) * .9 : 0);
    const s: BodyShape = { w, h, big: isBig(), shr: N.shr, sag: clamp(N.vh * .013, 0, 7), bow: clamp(N.vw * .006, 0, 4), lip: N.lip, lean: N.lean, wave: N.wave };
    const p = bodyPaths(s);
    pBody.setAttribute('d', p.body);
    // The lit lip of the open mouth has to be seen, so it moves inside the cut. The plain one is the prototype's rim.
    pLip.setAttribute('d', wrap.classList.contains('over') ? bodyPaths(s, LIP_IN).lip : p.lip);
    if (wrap.classList.contains('fusing') || blob.classList.contains('tracing')) {
      const inner = bodyPaths(s, FUSE_IN).edge;
      pBurn.setAttribute('d', inner); pTrace.setAttribute('d', inner);
    }
    blob.setAttribute('width', String(w + 60)); blob.setAttribute('height', String(h + 48));
    notch.style.width = w + 'px'; notch.style.height = hh + 'px';
    wrap.style.transform = Math.abs(N.ox) > .05 ? `translateX(calc(-50% + ${N.ox.toFixed(2)}px))` : '';
    lastD = p.body; lastH = h;
    deps.changed();
  }

  function tick(ts: number): boolean {
    const dt = Math.min(.032, Math.max(.001, (ts - N.t) / 1000)); N.t = ts;
    const quick = N.fast || wrap.classList.contains('talk');
    // grows with a little life, shrinks without pinching
    const kh = quick ? 620 : N.dnH ? 520 : 300, ch = quick ? 46 : N.dnH ? 45.6 : N.th < N.h ? 35 : 24;
    const kw = quick ? 620 : N.dnW ? 520 : 250, cw = quick ? 46 : N.dnW ? 45.6 : N.tw < N.w ? 33 : 23;
    N.vh += (kh * (N.th - N.h) - ch * N.vh) * dt; N.h += N.vh * dt;
    N.vw += (kw * (N.tw - N.w) - cw * N.vw) * dt; N.w += N.vw * dt;
    N.vox += (-430 * N.ox - 15 * N.vox) * dt; N.ox += N.vox * dt;
    N.vshr += (-380 * N.shr - 17 * N.vshr) * dt; N.shr += N.vshr * dt;
    N.lip += (N.lipT - N.lip) * Math.min(1, dt * 9); N.lean += (N.leanT - N.lean) * Math.min(1, dt * 8);
    if (N.mode) {
      const t = (ts - N.m0) / 1000, end = ENDS[N.mode];
      if (end && t > end) { N.mode = N.back; N.back = null; N.m0 = ts; if (!N.mode) N.wave = null; }
      else {
        const wave = N.wave ?? (N.wave = new Array<number>(WK).fill(0)), fn = MODES[N.mode];
        for (let i = 0; i < WK; i++) { const v = fn(N, (i + 1) / (WK + 1), t, i), was = wave[i] ?? 0; wave[i] = was + (v - was) * Math.min(1, dt * 24); }
      }
    }
    const still = !N.mode && !N.breath && Math.abs(N.lipT - N.lip) < .05 && Math.abs(N.leanT - N.lean) < .01 && Math.abs(N.ox) < .1 && Math.abs(N.vox) < 2
      && Math.abs(N.shr) < .1 && Math.abs(N.vshr) < 2 && Math.abs(N.th - N.h) < .5 && Math.abs(N.tw - N.w) < .5 && Math.abs(N.vh) < 3 && Math.abs(N.vw) < 3;
    if (still) {
      N.w = N.tw; N.h = N.th; N.lip = N.lipT; N.lean = N.leanT; N.ox = N.vox = N.shr = N.vshr = N.vw = N.vh = 0;
      ticking = false; draw(ts);
      return false;
    }
    draw(ts);
    return true;
  }

  function wake(): void {
    if (ticking) return;
    ticking = true; N.t = performance.now(); frames.run(tick);
  }

  function morph(w: number, h: number, instant?: boolean): void {
    N.dnW = w < N.w - .5; N.dnH = h < N.h - .5; N.tw = w; N.th = h;
    if (instant || reduce) {
      // Only the size snaps. The prototype also stopped its frame loop here,
      // which froze a lip that was talking until something woke it. Here
      // whatever else is moving goes on, and settles by itself.
      N.w = w; N.h = h; N.vw = N.vh = 0;
      return draw(N.t);
    }
    wake();
  }

  /** a gulp: the bottom edge bulges and settles */
  function kick(v: number): void { if (reduce) return; N.dnH = false; N.vh += v; wake(); }

  function fit(instant?: boolean, fast?: boolean): void {
    // The copy is laid out as the notch is: with the held pair of keys in it
    // while they are held.
    measure.classList.toggle('att', wrap.classList.contains('att'));
    const c = nin.cloneNode(true) as HTMLElement;
    measure.append(c);
    const r = c.getBoundingClientRect();
    c.remove();
    N.fast = !!fast;
    morph(2 * Math.ceil(r.width / 2) + (feeding ? 54 : 0), Math.ceil(r.height) + (feeding ? 8 : 0), instant);
  }

  function morphPlay(mode: LipMode, o?: { aim?: number }): void {
    if (reduce) return;
    if (ENDS[mode] && N.mode && !ENDS[N.mode]) N.back = N.mode;
    N.mode = mode; N.m0 = performance.now(); N.aim = o?.aim ?? .5; wake();
  }
  function morphStop(): void { N.mode = null; N.back = null; N.wave = null; if (!reduce) wake(); }

  /** every look has a shape as well as eyes: the lip smiles, frets, smirks, thinks, works, breathes */
  function shapeFor(m: NotchMood): void {
    if (reduce) { N.lipT = N.leanT = 0; N.breath = false; if (N.mode && N.mode !== 'talk') morphStop(); return; }
    N.lipT = m === 'happy' ? 4 : m === 'proud' ? 5 : m === 'worried' ? -3 : m === 'sorry' ? -2.2 : m === 'careful' ? -1.6 : m === 'confused' ? -1.8 : m === 'curious' ? 3 : m === 'urgent' ? 1.5 : 0;
    N.leanT = m === 'curious' ? .8 : m === 'careful' ? -.6 : m === 'confused' ? -.8 : 0;
    N.breath = m === 'closed';
    const mode: LipMode | null = m === 'think' || m === 'search' || m === 'recall' ? 'think' : m === 'work' || m === 'track' ? 'pump' : null;
    if (N.mode !== 'talk' && N.mode !== 'mouth' && !(N.mode && ENDS[N.mode])) { if (mode && N.mode !== mode) morphPlay(mode); else if (!mode && N.mode) morphStop(); }
    else if (N.mode && ENDS[N.mode]) N.back = mode;
    const was = nin.dataset.mood;
    if (m === 'worried' && was !== 'worried') morphPlay('shiver');
    else if (m === 'surprised' && was !== 'surprised') morphPlay('gasp');
    else if (m === 'confused' && was !== 'confused') N.vshr += 150;   // a shrug: the shoulders lift
    wake();
  }

  /** the body answers too: it shakes for no, pops when surprised, stretches awake */
  function shapeGesture(g: NotchGesture): void {
    if (reduce) return;
    if (g === 'shake') N.vox += 210;
    else if (g === 'pop') { N.vh += 120; N.vw += 230; }
    else if (g === 'hop') N.vh -= 170;
    else if (g === 'wake') { N.vh += 250; N.vw -= 200; morphPlay('yawn'); }
    else if (g === 'shrug') N.vshr += 170;
    else if (g === 'doze') N.vh += 300;
    else return;
    wake();
  }

  const lengthOf = (p: SVGPathElement, guess: number): number => {
    try { const len = p.getTotalLength(); return Number.isFinite(len) && len > 0 ? len : guess; } catch { return guess; }
  };
  const settled = (): BodyShape => ({ w: N.tw, h: N.th, big: false, shr: 0, sag: 0, bow: 0, lip: 0, lean: 0, wave: null });

  /** a true timer: the dash is exactly as long as the edge it burns along, measured at the size the notch is settling to */
  function burn(ms: number): void {
    const inner = bodyPaths(settled(), FUSE_IN).edge;
    pMeas.setAttribute('d', inner);
    const len = Math.ceil(lengthOf(pMeas, 2 * N.th + N.tw)) + 2;
    pBurn.style.strokeDasharray = String(len);
    wrap.style.setProperty('--len', String(len)); wrap.style.setProperty('--fuse', ms + 'ms');
    wrap.classList.add('fusing');
    pBurn.setAttribute('d', inner);
    draw(N.t);
  }

  function traceLength(): number {
    const inner = bodyPaths({ ...settled(), big: isBig() }, FUSE_IN).edge;
    pTrace.setAttribute('d', inner);
    return Math.ceil(lengthOf(pTrace, 2 * N.th + N.tw)) + 4;
  }

  const centre = () => deps.width() / 2;

  return {
    N, draw, wake, morph, kick, fit, morphPlay, morphStop, shapeFor, shapeGesture, burn, traceLength,
    setFeeding(on) { feeding = on; },
    running: () => ticking,
    box() { const left = centre() - N.w / 2; return { left, right: left + N.w, bottom: Math.max(8, N.h), width: N.w }; },
    current() { return { d: lastD, x: centre() - N.w / 2 + (Math.abs(N.ox) > .05 ? N.ox : 0) - OX, w: N.w, h: lastH }; },
  };
}
