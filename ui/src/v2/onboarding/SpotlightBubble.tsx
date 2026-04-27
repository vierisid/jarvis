import React, { useMemo } from "react";
import { ArrowRight, RotateCcw, SkipForward, Volume2 } from "lucide-react";
import { Icon } from "../ui";
import type { SpotlightAnchor } from "./TutorialSteps";

/**
 * Phase C — anchored chat-bubble card that points at the spotlight
 * cut-out. Reads as one of Jarvis's thread bubbles visually
 * (paper-2 background, soft ring) so it feels like he's talking to
 * you, not at you.
 *
 * Auto-anchors to the side of the cut-out with the most space when
 * `prefer` isn't set. For viewport-mode steps (no cut-out), centers
 * in the viewport.
 */

export interface SpotlightBubbleProps {
  rect: DOMRect | null;
  narration: string;
  tryHint?: string;
  /** Bubble anchor preference; auto if omitted. */
  prefer?: SpotlightAnchor;
  /** Step counter for the progress label, "3 of 12". */
  stepIndex: number;
  totalSteps: number;
  /** True while TTS is speaking — shows the speaking dot. */
  speaking: boolean;
  onNext: () => void;
  onSkip: () => void;
  onReplayNarration: () => void;
  /** True when this is the final step — Next becomes "Finish". */
  isLast: boolean;
}

const BUBBLE_W = 360;
const BUBBLE_GAP = 16;

export function SpotlightBubble({
  rect,
  narration,
  tryHint,
  prefer,
  stepIndex,
  totalSteps,
  speaking,
  onNext,
  onSkip,
  onReplayNarration,
  isLast,
}: SpotlightBubbleProps) {
  const style = useMemo<React.CSSProperties>(() => {
    if (!rect) {
      // Centered card for viewport-mode steps.
      return {
        position: "fixed",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: Math.min(BUBBLE_W + 80, window.innerWidth - 32),
      };
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const anchor: SpotlightAnchor =
      prefer ?? autoPickAnchor(rect, W, H);
    return positionForAnchor(rect, anchor, W, H);
  }, [rect, prefer]);

  return (
    <div
      className="v2-spotlight-bubble"
      role="dialog"
      aria-modal="false"
      aria-live="polite"
      style={style}
    >
      <div className="v2-spotlight-bubble__head">
        <span
          className={
            "v2-spotlight-bubble__avatar " +
            (speaking ? "v2-spotlight-bubble__avatar--speaking" : "")
          }
          aria-hidden="true"
        />
        <span className="v2-spotlight-bubble__brand">JARVIS · onboarding</span>
        <span className="v2-spotlight-bubble__progress">
          {stepIndex + 1} of {totalSteps}
        </span>
      </div>
      <p className="v2-spotlight-bubble__narration">{narration}</p>
      {tryHint && (
        <p className="v2-spotlight-bubble__hint">→ {tryHint}</p>
      )}
      <div className="v2-spotlight-bubble__actions">
        <button
          type="button"
          className="v2-spotlight-bubble__btn v2-spotlight-bubble__btn--ghost"
          onClick={onSkip}
        >
          <Icon icon={SkipForward} size="sm" />
          Skip tour
        </button>
        <button
          type="button"
          className="v2-spotlight-bubble__btn v2-spotlight-bubble__btn--ghost"
          onClick={onReplayNarration}
          aria-label="Replay narration"
          title="Replay narration"
        >
          <Icon icon={RotateCcw} size="sm" />
        </button>
        <span className="v2-spotlight-bubble__actions-spacer" />
        <button
          type="button"
          className="v2-spotlight-bubble__btn v2-spotlight-bubble__btn--primary"
          onClick={onNext}
          autoFocus
        >
          {isLast ? "Finish" : "Next"}
          {!isLast && <Icon icon={ArrowRight} size="sm" />}
        </button>
      </div>
      {/* sr-only echo for screen readers when TTS is off — the bubble
          text above is already in the DOM, but `aria-live="polite"` on
          the wrapper announces it on each change. */}
      {speaking && (
        <span className="v2-sr-only">
          <Icon icon={Volume2} size="sm" /> Speaking
        </span>
      )}
    </div>
  );
}

/**
 * Pick the bubble side with the most viewport space relative to the
 * cut-out rect. Bubbles fit best on top/bottom for landscape rects,
 * left/right for tall rects.
 */
function autoPickAnchor(rect: DOMRect, W: number, H: number): SpotlightAnchor {
  const spaceTop = rect.top;
  const spaceBottom = H - rect.bottom;
  const spaceLeft = rect.left;
  const spaceRight = W - rect.right;
  const maxV = Math.max(spaceTop, spaceBottom);
  const maxH = Math.max(spaceLeft, spaceRight);
  if (maxV >= maxH) {
    return spaceBottom >= spaceTop ? "bottom" : "top";
  } else {
    return spaceRight >= spaceLeft ? "right" : "left";
  }
}

function positionForAnchor(
  rect: DOMRect,
  anchor: SpotlightAnchor,
  W: number,
  H: number,
): React.CSSProperties {
  const w = Math.min(BUBBLE_W, W - 32);
  switch (anchor) {
    case "top":
      return {
        position: "fixed",
        left: clamp(rect.left + rect.width / 2 - w / 2, 16, W - w - 16),
        bottom: clamp(H - rect.top + BUBBLE_GAP, 16, H - 80),
        width: w,
      };
    case "bottom":
      return {
        position: "fixed",
        left: clamp(rect.left + rect.width / 2 - w / 2, 16, W - w - 16),
        top: clamp(rect.bottom + BUBBLE_GAP, 16, H - 80),
        width: w,
      };
    case "left":
      return {
        position: "fixed",
        right: clamp(W - rect.left + BUBBLE_GAP, 16, W - w - 16),
        top: clamp(rect.top + rect.height / 2 - 80, 16, H - 220),
        width: w,
      };
    case "right":
      return {
        position: "fixed",
        left: clamp(rect.right + BUBBLE_GAP, 16, W - w - 16),
        top: clamp(rect.top + rect.height / 2 - 80, 16, H - 220),
        width: w,
      };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
