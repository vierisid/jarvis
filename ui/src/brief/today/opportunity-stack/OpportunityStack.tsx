import React, { useId, useLayoutEffect, useRef } from "react";
import { ArrowRight, Target } from "lucide-react";
import { BriefButton, BriefIconButton } from "../../components/controls";
import { useBriefMotion } from "../../motion";
import { OPPORTUNITY_APPROVE_LABEL, type OpportunityBinding } from "./model";
import { useOpportunityStack } from "./useOpportunityStack";
import "./opportunity-stack.css";

/** Mount under Today's outside Opportunities heading; never creates a chat prompt. */
export function OpportunityStack({ mode, binding, reducedMotion = false }: { mode: "live" | "preview"; binding?: OpportunityBinding; reducedMotion?: boolean }) {
  const stack = useOpportunityStack(mode, binding, reducedMotion);
  const { card, phase } = stack;
  const id = useId();
  const region = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const emptyTitle = useRef<HTMLHeadingElement>(null);
  const paper = useBriefMotion<HTMLDivElement>({ opacity: phase === "exit" ? 0 : 1, transform: phase === "exit" ? "translateY(8px)" : "translateY(0px)" }, { kind: "settle", active: phase !== "exit", reduced: stack.reduced });
  useLayoutEffect(() => {
    // Only repair a focus target this local update removed. Never steal Pebble focus.
    if (!card && lastFocus.current && !lastFocus.current.isConnected && document.activeElement === document.body) emptyTitle.current?.focus({ preventScroll: true });
  }, [card]);
  const read = stack.binding.state;
  const available = (read.status === "ready" || read.status === "stale" || read.status === "empty") && !stack.duplicate;
  const empty = available && !card;
  const title = stack.duplicate ? "Opportunities need refreshing" : read.status === "loading" ? "Loading opportunities…" : empty ? "Nothing else to review." : "Preparation unavailable";
  const reason = stack.duplicate ? "The proposal list could not be verified." : empty ? "Jarvis will bring the next useful routine here." : "reason" in read ? read.reason : "";
  return <div ref={region} className="brief-opportunity-stack" data-phase={phase} data-reduced={stack.reduced} data-proposal-id={card?.proposal.proposalId}
    onFocusCapture={e => { lastFocus.current = e.target as HTMLElement; }}>
    <div className="brief-opportunity-navigation">
      <span className="brief-type-utility brief-secondary" aria-label="Opportunity position">{available ? stack.count ? `${stack.index + 1} / ${stack.count}` : "0" : "—"}</span>
      <BriefIconButton size="sm" label="Next opportunity" icon={<ArrowRight size={16} />} aria-disabled={!stack.canNext} onClick={() => { if (stack.canNext) stack.next(); }} />
    </div>
    <div className="brief-opportunity-tray" data-layers={Math.min(2, Math.max(0, stack.count - 1))} aria-busy={phase === "pending" || read.status === "loading" || undefined}>
      {available && card && stack.count > 2 && <div aria-hidden="true" className="brief-opportunity-backing brief-opportunity-backing--far" />}
      {available && card && stack.count > 1 && <div aria-hidden="true" className="brief-opportunity-backing brief-opportunity-backing--near" />}
      <div ref={paper} className="brief-opportunity-front">
      {available && card ?
        <article className="brief-opportunity-paper brief-surface" aria-labelledby={`${id}-title`}>
          <h3 id={`${id}-title`} className="brief-type-hero-heading brief-opportunity-title">{card.title}</h3>
          <dl className="brief-opportunity-chain">
            <div className="brief-opportunity-observation"><dt>You did</dt><dd>{card.observation}</dd></div>
            <div className="brief-opportunity-automation"><dt>Workflow does</dt><dd>{card.automation}</dd></div>
            <div className="brief-opportunity-goal"><dt><Target size={16} aria-hidden="true" />{card.goalTitle}</dt><dd>{card.proposal.goal?.rationale}</dd></div>
          </dl>
          <div className="brief-opportunity-actions">
            <BriefButton className="brief-opportunity-approve" size="sm" variant="primary" aria-disabled={!stack.canApprove}
              aria-describedby={stack.message ? `${id}-feedback` : undefined}
              state={phase === "pending" && stack.action === "approve_enable" ? "pending" : stack.confirming && stack.action === "approve_enable" ? "success" : "idle"}
              stateLabels={{ pending: "Enabling…", success: "Workflow enabled" }} onClick={() => stack.act("approve_enable")}>{OPPORTUNITY_APPROVE_LABEL}</BriefButton>
            <BriefButton className="brief-opportunity-dismiss" size="sm" variant="text" aria-disabled={!stack.canDismiss}
              state={phase === "pending" && stack.action === "dismiss" ? "pending" : "idle"}
              onClick={() => stack.act("dismiss")}>{stack.confirming && stack.action === "dismiss" ? "Dismissed" : "Dismiss"}</BriefButton>
          </div>
          <div id={`${id}-feedback`} className={`brief-opportunity-feedback brief-type-utility${!stack.message || stack.confirming || phase === "pending" ? " brief-sr-only" : ""}`} role="status">{stack.message}</div>
          {stack.message && !stack.confirming && phase !== "pending" && stack.binding.refresh && <BriefButton size="sm" variant="text" onClick={stack.binding.refresh}>Refresh proposal</BriefButton>}
        </article>
      : <div className="brief-opportunity-empty brief-surface" data-read-state={stack.duplicate ? "unavailable" : read.status}>
        <h3 ref={emptyTitle} tabIndex={-1} className="brief-type-section-heading">{title}</h3><p className="brief-type-body brief-secondary">{reason}</p>
        {stack.binding.refresh && read.status !== "loading" && <BriefButton size="sm" variant="text" onClick={stack.binding.refresh}>Refresh opportunities</BriefButton>}
      </div>}</div>
    </div>
  </div>;
}
