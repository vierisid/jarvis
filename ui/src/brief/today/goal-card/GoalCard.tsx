import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { BriefButton } from "../../components/controls";
import { BRIEF_EASE_OUT, useBriefMotion } from "../../motion";
import { GoalSegments, OutcomeNumber } from "../outcomes/Values";
import { formatNumber, qualified } from "../outcomes/model";
import { cardProgress } from "./model";
import type { GoalHandoff } from "./useGoalHandoff";
import "../outcomes/outcomes.css";
import "./goal-card.css";

export function GoalCard({ handoff, onReviewDraft }: { handoff: GoalHandoff; onReviewDraft?: () => void }) {
  const { binding, goal, rec, reduced } = handoff;
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const open = openedKey === handoff.key;
  const next = useRef<HTMLButtonElement>(null), back = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(false);
  const lastBodyFocus = useRef<HTMLElement | null>(null);
  const changeView = (key: string | null) => { focusRequested.current = true; setOpenedKey(key); };
  const previous = useRef(open);
  const id = useId();
  useLayoutEffect(() => {
    if (previous.current === open) return;
    previous.current = open;
    // Background revisions can close/reopen this body while the user is typing in
    // Pebble. Restore focus only for local intent or a focused control we removed.
    const removedFocus = lastBodyFocus.current && !lastBodyFocus.current.isConnected && document.activeElement === document.body;
    if (focusRequested.current || removedFocus) (open ? back : next).current?.focus({ preventScroll: true });
    focusRequested.current = false;
    if (reduced) return;
    const animation = body.current?.animate?.([{ opacity: .55 }, { opacity: 1 }], { duration: 180, easing: BRIEF_EASE_OUT });
    void animation?.finished?.catch(() => {});
    return () => animation?.cancel();
  }, [open, reduced]);
  if (!goal) return <section className="brief-goal-card brief-surface" aria-label="Main goal" data-state={binding.state.status} aria-busy={binding.state.status === "loading" || undefined}>
    <h2 className="brief-type-body-emphasis">{binding.state.status === "loading" ? "Loading your goal" : binding.state.status === "empty" ? "No active goal" : "Goal unavailable"}</h2>
    <p className="brief-type-body brief-secondary">{binding.state.status === "empty" ? "Choose a goal to give the next step direction." : "reason" in binding.state ? binding.state.reason : ""}</p>
  </section>;
  const progress = cardProgress(goal.progress, goal.fraction);
  return <section className="brief-goal-card brief-surface" aria-labelledby={`${id}-title`} data-goal-id={goal.goalId} data-view={open ? "recommendation" : "overview"} data-reduced={reduced}>
    <h2 id={`${id}-title`} className="brief-type-body-emphasis">{goal.title}</h2>
    {goal.periodLabel && <p className="brief-goal-period brief-type-utility brief-secondary">{goal.periodLabel}</p>}
    <div className="brief-goal-value"><strong><OutcomeNumber value={progress.value} reducedMotion={reduced} /></strong><span>{progress.percent ? "%" : `/ ${formatNumber(progress.target)}`}</span><small>{progress.percent ? "progress" : goal.progressLabel}</small>
      {!progress.percent && qualified(goal.change) && <small className={`brief-goal-change ${goal.change.value > 0 ? "brief-positive" : "brief-secondary"}`}>{goal.change.value > 0 ? "+" : ""}{formatNumber(goal.change.value)} this week</small>}</div>
    <GoalSegments value={progress.value} target={progress.target} label={progress.percent ? `${formatNumber(progress.value)}% progress` : `${formatNumber(progress.value)} of ${formatNumber(progress.target)} ${goal.progressLabel}`} reducedMotion={reduced} />
    {binding.state.status === "stale" && <p className="brief-type-utility brief-secondary">{binding.state.reason}</p>}
    <div ref={body} className="brief-goal-body" onFocusCapture={e => { lastBodyFocus.current = e.target as HTMLElement; }} onKeyDown={e => { if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); changeView(null); } }}>
      {open ? <>
        {rec ? <><h3 className="brief-type-body-emphasis">{rec.title}</h3><p className="brief-type-body brief-secondary">{rec.rationale}</p></> : <p className="brief-type-body brief-secondary">{binding.recommendation.status === "loading" ? "Finding the next useful step…" : binding.recommendation.status === "empty" ? "No new step to add right now." : "reason" in binding.recommendation ? binding.recommendation.reason : "Recommendation unavailable."}</p>}
        <div className="brief-goal-actions">
          {rec && <BriefButton size="sm" variant="primary" className="brief-goal-accept" state={handoff.pending ? "pending" : handoff.accepted ? "success" : "idle"} stateLabels={{ pending: "Adding…", success: "Added to Today" }} aria-disabled={handoff.locked || undefined} onClick={handoff.accept}>Add to Today</BriefButton>}
          <BriefButton ref={back} size="sm" variant="text" onClick={() => changeView(null)}>Back to goal</BriefButton>
        </div>
        <div className={`brief-goal-feedback brief-type-utility${handoff.accepted || handoff.pending ? " brief-sr-only" : ""}`} role="status" aria-live="polite">{handoff.message}</div>
        {handoff.locked && !handoff.accepted && !handoff.pending && binding.refresh && <BriefButton size="sm" variant="text" onClick={binding.refresh}>Refresh recommendation</BriefButton>}
      </> : <>
        <div className="brief-goal-drivers">{goal.drivers.map(driver => {
          const value = cardProgress(driver.progress, driver.fraction);
          const label = value.percent ? `${formatNumber(value.value)}%` : `${formatNumber(value.value)} / ${formatNumber(value.target)}`;
          return <div className="brief-goal-driver" key={driver.goalId}>
            <span className="brief-goal-driver-title" title={driver.title}>{driver.title}</span>
            <div className="brief-goal-driver-track" role="img" aria-label={`${driver.title}: ${label}`}><i style={{ transform: `scaleX(${Math.max(0, Math.min(1, value.value / value.target))})` }} /></div>
            <span className="brief-secondary">{label}</span>
          </div>;
        })}</div>
        <BriefButton ref={next} variant="text" className="brief-goal-next" onClick={onReviewDraft ?? (() => changeView(handoff.key))} aria-expanded={onReviewDraft ? undefined : false}>{onReviewDraft ? "Review goal" : "What’s next?"}<ArrowRight size={16} /></BriefButton>
      </>}
    </div>
  </section>;
}

/** Stable destination slot. A blue cue names the accepted work without a flying duplicate. */
export function GoalQueueCue({ handoff }: { handoff: GoalHandoff }) {
  const [title, setTitle] = useState("");
  useLayoutEffect(() => { if (handoff.cue) setTitle(handoff.cue.title); }, [handoff.cue]);
  const ref = useBriefMotion<HTMLSpanElement>({ opacity: handoff.cue ? 1 : 0, transform: handoff.cue ? "translateY(0px)" : "translateY(3px)" }, { kind: "transfer", active: !!handoff.cue, reduced: handoff.reduced });
  return <span ref={ref} className="brief-goal-queue-cue" data-work-item-id={handoff.cue?.workItemId} aria-hidden={!handoff.cue} title={title}><span aria-hidden="true">↳ </span>Added: {title}</span>;
}
