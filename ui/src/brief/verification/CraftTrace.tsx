import React, { useEffect, useRef, useState } from "react";

/** Opt-in fixture instrumentation only. No observers or trace data in live rooms.
 * Frame intervals are scheduling observations, not a CPU/GPU or FPS certificate. */
export function CraftTrace({ children }: { children: React.ReactNode }) {
  const capture = useRef<() => unknown>(() => null);
  const tools = useRef<HTMLElement>(null);
  const [trace, setTrace] = useState<unknown>(null);
  useEffect(() => {
    const frames: number[] = [], inputs: { type: string; at: number }[] = [];
    const longTasks: { start: number; duration: number }[] = [];
    const started = performance.now();
    let last = started, frame = 0, backgrounded = document.hidden, truncated = false;
    const tick = (now: number) => {
      const running = String(document.getAnimations().filter(a => a.playState === "running").length);
      if (tools.current && tools.current.dataset.activeAnimations !== running) tools.current.dataset.activeAnimations = running;
      if (frames.length < 12000) frames.push(now - last);
      else truncated = true;
      last = now;
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => { backgrounded ||= document.hidden; };
    const input = (event: Event) => {
      if (inputs.length < 2000) inputs.push({ type: event.type, at: performance.now() - started });
      else truncated = true;
    };
    const supportsLongTasks = typeof PerformanceObserver !== "undefined" && !!PerformanceObserver.supportedEntryTypes?.includes("longtask");
    const observer = supportsLongTasks ? new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (longTasks.length < 2000) longTasks.push({ start: entry.startTime - started, duration: entry.duration });
        else truncated = true;
      }
    }) : null;
    observer?.observe({ type: "longtask" });
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("click", input, true);
    document.addEventListener("keydown", input, true);
    frame = requestAnimationFrame(tick);
    capture.current = () => ({
      schema: "brief-craft-browser-trace-v1", source: "fixture",
      capturedAt: new Date().toISOString(), userAgent: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      duration: performance.now() - started, backgrounded, truncated,
      longTaskSupport: supportsLongTasks, frames: [...frames], inputs: [...inputs], longTasks: [...longTasks],
      activeAnimations: document.getAnimations().filter(a => a.playState === "running").length,
    });
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("click", input, true);
      document.removeEventListener("keydown", input, true);
    };
  }, []);
  return <>{children}<aside ref={tools} data-brief-craft aria-label="Craft verification tools" style={{ padding: 8 }}>
    <button type="button" onClick={() => setTrace(capture.current())}>Capture craft trace</button>
    <output hidden data-brief-craft-trace>{trace ? JSON.stringify(trace) : ""}</output>
  </aside></>;
}
