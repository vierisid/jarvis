import React, { useMemo, useState } from "react";
import { Check, FileText, Mail } from "lucide-react";
import { BriefButton, BriefInput } from "../../components/controls";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { BRIEF_ROOMS } from "../../rooms/registry";
import { useTheme } from "../../../v2/shell/useTheme";
import { NavigationShell } from "../navigation/NavigationShell";
import { UNKNOWN_NAVIGATION, type BriefNavigationBinding } from "../navigation/model";
import { usePebbleWorkspace } from "./PebbleLayout";
import "./specimen.css";

const SCENARIOS = [
  ["today", "Today"], ["workflow", "Canvas"], ["all-workflows", "List"], ["memory-detail", "Detail"], ["profile", "Form"],
] as const;
/** Explicit, illustrative review harness. No backend, conversation API or writer. */
export function PebbleSpecimen() {
  const [route, setRoute] = useState<BriefRoute>({ room: "today", selection: { goalId: "fixture-goal" } });
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [chatOpen, setChatOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [reduced, setReduced] = useState(false);
  const [viewport, setViewport] = useState("fluid");
  const shell = useMemo<BriefShellPort>(() => ({ mode: "preview", route, sidebar, setSidebar, chatOpen, setChatOpen,
    theme, setTheme, navigate: setRoute }), [route, sidebar, chatOpen, theme, setTheme]);
  const binding: BriefNavigationBinding = { capabilities: null, view: { source: "fixture", state: { status: "ready", data: {
    ...UNKNOWN_NAVIGATION, workspaceName: "Vieri’s workspace", connection: "connected",
    account: { name: "Vieri Balboni", plan: { status: "ready", data: "Pro plan" } },
    badges: { workflows: 4, opportunities: 2, "needs-you": 1 },
    objectTitle: route.room === "workflow" ? "Meeting follow-ups" : undefined,
  } } } };
  return <div className="brief-root brief-pebble-specimen" data-brief-theme={theme}>
    <div className="brief-pebble-review" aria-label="Isolated review controls">
      <span>D-06 · Illustrative layout review</span>
      <label>Room <select aria-label="Room scenario" value={route.room} onChange={event => setRoute({ room: event.target.value as BriefRoute["room"], selection: { goalId: "fixture-goal" } })}>
        {SCENARIOS.map(([room, label]) => <option key={room} value={room}>{label}</option>)}
        {!SCENARIOS.some(([room]) => room === route.room) && <option value={route.room}>{BRIEF_ROOMS[route.room]?.title}</option>}
      </select></label>
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Switch to {theme === "light" ? "dark" : "light"}</button>
      <label><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} /> Reduce motion</label>
      <label>Layout width <select aria-label="Review viewport" value={viewport} onChange={event => {
        setViewport(event.target.value); if (event.target.value === "390") setSidebar("rail");
      }}>
        <option value="fluid">Fit window</option><option value="1440">1440px</option><option value="1200">1200px</option><option value="390">390px</option>
      </select></label>
    </div>
    <div className="brief-pebble-review-viewport" style={{ width: viewport === "fluid" ? "100%" : Number(viewport) }}>
      <NavigationShell shell={shell} rooms={BRIEF_ROOMS} binding={binding} reducedMotion={reduced}
        conversation={{ source: "fixture", content: <ExampleConversation /> }}>
        <ExampleRoom key={route.room} shell={shell} />
      </NavigationShell>
    </div>
  </div>;
}

function ExampleConversation() {
  const [draft, setDraft] = useState("");
  const [long, setLong] = useState(false);
  return <>
    <div className="brief-pebble-demo-tabs"><span>General</span></div>
    <div className="brief-pebble-demo-thread" role="region" aria-label="Illustrative conversation" tabIndex={0}>
      <h2>What are we moving forward?</h2>
      <p>This conversation is a layout sample. Drafts stay here while you move around.</p>
      <BriefButton variant="text" size="sm" onClick={() => setLong(!long)}>{long ? "Short conversation" : "Long conversation"}</BriefButton>
      {long && Array.from({ length: 14 }, (_, i) => <div className="brief-pebble-demo-message" key={i}>
        <p className="brief-type-utility">Sample reply {i + 1}</p>
        <p>Use the meeting notes to prepare a clear follow-up. Keep the pilot date for your review before sending.</p>
      </div>)}
    </div>
    <div className="brief-pebble-demo-suggestions">
      <BriefButton size="sm" variant="secondary" onClick={() => setDraft("Prepare my next call with Alex.")}>Prepare a call</BriefButton>
      <BriefButton size="sm" variant="secondary" onClick={() => setDraft("Review the meeting follow-up workflow.")}>Review a workflow</BriefButton>
    </div>
    <textarea className="brief-pebble-demo-composer" data-pebble-focus aria-label="Conversation draft" rows={2}
      placeholder="Ask Jarvis…" value={draft} onChange={event => setDraft(event.target.value)} />
  </>;
}

function ExampleRoom({ shell }: { shell: BriefShellPort }) {
  const { open, layout } = usePebbleWorkspace();
  const [selected, setSelected] = useState("Read meeting notes");
  const [inspector, setInspector] = useState(false);
  const [review, setReview] = useState(false);
  const [draft, setDraft] = useState("");
  const [long, setLong] = useState(false);
  const today = shell.route.room === "today";
  return <div className="brief-pebble-demo-room" data-sample-selection={selected} data-sample-inspector={inspector}>
    <h1 className="brief-type-room-title">{today ? "Good morning, Vieri." : shell.route.room === "workflow" ? "Meeting follow-ups" : BRIEF_ROOMS[shell.route.room]?.title}</h1>
    <div className="brief-pebble-demo-topline">
      <span className="brief-type-utility">Illustrative content · {open ? `${layout} conversation` : "full workspace"}</span>
      <BriefButton size="sm" variant="text" onClick={() => setLong(!long)}>{long ? "Short page" : "Long page"}</BriefButton>
    </div>
    {today ? <>
      <section className="brief-pebble-demo-hero">
        <div><span className="brief-pebble-demo-status">Needs your review</span><h2>The follow-up is ready.<br />One detail needs your eyes.</h2>
          <p>Your email to Alex is drafted.<br />Confirm the pilot date before sending.</p>
          <BriefButton variant="primary" onClick={() => setReview(!review)}>{review ? "Close sample review" : "Review follow-up"}</BriefButton></div>
        <div className="brief-pebble-demo-paper"><Mail size={16} /><strong>Follow-up draft</strong><hr /><p>To Alex</p><h3>Our pilot: next steps</h3><p>Let’s start with meeting follow-ups.</p><mark>Pilot date needs confirming</mark></div>
      </section>
      {review && <section className="brief-pebble-demo-card"><h2>Follow-up draft</h2><BriefInput label="Pilot date" defaultValue="Confirm with Alex" /></section>}
      <div className="brief-pebble-demo-outcomes"><div><strong>90<span> min</span></strong><p>back today</p></div><div><strong>+2</strong><p>partners this week</p></div><div><strong>6<span> / 10</span></strong><p>design partners signed</p></div></div>
    </> : shell.route.room === "workflow" ? <div className="brief-pebble-demo-canvas">
      <div className="brief-pebble-demo-graph">{["Meeting ends", "Read meeting notes", "Draft the follow-up", "Review before sending", "Send through Gmail"].map(name =>
        <button key={name} aria-pressed={selected === name && inspector} onClick={() => { setSelected(name); setInspector(true); }}><FileText size={16} /><span>{name}</span></button>)}</div>
      {inspector && <section className="brief-pebble-demo-inspector"><h2>{selected}</h2><BriefInput label="Node instructions" defaultValue="Keep the agreed next step clear." /><BriefButton onClick={() => setInspector(false)}>Close inspector</BriefButton></section>}
    </div> : shell.route.room === "all-workflows" ? <div className="brief-pebble-demo-list">{["Meeting follow-ups", "Morning inbox brief", "Competitor watch", "Weekly investor update"].map((name, i) =>
      <button key={name} aria-pressed={selected === name} onClick={() => setSelected(name)}><strong>{name}</strong><span><Check size={14} /> Enabled</span><span>{i ? "Yesterday" : "12 min ago"}</span></button>)}</div>
      : shell.route.room === "memory-detail" ? <article className="brief-pebble-demo-card"><FileText size={20} /><h2>Keep follow-ups concise, with one clear next step.</h2><p>From your conversation with Jarvis.</p><BriefInput label="Memory wording" defaultValue="Keep follow-ups concise, with one clear next step." /><p className="brief-type-utility">Used in Meeting follow-ups</p></article>
      : <section className="brief-pebble-demo-card"><h2>Your details</h2><BriefInput label="Display name" defaultValue="Vieri Balboni" /><BriefInput label="Company" defaultValue="Jarvis" /></section>}
    <section className="brief-pebble-demo-continuity">
      <BriefInput label="Retained room draft" placeholder="Write a note, then open Pebble" value={draft} onChange={event => setDraft(event.target.value)} />
      {long && Array.from({ length: 15 }, (_, i) => <div className="brief-pebble-demo-history" key={i}><span>Activity {i + 1}</span><span>Sample work completed</span><span>09:{String(10 + i).padStart(2, "0")}</span></div>)}
      <p className="brief-type-utility">Sample selection: {selected}</p>
      <BriefButton variant="secondary" onClick={() => shell.setChatOpen(true)}>Discuss this selection</BriefButton>
    </section>
  </div>;
}
