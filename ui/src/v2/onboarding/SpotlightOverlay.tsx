import React, { useEffect, useRef, useState } from "react";

/**
 * Phase C — fullscreen dim with a single rounded rectangular cut-out
 * around `targetSelector`. Implemented via SVG mask: we overlay a
 * solid black rect with `mask` set to a white rect minus a smaller
 * rounded rect at the target's bounds. Anything inside the cut-out
 * is fully visible AND clickable (the SVG sits below pointer events
 * via a CSS class).
 *
 * Recomputes the cut-out rect on:
 *   - target prop change (step advance)
 *   - viewport resize (window 'resize')
 *   - scroll inside any element (window 'scroll', capture phase so
 *     scroll events on inner containers are caught too)
 *   - target element resize (ResizeObserver)
 *
 * `targetSelector === "viewport"` produces a full dim with no cut-out
 * — used for the welcome and outro steps.
 */

export interface SpotlightOverlayProps {
  /** CSS selector for the element to spotlight, or "viewport" for full dim. */
  targetSelector: string;
  /** Padding around the cut-out rect, in CSS pixels. Default 8. */
  padding?: number;
  /** Border-radius for the cut-out, in CSS pixels. Default 12. */
  borderRadius?: number;
  /** Called whenever the target's rect changes — used by the bubble
   *  positioning code to anchor to the cut-out. */
  onRectChange?: (rect: DOMRect | null) => void;
}

export function SpotlightOverlay({
  targetSelector,
  padding = 8,
  borderRadius = 12,
  onRectChange,
}: SpotlightOverlayProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    if (targetSelector === "viewport") {
      setRect(null);
      onRectChange?.(null);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector(targetSelector) as HTMLElement | null;
      if (!el) {
        // Element not yet in the DOM (e.g. inline window just injected
        // and React hasn't flushed). Poll briefly.
        pollTimer = setTimeout(measure, 100);
        return;
      }
      const r = el.getBoundingClientRect();
      // Pad the rect.
      const padded = new DOMRect(
        r.left - padding,
        r.top - padding,
        r.width + padding * 2,
        r.height + padding * 2,
      );
      setRect(padded);
      onRectChange?.(padded);

      // Wire up ResizeObserver on the actual target so layout shifts
      // (image loads, font swaps, content updates) reflow the cut-out.
      if (observerRef.current) observerRef.current.disconnect();
      const ro = new ResizeObserver(() => measure());
      ro.observe(el);
      observerRef.current = ro;
    };

    measure();

    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    // Capture so we catch scroll on inner containers (Thread, etc.),
    // not just the window.
    window.addEventListener("scroll", onResize, true);

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [targetSelector, padding, onRectChange]);

  // Viewport mode: solid dim, no cut-out.
  if (targetSelector === "viewport") {
    return <div className="v2-spotlight v2-spotlight--full" aria-hidden="true" />;
  }

  if (!rect) {
    // Target not yet measured — render a transparent layer so we don't
    // flash a full-dim before the cut-out lands.
    return null;
  }

  // Full viewport SVG mask. The white rect = visible dim; the
  // rounded rect inside it (drawn black) is the cut-out hole.
  const W = window.innerWidth;
  const H = window.innerHeight;

  return (
    <svg
      className="v2-spotlight"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
    >
      <defs>
        <mask id="v2-spotlight-mask">
          {/* White = visible dim */}
          <rect x={0} y={0} width={W} height={H} fill="white" />
          {/* Black = transparent hole around the target */}
          <rect
            x={rect.left}
            y={rect.top}
            width={rect.width}
            height={rect.height}
            rx={borderRadius}
            ry={borderRadius}
            fill="black"
          />
        </mask>
      </defs>
      <rect
        x={0}
        y={0}
        width={W}
        height={H}
        fill="rgba(26,26,26,0.55)"
        mask="url(#v2-spotlight-mask)"
      />
      {/* Soft accent ring around the cut-out for visual emphasis. */}
      <rect
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        rx={borderRadius}
        ry={borderRadius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        pointerEvents="none"
      />
    </svg>
  );
}
