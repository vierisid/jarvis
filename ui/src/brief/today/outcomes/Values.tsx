import React, { useLayoutEffect, useRef } from "react";
import { BRIEF_EASE_OUT, BRIEF_MOTION, useBriefReducedMotion } from "../../motion";
import { formatNumber, progressBand } from "./model";

/** A changed glyph, never the whole figure, fades once. No mount animation or zero count-up. */
function Glyph({ value, reduced }: { value: string; reduced: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  useLayoutEffect(() => {
    const changed = previous.current !== value; previous.current = value;
    if (!changed || reduced) return;
    const animation = ref.current?.animate?.([{ opacity: .45 }, { opacity: 1 }], { duration: BRIEF_MOTION.selection.enter, easing: BRIEF_EASE_OUT });
    return () => animation?.cancel();
  }, [value, reduced]);
  return <span ref={ref} data-value-glyph>{value}</span>;
}
export function OutcomeNumber({ value, reducedMotion = false }: { value: number; reducedMotion?: boolean }) {
  const reduced = useBriefReducedMotion(reducedMotion);
  const text = formatNumber(value);
  return <span className="brief-outcome-number">
    <span className="brief-sr-only">{text}</span>
    <span aria-hidden="true">{[...text].map((char, index) => <Glyph key={text.length - index} value={char} reduced={reduced} />)}</span>
  </span>;
}

/** Shared UI-06 geometry for outcome and goal surfaces; proportions are presentation only. */
export function GoalSegments({ value, target, label, reducedMotion = false }: { value: number; target: number; label: string; reducedMotion?: boolean }) {
  const reduced = useBriefReducedMotion(reducedMotion);
  const ratio = Math.max(0, Math.min(1, value / target));
  return <div className={`brief-progress brief-outcome-progress brief-progress--${progressBand(value, target)}`}
    data-reduced={reduced} role="img" aria-label={label}>
    {Array.from({ length: 10 }, (_, index) => <span key={index} className="brief-outcome-segment">
      <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, ratio * 10 - index))})` }} />
    </span>)}
  </div>;
}
