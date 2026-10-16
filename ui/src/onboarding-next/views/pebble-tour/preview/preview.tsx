import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { available, BriefBrand, PebbleLayout } from "on-u-06-shell-fixture";
import { PebbleTourView } from "../index";
import type { PebbleTourIntent, PebbleTourSurfaceProps } from "../index";
import "./preview.css";

/** Actual D-06 layout and official mark, with inert illustrative room content and
 * an unsent local draft. There is no provider, socket, upload or send callback. */
function Surface({ open, onOpenChange, reducedMotion }: PebbleTourSurfaceProps) {
  return <PebbleLayout shell={{ mode: "preview", chatOpen: open, setChatOpen: onOpenChange }} enabled
    reducedMotion={reducedMotion} conversation={{ source: "fixture", content: <Conversation /> }}>
    <Room />
  </PebbleLayout>;
}
function Conversation() {
  const [draft, setDraft] = useState("");
  return <div className="demo-conversation">
    <div className="demo-tabs">General</div>
    <h2>What are we moving forward?</h2>
    <div className="demo-compose">
      <span>Sample conversation · nothing will be sent</span>
      <textarea data-pebble-focus aria-label="Unsent sample draft" rows={1} placeholder="Ask Jarvis…" value={draft} onChange={event => setDraft(event.target.value)} />
    </div>
  </div>;
}
function Room() {
  return <div className="demo-room" data-selected-object="sample-follow-up" tabIndex={-1}>
    <p className="demo-date">Thursday, 17 September</p><h1>Good morning, Sam.</h1>
    <div className="demo-grid">
      <section className="demo-hero"><div><span className="demo-status">Needs your review</span>
        <h2>The follow-up is ready.<br />One detail needs your eyes.</h2><p>Your email to Alex is drafted.<br />Confirm the pilot date before sending.</p></div>
        <article className="demo-paper"><strong>Follow-up draft</strong><hr /><p>To Alex</p><b>Our pilot: next steps</b><p>Let’s start with meeting follow-ups.</p><mark>Pilot date needs confirming</mark></article></section>
      <section className="demo-goal"><strong>Win 10 design partners</strong><p><b>6</b> / 10 signed</p><div className="demo-progress">{Array.from({ length: 10 }, (_, i) => <i data-complete={i < 6} key={i} />)}</div></section>
      <section className="demo-outcomes"><div><strong>90<small> min</small></strong><span>saved today · estimated</span></div><div><b>+2</b><span>partners this week</span></div></section>
      <section className="demo-activity"><strong>Recent activity</strong><p>Inbox brief saved · 08:31</p><p>Meeting notes organised · 09:02</p></section>
    </div>
  </div>;
}
function Preview() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [open, setOpen] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [missing, setMissing] = useState(false);
  const [intent, setIntent] = useState<PebbleTourIntent | null>(null);
  const [session, setSession] = useState(0);
  const [revision, setRevision] = useState(0);
  return <div className="brief-root demo" data-brief-theme={theme}>
    <div className="demo-controls"><strong>ON-U-06 · Isolated tutorial preview</strong>
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? "Dark" : "Light"}</button>
      <button onClick={() => setSidebar(sidebar === "expanded" ? "rail" : "expanded")}>{sidebar === "expanded" ? "Collapse sidebar" : "Expand sidebar"}</button>
      <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} />Reduce motion</label>
      <label><input type="checkbox" checked={missing} onChange={e => setMissing(e.target.checked)} />Missing adapter</label>
      <button onClick={() => { setIntent(null); setSession(n => n + 1); setOpen(false); }}>Restart tutorial</button>
    </div>
    <div className="demo-shell" data-sidebar={sidebar}>
      <aside className="demo-sidebar"><BriefBrand /><nav aria-label="Illustrative navigation">{["Today", "Workflows", "Opportunities", "Needs you", "Goals", "Memory"].map((name, i) => <span key={name} data-active={i === 0}>{sidebar === "rail" ? name.slice(0, 1) : name}</span>)}</nav><span className="demo-account">{sidebar === "rail" ? "S" : "Sample account · Pro plan"}</span></aside>
      <div className="demo-main"><header>Sample workspace <span>/</span> <strong>Today</strong><i aria-label="Sample connected state" /></header>
        {intent ? <div className="demo-handoff"><p>Preview handoff · no journey completed</p><h1>{intent.to === "first-workflow" ? "Let’s make room for your work." : "Return to Billing tour step"}</h1><p>The host receives <code>{intent.action} → {intent.to}</code>. The first-workflow prompt belongs to ON-U-07.</p><button onClick={() => { setIntent(null); setRevision(n => n + 1); }}>Return to Pebble tutorial</button></div>
          : <PebbleTourView model={{ sessionId: `preview-${session}`, revision, phase: "ready", theme, sidebar }}
            adapter={!missing && available ? { isolation: "tutorial-sandbox", status: "ready", open, Surface, onOpenChange: setOpen } : undefined}
            reducedMotion={reduced} onNavigate={setIntent} />}
      </div>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
