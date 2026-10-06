import React, { useMemo, useState } from "react";
import { ArrowRight, Target } from "lucide-react";
import { BriefButton } from "../../components/controls";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { useTheme } from "../../../v2/shell/useTheme";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION, type BriefNavigationBinding } from "../../shell/navigation/model";
import { TodayLayout } from "../layout/TodayLayout";
import { useDecisionPreview } from "./useDecisionPreview";
import { Outcomes } from "../outcomes/Outcomes";
import { GoalSegments, OutcomeNumber } from "../outcomes/Values";
import { qualified, qualifiedProgress, type OutcomeSummary } from "../outcomes/model";
import { RecentActivity } from "../activity/RecentActivity";
import { outcomeFixture, activityFixture } from "./outcomeFixtures";
import "./specimen.css";

export function TodaySpecimen() {
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
  const outcomeData = "data" in outcomes.state ? outcomes.state.data : null;
  const shell = useMemo<BriefShellPort>(() => ({ mode: "preview", route, sidebar, setSidebar, chatOpen, setChatOpen, theme, setTheme, navigate: setRoute }), [route, sidebar, chatOpen, theme, setTheme]);
  const binding: BriefNavigationBinding = { capabilities: null, view: { source: "fixture", state: { status: "ready", data: {
    ...UNKNOWN_NAVIGATION, workspaceName: "Vieri’s workspace", connection: "connected", account: { name: "Vieri Balboni", plan: { status: "ready", data: "Pro plan" } }, badges: { workflows: 4, opportunities: 2, "needs-you": 1 },
  } } } };
  return <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
    <div className="brief-today-review-toolbar" aria-label="Isolated review controls">
      <span>D-09 · Isolated Today outcomes</span>
      <label>Decision <select aria-label="Decision scenario" value={scenario} onChange={event => setScenario(event.target.value)}>
        {["ready", "acceptance", "permission", "queued", "invitation", "unknown", "loading", "empty", "stale", "unavailable"].map(s => <option key={s}>{s}</option>)}</select></label>
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Switch to {theme === "light" ? "dark" : "light"}</button>
      <label><input type="checkbox" checked={long} onChange={e => setLong(e.target.checked)} /> Long document</label>
      <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> Reduce motion</label>
      <label>Width <select aria-label="Review width" value={width} onChange={e => { setWidth(e.target.value); if (e.target.value === "390") setSidebar("rail"); }}>
        <option value="1440">1440px</option><option value="1200">1200px</option><option value="390">390px</option><option value="fluid">Fit window</option></select></label>
      <label>Result <select aria-label="Simulated operation result" value={sample.result} onChange={e => sample.setResult(e.target.value)}>
        {["confirmed", "conflict", "failed", "unknown"].map(value => <option key={value}>{value}</option>)}</select></label>
      <button onClick={sample.append}>Append goal step</button><button onClick={sample.reset}>Reset example</button>
      <button onClick={sample.remount}>Reload authoritative view</button>
      <label>Outcomes <select aria-label="Outcome scenario" value={outcomeScenario} onChange={e => setOutcomeScenario(e.target.value)}>
        {["ready", "near-complete", "partial", "unknown-goal", "zero", "loading", "empty", "stale", "unavailable", "unsupported", "long"].map(value => <option key={value}>{value}</option>)}</select></label>
      <button onClick={() => setUpdated(!updated)}>{updated ? "Reset outcome update" : "+1 partner"}</button>
      <button onClick={() => setRefreshCount(count => count + 1)}>Refresh same values</button><span aria-label="Refresh count">{refreshCount}</span>
      <label><input type="checkbox" checked={actionable} onChange={e => setActionable(e.target.checked)} /> Actionable activity example</label>
      <small>Simulated receipts only. No email or workflow executes.</small>
      <small>Illustrative outcome evidence only. Goal actions, opportunities and conversation remain layout fixtures for later tasks.</small>
    </div>
    <div className="brief-today-review-viewport" style={{ width: width === "fluid" ? "100%" : Number(width) }}>
      <NavigationShell shell={shell} rooms={{ today: { id: "today", title: "Today" } }} binding={binding} reducedMotion={reduced}
        conversation={{ source: "fixture", content: <Conversation /> }}>
        {route.room === "today" ? <TodayLayout key={sample.generation} shell={shell} greeting="Good morning, Vieri." dateLabel="Thursday, 17 September" dateTime="2026-09-17" decision={sample.binding} reducedMotion={reduced}
          slots={{ goal: <Goal goal={outcomeData?.goal ?? null} reducedMotion={reduced} />, outcomes: <Outcomes mode={shell.mode} binding={outcomes} reducedMotion={reduced} />, activity: <RecentActivity mode={shell.mode} binding={activityFixture(outcomeScenario, actionable)} onOpen={shell.navigate} />, opportunities: <Opportunity /> }} />
          : <><h1 className="brief-type-room-title">Isolated Today review</h1><BriefButton onClick={() => setRoute({ room: "today", selection: {} })}>Return to Today</BriefButton></>}
      </NavigationShell>
    </div>
  </div>;
}
function Goal({ goal, reducedMotion }: { goal: OutcomeSummary["goal"]; reducedMotion: boolean }) {
  const progress = goal?.progress;
  return <section className="brief-today-sample-goal brief-surface"><h2 className="brief-type-body-emphasis">Win 10 design partners</h2><p className="brief-type-utility brief-secondary sample-goal-drivers">September objective</p>
    {qualifiedProgress(progress) ? <><div className="sample-goal-value"><strong><OutcomeNumber value={progress.value} reducedMotion={reducedMotion} /></strong><span>/ {progress.target}</span><small>signed</small>{qualified(goal?.change) && <small className="brief-positive">+{goal!.change!.value} this week</small>}</div><GoalSegments value={progress.value} target={progress.target} label={`${progress.value} of ${progress.target} signed`} reducedMotion={reducedMotion} /></> : <p className="brief-type-body brief-secondary">Progress not measured yet</p>}
    <div className="sample-goal-drivers">{[["Qualified leads", "24 / 30", "80%"], ["Pilot calls", "12 / 20", "60%"], ["Pilots started", "8 / 10", "80%"]].map(([title, count, percent]) => <div className="sample-driver" key={title}><span>{title}</span><i><b style={{ width: percent }} /></i><span>{count}</span></div>)}</div>
    <div className="sample-goal-next"><span>What’s next?</span><ArrowRight size={16} /></div>
  </section>;
}
function Opportunity() { return <article className="brief-today-sample-opportunity brief-surface"><h3 className="brief-type-hero-heading">Call prep,<br />ready to run.</h3><small>You did</small><p>Emails and notes searched before 4 sales calls.</p><small>Workflow does</small><p>Context and questions, ready before every call.</p><strong className="brief-positive"><Target size={16} />Win 10 design partners</strong><p>Know what each prospect needs to say yes.</p></article>; }
function Conversation() {
  const [draft, setDraft] = useState("");
  return <><div className="sample-conversation-tabs">General</div><div className="sample-conversation-thread"><h2 className="brief-type-section-heading">What are we moving forward?</h2></div>
    <div className="sample-conversation-suggestions"><BriefButton size="sm" variant="secondary" onClick={() => setDraft("Prepare my next call with Alex.")}>Prepare a call</BriefButton><BriefButton size="sm" variant="secondary" onClick={() => setDraft("Review the follow-up workflow.")}>Review a workflow</BriefButton></div>
    <textarea className="sample-conversation-input" aria-label="Conversation draft" data-pebble-focus rows={2} value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask Jarvis…" /></>;
}
