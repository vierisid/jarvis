/** UI-07 native motion contract. Durations are design tokens, not frame-rate claims. */
export const BRIEF_MOTION = {
  press: { enter: 100, exit: 80 },
  reveal: { enter: 200, exit: 160 },
  selection: { enter: 180, exit: 180 },
  reflow: { enter: 320, exit: 280 },
  transfer: { enter: 280, exit: 220 },
  settle: { enter: 180, exit: 160 },
} as const;
export type MotionKind = keyof typeof BRIEF_MOTION;
export const BRIEF_EASE_OUT = "cubic-bezier(0, 0, 0.58, 1)";
export const briefMotionVariables = Object.fromEntries([
  ["--brief-motion-ease", BRIEF_EASE_OUT],
  ...Object.entries(BRIEF_MOTION).flatMap(([name, timing]) => [
    [`--brief-motion-${name}-in`, `${timing.enter}ms`],
    [`--brief-motion-${name}-out`, `${timing.exit}ms`],
  ]),
]);

/** No scale, blur or text/color interpolation. Width/height are for bounded surfaces only. */
export type MotionTarget = Partial<{ transform: string; opacity: number; width: number; height: number }>;
type Property = keyof MotionTarget;
type Values = Partial<Record<Property, string>>;
export interface MotionSample {
  kind: MotionKind;
  active: boolean;
  reduced: boolean;
  duration: number;
  interrupted: boolean;
  from: Values;
  to: Values;
  started: Values;
}
export interface MotionOptions {
  kind: MotionKind;
  active: boolean;
  reduced?: boolean;
  immediate?: boolean;
  onSample?: (sample: MotionSample) => void;
}

/** A thin WAAPI adapter. One animation per owned element; never a queue or timeline engine.
 * Keep the same properties across calls. The wrapper owns only those inline properties.
 * Semantic state/focus/inert are the caller's responsibility and must update immediately.
 */
export function createBriefMotion(element: HTMLElement) {
  let animation: Animation | null = null;
  let disposed = false;
  const originals = new Map<Property, string>();
  function stop() {
    if (!animation) return;
    animation.onfinish = null;
    animation.cancel();
    animation = null;
  }
  function to(target: MotionTarget, options: MotionOptions) {
    if (disposed) return;
    const keys = Object.keys(target) as Property[];
    const read = () => {
      const style = getComputedStyle(element);
      return Object.fromEntries(keys.map(key => [key, style[key]])) as Values;
    };
    // Read BEFORE cancelling: a reversal starts at the current rendered frame.
    const from = read();
    const interrupted = animation?.playState === "running" || animation?.pending === true;
    stop();
    const to: Values = {};
    for (const key of keys) {
      if (!originals.has(key)) originals.set(key, element.style[key]);
      const value = target[key]!;
      to[key] = key === "width" || key === "height" ? `${value}px` : String(value);
      element.style[key] = to[key]!;
    }
    const duration = options.reduced || options.immediate ? 0 : BRIEF_MOTION[options.kind][options.active ? "enter" : "exit"];
    const destination = read();
    const changed = keys.some(key => from[key] !== destination[key]);
    // The final style is already committed. No completion callback can change business state.
    // Unsupported WAAPI gets the same usable endpoint without an animation polyfill.
    if (changed && duration && typeof element.animate === "function") {
      animation = element.animate([from, to], { duration, easing: BRIEF_EASE_OUT, fill: "none" });
      // WAAPI rejects finished on cancel. Reversal/unmount is expected, not an app error.
      void animation.finished.catch(() => {});
      const current = animation;
      current.onfinish = () => { if (animation === current) { stop(); } };
    }
    options.onSample?.({ kind: options.kind, active: options.active, reduced: !!options.reduced,
      duration: animation ? duration : 0, interrupted, from, to, started: read() });
  }
  return {
    to,
    /** Snap to the latest committed endpoint, e.g. when an OS preference changes. */
    finish: stop,
    dispose() {
      stop();
      for (const [key, value] of originals) element.style[key] = value;
      disposed = true;
    },
  };
}
