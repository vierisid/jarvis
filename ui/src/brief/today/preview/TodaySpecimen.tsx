import React, { useMemo, useRef, useState } from "react";
import { BriefButton } from "../../components/controls";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { useTheme } from "../../../v2/shell/useTheme";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION, type BriefNavigationBinding } from "../../shell/navigation/model";
import { TodayLayout } from "../layout/TodayLayout";
import { useDecisionPreview } from "./useDecisionPreview";
import { Outcomes } from "../outcomes/Outcomes";
import { GoalCard, GoalQueueCue } from "../goal-card/GoalCard";
import { useGoalHandoff } from "../goal-card/useGoalHandoff";
import { goalFixture, goalPaper } from "./goalFixtures";
import type { GoalAcceptResult } from "../goal-card/model";
import { OpportunityStack } from "../opportunity-stack/OpportunityStack";
import { opportunityFixture, opportunityReceipt } from "./opportunityFixtures";

import { RecentActivity } from "../activity/RecentActivity";
import { outcomeFixture, activityFixture } from "./outcomeFixtures";
import "./specimen.css";

export function TodaySpecimen({ conversation, reviewTools }: { conversation?: React.ReactNode | ((reduced: boolean) => React.ReactNode); reviewTools?: React.ReactNode } = {}) {
  const [route, setRoute] = useState<BriefRoute>({ room: "today", selection: {} });
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [chatOpen, setChatOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [scenario, setScenario] = useState("ready");
  const [long, setLong] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [width, setWidth] = useState("fluid");
  const sample = useDecisionPreview(scenario, long);
  const [outcomeScenario, setOutcomeScenario] = useState("ready");
  const [updated, setUpdated] = useState(false);
  const [actionable, setActionable] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const outcomes = outcomeFixture(outcomeScenario, updated);
  const [recommendationScenario, setRecommendationScenario] = useState("ready");
  const [acceptResult, setAcceptResult] = useState("confirmed");
  const [acceptCalls, setAcceptCalls] = useState(0);
  const [opportunityScenario, setOpportunityScenario] = useState("ready");
  const [opportunityResult, setOpportunityResult] = useState("confirmed");
  const [opportunityCalls, setOpportunityCalls] = useState(0);
  const [opportunityReset, setOpportunityReset] = useState(0);
  const [opportunityReversed, setOpportunityReversed] = useState(false);
  const opportunities = opportunityFixture(opportunityScenario);
  if (opportunityReversed && "data" in opportunities.state) opportunities.state = { ...opportunities.state, data: [...opportunities.state.data].reverse() };
  opportunities.refresh = () => setRefreshCount(n => n + 1);
  if (opportunityScenario !== "no-owner") opportunities.onAction = async request => {
    setOpportunityCalls(n => n + 1);
    await new Promise(resolve => setTimeout(resolve, 450));
    if (opportunityResult === "lost-response") throw new Error("Illustrative lost response");
    if (opportunityResult !== "confirmed") return { ...request, state: opportunityResult as "conflict" | "failed" | "unknown" };
    return opportunityReceipt(request);
  };
  const receipts = useRef(new Map<string, GoalAcceptResult>());
  const previewGeneration = useRef(sample.generation);
  previewGeneration.current = sample.generation;
  const goalBinding = goalFixture(outcomes, recommendationScenario, sample.queue.map(paper => ({ decisionId:paper.decision.decisionId, workItemId:paper.decision.workItemId!, title:paper.title })));
  if ("data" in goalBinding.recommendation) goalBinding.recommendation.data.revision = `rec-${sample.generation}-${recommendationScenario}`;
  const handoff = useGoalHandoff("preview", { ...goalBinding, onAccept: async request => {
    setAcceptCalls(n => n + 1);
    await new Promise(resolve => setTimeout(resolve, 450));
    if (previewGeneration.current !== sample.generation) return {...request,state:"conflict"};
    if (acceptResult === "lost-response") throw new Error("Illustrative lost response");
    if (acceptResult !== "confirmed") return {...request,state:acceptResult as "conflict"|"failed"|"unknown"};
    const receiptKey = `${sample.generation}:${request.recommendationId}`;
    const existing = receipts.current.get(receiptKey);
    if (existing) return {...existing,requestId:request.requestId};
    const paper = goalPaper();
    if ("data" in goalBinding.recommendation) paper.title = goalBinding.recommendation.data.title;
    sample.enqueue(paper);
    const result: GoalAcceptResult = {...request,state:"confirmed",receiptId:`fixture-receipt-maya-${sample.generation}`,destination:{decisionId:paper.decision.decisionId,workItemId:paper.decision.workItemId!,title:paper.title}};
    receipts.current.set(receiptKey,result); return result;
  } }, reduced);
  const shell = useMemo<BriefShellPort>(() => ({ mode: "preview", route, sidebar, setSidebar, chatOpen, setChatOpen, theme, setTheme, navigate: setRoute }), [route, sidebar, chatOpen, theme, setTheme]);
  const binding: BriefNavigationBinding = { capabilities: null, view: { source: "fixture", state: { status: "ready", data: {
    ...UNKNOWN_NAVIGATION, workspaceName: "Vieri’s workspace", connection: "connected", account: { name: "Vieri Balboni", plan: { status: "ready", data: "Pro plan" } }, badges: { workflows: 4, opportunities: 2, "needs-you": 1 },
  } } } };
  return <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
    <div className="brief-today-review-toolbar" aria-label="Isolated review controls">
      <span>{reviewTools ? "D-12 · Isolated conversation tabs" : "D-11 · Isolated Today opportunities"}</span>
      {reviewTools}
      {!reviewTools && <label>Decision <select aria-label="Decision scenario" value={scenario} onChange={event => setScenario(event.target.value)}>
        {["ready", "acceptance", "permission", "queued", "invitation", "unknown", "loading", "empty", "stale", "unavailable"].map(s => <option key={s}>{s}</option>)}</select></label>}
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Switch to {theme === "light" ? "dark" : "light"}</button>
      {!reviewTools && <label><input type="checkbox" checked={long} onChange={e => setLong(e.target.checked)} /> Long document</label>}
      <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> Reduce motion</label>
      <label>Width <select aria-label="Review width" value={width} onChange={e => { setWidth(e.target.value); if (e.target.value === "390") setSidebar("rail"); }}>
        <option value="1440">1440px</option><option value="1200">1200px</option><option value="390">390px</option><option value="fluid">Fit window</option></select></label>
      {!reviewTools && <><label>Result <select aria-label="Simulated operation result" value={sample.result} onChange={e => sample.setResult(e.target.value)}>
        {["confirmed", "conflict", "failed", "unknown"].map(value => <option key={value}>{value}</option>)}</select></label>
      <button onClick={sample.append}>Append goal step</button><button onClick={sample.reset}>Reset example</button>
      <button onClick={sample.remount}>Reload authoritative view</button>
      <label>Outcomes <select aria-label="Outcome scenario" value={outcomeScenario} onChange={e => setOutcomeScenario(e.target.value)}>
        {["ready", "near-complete", "partial", "unknown-goal", "zero", "loading", "empty", "stale", "unavailable", "unsupported", "long"].map(value => <option key={value}>{value}</option>)}</select></label>
      <button onClick={() => setUpdated(!updated)}>{updated ? "Reset outcome update" : "+1 partner"}</button>
      <button onClick={() => setRefreshCount(count => count + 1)}>Refresh same values</button><span aria-label="Refresh count">{refreshCount}</span>
      <label><input type="checkbox" checked={actionable} onChange={e => setActionable(e.target.checked)} /> Actionable activity example</label>
      <label>Recommendation <select aria-label="Recommendation scenario" value={recommendationScenario} onChange={e => setRecommendationScenario(e.target.value)}>{["ready","loading","empty","blocked","expired","changed-goal","accepted","stale","unavailable","unsupported","long"].map(v=><option key={v}>{v}</option>)}</select></label>
      <label>Add result <select aria-label="Recommendation result" value={acceptResult} onChange={e => setAcceptResult(e.target.value)}>{["confirmed","conflict","failed","unknown","lost-response"].map(v=><option key={v}>{v}</option>)}</select></label>
      <span aria-label="Acceptance calls">{acceptCalls}</span>
      <label>Opportunities <select aria-label="Opportunity scenario" value={opportunityScenario} onChange={e => setOpportunityScenario(e.target.value)}>{["ready","preparing","blocked","missing-connection","no-owner","loading","empty","stale","unavailable","unsupported","long"].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Opportunity result <select aria-label="Opportunity result" value={opportunityResult} onChange={e => setOpportunityResult(e.target.value)}>{["confirmed","conflict","failed","unknown","lost-response"].map(v => <option key={v}>{v}</option>)}</select></label>
      <button onClick={() => setOpportunityReversed(value => !value)}>Reverse opportunity list</button>
      <button onClick={() => { setOpportunityReset(n => n + 1); setOpportunityCalls(0); setOpportunityReversed(false); }}>Reset opportunities</button><span aria-label="Opportunity action calls">{opportunityCalls}</span>
      <small>Simulated receipts only. No email or workflow executes.</small>
      <small>Illustrative outcome evidence only. Recommendations and opportunities use simulated owners. Conversation remains a layout fixture.</small></>}
      {reviewTools && <small>Illustrative conversations only. No live account, message, model or workflow is connected.</small>}
    </div>
    <div className="brief-today-review-viewport" style={{ width: width === "fluid" ? "100%" : Number(width) }}>
      <NavigationShell shell={shell} rooms={{ today: { id: "today", title: "Today" } }} binding={binding} reducedMotion={reduced}
        conversation={{ source: "fixture", content: typeof conversation === "function" ? conversation(reduced) : conversation ?? <Conversation /> }}>
        {route.room === "today" ? <TodayLayout key={sample.generation} shell={shell} greeting="Good morning, Vieri." dateLabel="Thursday, 17 September" dateTime="2026-09-17" decision={sample.binding} reducedMotion={reduced}
          slots={{ queueNotice: <GoalQueueCue handoff={handoff} />, goal: <GoalCard handoff={handoff} />, outcomes: <Outcomes mode={shell.mode} binding={outcomes} reducedMotion={reduced} />, activity: <RecentActivity mode={shell.mode} binding={activityFixture(outcomeScenario, actionable)} onOpen={shell.navigate} />, opportunities: <OpportunityStack key={opportunityReset} mode={shell.mode} binding={opportunities} reducedMotion={reduced} /> }} />
          : <><h1 className="brief-type-room-title">Isolated Today review</h1><BriefButton onClick={() => setRoute({ room: "today", selection: {} })}>Return to Today</BriefButton></>}
      </NavigationShell>
    </div>
  </div>;
}
function Conversation() {
  const [draft, setDraft] = useState("");
  return <><div className="sample-conversation-tabs">General</div><div className="sample-conversation-thread"><h2 className="brief-type-section-heading">What are we moving forward?</h2></div>
    <div className="sample-conversation-suggestions"><BriefButton size="sm" variant="secondary" onClick={() => setDraft("Prepare my next call with Alex.")}>Prepare a call</BriefButton><BriefButton size="sm" variant="secondary" onClick={() => setDraft("Review the follow-up workflow.")}>Review a workflow</BriefButton></div>
    <textarea className="sample-conversation-input" aria-label="Conversation draft" data-pebble-focus rows={2} value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask Jarvis…" /></>;
}
