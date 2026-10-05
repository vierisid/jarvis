import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { BriefButton, BriefIconButton } from "../../components/controls";
import { useBriefMotion } from "../../motion";
import { canAct, decisionStatus, decisionTone, type DecisionAction, type DecisionBinding, type DecisionPaper } from "./model";
import { useDecisionTransition } from "../decision-transition/useDecisionTransition";
import type { DecisionTransition } from "../decision-transition/controller";
import "../decision-transition/decision-transition.css";
import "./hero-paper.css";

export function HeroPaper({ binding, reducedMotion = false }: { binding: DecisionBinding; reducedMotion?: boolean }) {
  const controller = useDecisionTransition(binding, reducedMotion);
  const stack = useRef<HTMLDivElement>(null);
  const focusReturn = useRef<Element | null>(null);
  const { state } = binding;
  const held = controller.transition?.paper;
  const item = held ?? (state.status === "ready" || state.status === "stale" ? state.data : null);
  useLayoutEffect(() => {
    if (controller.transition || !focusReturn.current) return;
    if (document.activeElement === focusReturn.current || document.activeElement === document.body) {
      (stack.current?.querySelector<HTMLButtonElement>(".brief-today-review-trigger") ?? stack.current)?.focus({ preventScroll: true });
    }
    focusReturn.current = null;
  }, [item?.decision.decisionId, item?.decision.revision, controller.transition]);
  if (held || state.status === "ready" || state.status === "stale") {
    // New source identity, not theme/layout, resets transient review intent.
    return <div ref={stack} tabIndex={-1} className="brief-decision-stack"><Decision key={`${item!.decision.decisionId}:${item!.decision.revision}`} item={item!} binding={binding} reducedMotion={controller.reduced}
      transition={controller.transition} arriving={controller.arriving} request={action => {
        const active = document.activeElement;
        if (active && stack.current?.contains(active)) focusReturn.current = active;
        controller.act(item!, action);
      }} /></div>;
  }
  return <div ref={stack} tabIndex={-1} className="brief-decision-stack"><section className="brief-today-decision brief-today-decision--fallback" aria-busy={state.status === "loading" || undefined}>
    {state.status === "loading" ? <><span className="brief-type-utility">Loading your decisions</span><div className="brief-today-skeleton" aria-hidden="true" /><div className="brief-today-skeleton short" aria-hidden="true" /></>
      : <><h2 className="brief-type-hero-heading">{state.status === "empty" ? "No decisions waiting." : "Decisions unavailable."}</h2>
        <p className="brief-type-body">{state.status === "empty" ? "Keep your goals in view and choose the next useful step." : state.reason}</p>
        {state.status !== "empty" && binding.refresh && <BriefButton variant="secondary" onClick={binding.refresh}>Try again</BriefButton>}</>}
  </section></div>;
}

function Decision({ item, binding, reducedMotion, transition, arriving, request }: { item: DecisionPaper; binding: DecisionBinding; reducedMotion: boolean;
  transition: DecisionTransition | null; arriving: boolean; request: (action: DecisionAction) => void }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [review, setReview] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const lastRaised = useRef(false);
  const raised = transition ? lastRaised.current : review || (!suppressed && (hover || focus));
  useLayoutEffect(() => { if (!transition) lastRaised.current = raised; }, [transition, raised]);
  const settling = transition?.phase === "settling" || transition?.phase === "awaiting";
  const locked = !!transition || arriving;
  const region = useRef<HTMLDivElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const reviewContent = useRef<HTMLDivElement>(null);
  const previousReview = useRef(false);
  const reviewScroll = useRef(0);
  const settlingReview = useRef(false);
  settlingReview.current = review && settling;
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pressedPose = useRef<string | null>(null);
  const paper = useBriefMotion<HTMLDivElement>({ transform: settling ? "translate(34px, 30px) rotate(-3.5deg)" : transition && pressedPose.current
    ? pressedPose.current : raised ? "translate(-12px, -6px) rotate(-0.8deg)" : "translate(26px, 12px) rotate(-3.5deg)", opacity: settling ? 0.25 : 1 },
    { kind: settling ? "transfer" : "reveal", active: !settling && raised, reduced: reducedMotion, immediate: !!transition && !settling });
  const actions = useBriefMotion<HTMLDivElement>({ opacity: raised ? 1 : 0 }, { kind: "reveal", active: raised, reduced: reducedMotion });
  const tone = transition?.tone ?? decisionTone(item);
  const operation = binding.operation?.decisionId === item.decision.decisionId && binding.operation.revision === item.decision.revision ? binding.operation : undefined;
  useLayoutEffect(() => {
    const main = region.current?.closest("main");
    return () => { if (main && settlingReview.current) main.scrollTop = reviewScroll.current; };
  }, []);
  useLayoutEffect(() => {
    if (review && !previousReview.current) {
      const content = reviewContent.current;
      content?.focus({ preventScroll: true });
      const main = content?.closest("main");
      if (content && main) {
        reviewScroll.current = main.scrollTop;
        const documentRect = content.getBoundingClientRect(), viewport = main.getBoundingClientRect();
        if (documentRect.top < viewport.top || documentRect.bottom > viewport.bottom) main.scrollTop += documentRect.top - viewport.top - 24;
      }
    }
    if (!review && previousReview.current) {
      const main = reviewButton.current?.closest("main");
      if (main) main.scrollTop = reviewScroll.current;
      reviewButton.current?.focus({ preventScroll: true });
    }
    previousReview.current = review;
  }, [review]);
  const closeReview = (event?: { clientX: number; clientY: number }) => {
    if (event) pointer.current = { x: event.clientX, y: event.clientY };
    setReview(false); setHover(false); setFocus(false); setSuppressed(true);
  };
  const act = (action: DecisionAction) => {
    if (locked) return;
    // A quick press freezes even an unfinished hover lift at the actual painted pose.
    pressedPose.current = paper.current ? getComputedStyle(paper.current).transform : null;
    request(action);
  };
  const unresolved = item.decision.approval && !["pending", "denied", "expired"].includes(item.decision.approval.status)
    && item.decision.approval.executionOutcome !== "committed";
  return <section className="brief-today-decision" data-tone={tone} data-review={review} data-decision-id={item.decision.decisionId}
    data-transition={transition?.phase ?? (arriving ? "arriving" : "idle")} data-reduced={reducedMotion} aria-labelledby={`${id}-summary`}>
    <div className="brief-today-decision-summary">
      <div className="brief-today-decision-meta"><span className={`brief-status brief-status--${tone}`}>{transition ? transition.phase === "pending" ? "Confirming decision" : transition.phase === "blocked" ? "Check the outcome" : transition.action === "approve" ? "Execution confirmed" : transition.action === "keep_draft" ? "Draft kept" : "Rejected" : decisionStatus(item)}</span>
        {item.queueCount !== null && <span className="brief-type-utility brief-secondary">{item.queueCount} {item.queueCount === 1 ? "action" : "actions"}</span>}</div>
      <h2 id={`${id}-summary`} className="brief-type-hero-heading">{item.summary}</h2>
      <p className="brief-type-body brief-secondary">{item.description}</p>
      {binding.state.status === "stale" && <p className="brief-today-decision-notice" role="status">{binding.state.reason}</p>}
      {unresolved && <p className="brief-today-decision-notice">Approval is not confirmation that this action completed. Check the outcome before trying again.</p>}
      <BriefButton ref={reviewButton} className="brief-today-review-trigger" variant="primary" aria-controls={review ? `${id}-review` : undefined} aria-expanded={review}
        onClick={event => { if (review) closeReview(event); else { setReview(true); setSuppressed(false); } }}>{item.reviewLabel}</BriefButton>
      <span className="brief-today-action-feedback brief-type-utility">{!transition && operation && operation.state !== "confirmed" ? operation.message ?? "" : ""}</span>
    </div>
    <div className="brief-today-paper-stage" ref={region} data-raised={raised}
      onPointerEnter={event => { if (event.pointerType !== "touch") setHover(true); }}
      onPointerMove={event => {
        if (event.pointerType === "touch") return;
        const moved = !pointer.current || pointer.current.x !== event.clientX || pointer.current.y !== event.clientY;
        pointer.current = { x: event.clientX, y: event.clientY };
        if (moved) { setSuppressed(false); setHover(true); }
      }}
      onPointerLeave={() => setHover(false)}
      onFocus={event => { if (event.target.matches(":focus-visible")) { setFocus(true); setSuppressed(false); } }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(false); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeReview(); reviewButton.current?.focus(); } }}>
      <div className="brief-today-paper-recess" aria-hidden="true" />
      <div className="brief-today-paper-clip" data-raised={raised}>
        <div className="brief-today-paper-backing-mask" aria-hidden="true"><div className="brief-today-paper-backs">
          {(item.queueCount ?? 1) > 2 && <span className="brief-today-paper-back far" />}
          {(item.queueCount ?? 1) > 1 && <span className="brief-today-paper-back" />}
        </div></div>
        <div className="brief-today-paper-motion" ref={paper}>
          <article className="brief-today-paper-face" aria-label={item.title}>
            <h3 className="brief-type-body-emphasis">{item.title}</h3>
            <div className="brief-today-paper-excerpt"><Document item={item} preview /></div>
            <div className="brief-decision-receipt brief-type-utility" role="status" aria-live="polite" aria-atomic="true">{transition?.message}</div>
            <div ref={actions} className="brief-today-paper-actions" inert={!raised} aria-hidden={!raised}>
              <ActionButtons binding={binding} item={item} act={act} locked={locked} />
            </div>
          </article>
        </div>
      </div>
    </div>
    {(transition?.phase === "blocked" || transition?.phase === "awaiting") && <div className="brief-decision-recovery">
      <p className="brief-type-utility">{transition.phase === "awaiting" ? "Confirmed. Waiting for the refreshed decision stack." : transition.message}</p>
      {binding.refresh && <BriefButton variant="secondary" size="sm" onClick={binding.refresh}>Refresh decisions</BriefButton>}
    </div>}
    {review && <div ref={reviewContent} id={`${id}-review`} className="brief-today-document-review" role="region" aria-label={`Review ${item.title}`} tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeReview(); } }}>
      <div className="brief-today-review-header"><h3 className="brief-type-section-heading">{item.title}</h3><BriefIconButton label="Close review" tooltip={false} icon={<X size={16} />} onClick={event => closeReview(event)} /></div>
      <Document item={item} />
      <div className="brief-today-review-actions"><ActionButtons binding={binding} item={item} act={act} locked={locked} allowReject /></div>
      <div className="brief-decision-review-receipt brief-type-utility">{transition?.message}</div>
    </div>}
  </section>;
}

function Document({ item, preview = false }: { item: DecisionPaper; preview?: boolean }) {
  return <div className="brief-today-document">
    {item.document.recipient && <p className="brief-type-utility brief-secondary">To {item.document.recipient}</p>}
    <h4 className="brief-type-body-emphasis">{item.document.subject}</h4>
    {(!preview || !item.document.attention) && (preview ? item.document.paragraphs.slice(0, 2) : item.document.paragraphs).map((text, index) => <p className="brief-type-body" key={index}>{text}</p>)}
    {item.document.attention && <p className="brief-today-document-attention brief-type-body">{item.document.attention}</p>}
  </div>;
}
function ActionButtons({ binding, item, act, locked, allowReject = false }: { binding: DecisionBinding; item: DecisionPaper; act: (action: DecisionAction) => void; locked: boolean; allowReject?: boolean }) {
  return <>{(["approve", "keep_draft", "reject"] as const).filter(action => (action !== "reject" || allowReject) && item.decision.actions.includes(action) && item.actionLabels[action]).map(action =>
    <BriefButton key={action} size="sm" variant={action === "approve" ? "primary" : "text"} disabled={!locked && !canAct(binding, item, action)} aria-disabled={locked || undefined}
      onClick={() => act(action)}>{item.actionLabels[action]}</BriefButton>)}</>;
}
