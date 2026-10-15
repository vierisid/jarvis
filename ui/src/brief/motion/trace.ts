import type { MotionSample } from "./motion";

/** Reference harness only. Browser rAF samples, not a DevTools CPU/GPU performance trace. */
export function recordMotionTrace(root: HTMLElement, reduced: boolean) {
  const started = performance.now();
  const frames: { at: number; delta: number; activeAnimations: number; maxAnchorDrift: number }[] = [];
  const transitions: (MotionSample & { at: number })[] = [];
  const inputs: { at: number; active: boolean }[] = [];
  const anchors = [...root.querySelectorAll<HTMLElement>("[data-motion-anchor]")].map(node => ({ node, rect: node.getBoundingClientRect() }));
  let previous = started, raf = 0, backgrounded = document.hidden;
  const visibility = () => { backgrounded ||= document.hidden; };
  document.addEventListener("visibilitychange", visibility);
  function frame(now: number) {
    let drift = 0;
    for (const { node, rect } of anchors) {
      const next = node.getBoundingClientRect();
      drift = Math.max(drift, Math.abs(next.x - rect.x), Math.abs(next.y - rect.y));
    }
    frames.push({ at: now - started, delta: now - previous,
      activeAnimations: root.getAnimations({ subtree: true }).length, maxAnchorDrift: drift });
    previous = now;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return {
    sample(sample: MotionSample) { transitions.push({ at: performance.now() - started, ...sample }); },
    input(active: boolean) { inputs.push({ at: performance.now() - started, active }); },
    stop() {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibility);
      const activeAnimations = root.getAnimations({ subtree: true }).length;
      const parts = [...root.querySelectorAll<HTMLElement>("[data-motion-part]")].map(node => {
        const computed = getComputedStyle(node);
        const target = ["transform", "opacity", "width", "height"] as const;
        const endpointMatches = target.filter(key => node.style[key]).every(key => {
          if (key !== "transform") return Math.abs(parseFloat(computed[key]) - parseFloat(node.style[key])) < .5;
          const actual = new DOMMatrix(computed.transform), expected = new DOMMatrix(node.style.transform);
          return ["a", "b", "c", "d", "e", "f"].every(part => Math.abs(actual[part as "a"] - expected[part as "a"]) < .01);
        });
        return { name: node.dataset.motionPart, endpointMatches,
          endpoint: Object.fromEntries(target.filter(key => node.style[key]).map(key => [key, computed[key]])),
          target: Object.fromEntries(target.filter(key => node.style[key]).map(key => [key, node.style[key]])) };
      });
      const drift = Math.max(0, ...frames.map(frame => frame.maxAnchorDrift));
      const deltas = frames.map(frame => frame.delta).sort((a, b) => a - b);
      return { schema: "brief-motion-browser-trace-v1", recordedAt: new Date().toISOString(),
        userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight },
        reduced, osReduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        backgrounded, inputs, transitions, frames, parts,
        summary: { cycles: inputs.length / 2, activeAnimations, maxAnchorDrift: drift,
          interruptions: transitions.filter(t => t.interrupted).length,
          p95FrameIntervalMs: deltas[Math.floor(deltas.length * .95)] ?? null,
          longestFrameIntervalMs: deltas.at(-1) ?? null,
          // No performance verdict: scheduling depends on host, focus, rendering and capture.
          passed: !backgrounded && inputs.length === 40 && activeAnimations === 0 && drift < .5 && parts.every(part => part.endpointMatches) },
        limits: "rAF/WAAPI endpoint evidence in this browser only; not a frame-rate, GPU, velocity-continuity or full-dashboard certification." };
    },
  };
}
export type MotionTrace = ReturnType<ReturnType<typeof recordMotionTrace>["stop"]>;
