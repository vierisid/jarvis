import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createBriefMotion, type MotionOptions, type MotionTarget } from "./motion";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const snapshot = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia(REDUCED_MOTION_QUERY).matches : true;
function subscribe(callback: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

/** Local examples can request less motion, never override an OS request for less. */
export function useBriefReducedMotion(forceReduced = false) {
  const systemReduced = useSyncExternalStore(subscribe, snapshot, () => true);
  return forceReduced || systemReduced;
}

/** No mount choreography. On later intents, retarget the same owned wrapper in layout effect.
 * Use translation on text-bearing objects, bounded width/height on surfaces; never scale text.
 * Keep the ref mounted during exits; update aria-hidden/inert immediately when hiding controls.
 */
export function useBriefMotion<T extends HTMLElement = HTMLDivElement>(target: MotionTarget,
  options: MotionOptions) {
  const ref = useRef<T>(null);
  const controller = useRef<ReturnType<typeof createBriefMotion> | null>(null);
  const mounted = useRef(false);
  const observer = useRef(options.onSample);
  const reduced = useBriefReducedMotion(options.reduced);
  useLayoutEffect(() => { observer.current = options.onSample; });
  useLayoutEffect(() => {
    if (!ref.current) return;
    controller.current = createBriefMotion(ref.current);
    return () => { controller.current?.dispose(); controller.current = null; mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    controller.current?.to(target, { kind: options.kind, active: options.active, reduced,
      immediate: !mounted.current || options.immediate, onSample: observer.current });
    mounted.current = true;
  }, [target.transform, target.opacity, target.width, target.height, options.kind, options.active, options.immediate, reduced]);
  return ref;
}
