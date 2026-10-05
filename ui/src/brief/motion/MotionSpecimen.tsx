import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowRight, Check, FileText, Plus, X } from "lucide-react";
import { BriefButton, BriefIconButton, BriefSegments } from "../components/controls";
import { BriefBrand } from "../styles/BriefBrand";
import { BRIEF_MOTION, briefMotionVariables, useBriefMotion, useBriefReducedMotion } from "./index";
import type { MotionKind, MotionSample } from "./index";
import { recordMotionTrace, type MotionTrace } from "./trace";
import "./specimen.css";

type ExampleProps = { active: boolean; reduced: boolean; onChange: (active: boolean) => void; onSample: (sample: MotionSample) => void };
const names: Record<MotionKind, string> = { press: "Contact", reveal: "Reveal", selection: "Selection", reflow: "Make room", transfer: "Transfer", settle: "Settle" };
const initial = () => ({ press: false, reveal: false, selection: false, reflow: false, transfer: false, settle: false });
function measuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const node = ref.current;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    setWidth(node.clientWidth); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
function Press(p: ExampleProps) {
  const overlay = useBriefMotion<HTMLSpanElement>({ opacity: p.active ? .14 : 0 }, { ...p, kind: "press" });
  return <div className="brief-motion__small-stage"><button className="brief-motion__contact" aria-pressed={p.active}
    onPointerDown={() => p.onChange(true)} onPointerUp={() => p.onChange(false)} onPointerCancel={() => p.onChange(false)}
    onPointerLeave={() => p.onChange(false)} onKeyDown={e => { if (e.key === " " || e.key === "Enter") p.onChange(true); }}
    onKeyUp={() => p.onChange(false)} onBlur={() => p.onChange(false)}>
    <span ref={overlay} data-motion-part="press" aria-hidden="true" /><span data-motion-anchor>Press and hold</span><ArrowRight size={16} />
  </button></div>;
}
function Reveal(p: ExampleProps) {
  const menu = useBriefMotion({ transform: `translateY(${p.active ? 0 : 8}px)`, opacity: p.active ? 1 : 0 }, { ...p, kind: "reveal" });
  return <div className="brief-motion__small-stage brief-motion__reveal">
    <BriefButton aria-expanded={p.active} aria-controls="motion-source" onClick={() => p.onChange(!p.active)}><Plus size={16} />Add source</BriefButton>
    <div ref={menu} id="motion-source" data-motion-part="reveal" className="brief-motion__menu" inert={!p.active} aria-hidden={!p.active}>
      <FileText size={16} /><span>Meeting notes</span><Check size={14} />
    </div>
  </div>;
}
function Selection(p: ExampleProps) {
  const line = useBriefMotion<HTMLSpanElement>({ transform: `translateX(${p.active ? 140 : 0}px)` }, { ...p, kind: "selection" });
  return <div className="brief-motion__small-stage"><div className="brief-motion__selection">
    <div className="brief-motion__choices" role="group" aria-label="Motion selection example" data-motion-anchor>
      <button aria-pressed={!p.active} onClick={() => p.onChange(false)}>Overview</button><button aria-pressed={p.active} onClick={() => p.onChange(true)}>Activity</button>
      <span ref={line} data-motion-part="selection" aria-hidden="true" />
    </div><p>{p.active ? "Your latest work, ready to read." : "Your direction, always in view."}</p>
  </div></div>;
}
function Reflow(p: ExampleProps) {
  const { ref, width } = measuredWidth();
  const narrow = width < 620;
  const previousWidth = useRef(width);
  const resized = previousWidth.current !== width;
  useLayoutEffect(() => { previousWidth.current = width; }, [width]);
  const panelWidth = narrow ? width : Math.min(300, width * .4);
  const work = useBriefMotion({ width: Math.max(0, p.active && !narrow ? width - panelWidth - 16 : width) }, { ...p, kind: "reflow", immediate: width === 0 || resized });
  const panel = useBriefMotion({ transform: `translateY(${p.active ? 0 : 12}px)`, opacity: p.active ? 1 : 0 }, { ...p, kind: "reflow" });
  return <div ref={ref} className="brief-motion__reflow" data-narrow={narrow}>
    <div ref={work} className="brief-motion__work" data-motion-part="work-surface">
      <div className="brief-motion__reading" data-motion-anchor><span className="brief-motion__status">Needs your review</span>
        <h3>The follow-up is ready.</h3><p>One detail needs your eye.</p>
        <BriefButton size="sm" onClick={() => p.onChange(!p.active)} aria-expanded={p.active}>{p.active ? "Close conversation" : "Open conversation"}</BriefButton>
      </div>
    </div>
    <div ref={panel} data-motion-part="conversation" className="brief-motion__panel" style={{ width: panelWidth }} inert={!p.active} aria-hidden={!p.active}>
      <div className="brief-motion__panel-head"><strong>Your conversation</strong><BriefIconButton label="Close example conversation" icon={<X size={16} />} onClick={() => p.onChange(false)} /></div>
      <p>The work stays in view.</p><label className="brief-motion__composer"><span className="brief-sr-only">Example message</span><input placeholder="Ask Jarvis…" defaultValue="Keep this thought." /></label>
    </div>
  </div>;
}
function Transfer(p: ExampleProps) {
  const { ref, width } = measuredWidth();
  const card = useBriefMotion<HTMLButtonElement>({ transform: `translateX(${p.active ? Math.max(0, width / 2) : 0}px)` }, { ...p, kind: "transfer" });
  return <div ref={ref} className="brief-motion__small-stage brief-motion__transfer">
    <div className="brief-motion__slots" data-motion-anchor><span>Next step</span><span>In your stack</span></div>
    <button ref={card} className="brief-motion__job" data-motion-part="transfer" aria-pressed={p.active} onClick={() => p.onChange(!p.active)}><FileText size={16} /><span>Prepare Alex’s call</span></button>
  </div>;
}
function Settle(p: ExampleProps) {
  const card = useBriefMotion<HTMLButtonElement>({ transform: `translateY(${p.active ? 0 : -8}px)` }, { ...p, kind: "settle" });
  return <div className="brief-motion__small-stage"><div className="brief-motion__tray">
    <button ref={card} data-motion-part="settle" className="brief-motion__settle" aria-pressed={p.active} onClick={() => p.onChange(!p.active)}><FileText size={16} /><span>Follow-up draft</span><Check size={16} style={{ visibility: p.active ? "visible" : "hidden" }} /></button>
  </div></div>;
}
const examples = { press: Press, reveal: Reveal, selection: Selection, reflow: Reflow, transfer: Transfer, settle: Settle };
const anchors: Record<MotionKind, string> = { press: "Fixed label. Surface feedback only.", reveal: "The trigger stays put. The menu travels 8px.", selection: "Labels stay still. The underline moves.", reflow: "The reading edge stays put. Surfaces make room.", transfer: "The same work moves between two fixed slots.", settle: "An 8px finish into the same slot." };

/** Isolated fixtures only: no API, business providers, real messages or product preferences. */
export function MotionSpecimen() {
  const [theme, setTheme] = useState("light");
  const [mode, setMode] = useState("system");
  const [width, setWidth] = useState("wide");
  const [values, setValues] = useState(initial);
  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState<MotionTrace | null>(null);
  const reduced = useBriefReducedMotion(mode === "reduce");
  const root = useRef<HTMLDivElement>(null);
  const recorder = useRef<ReturnType<typeof recordMotionTrace> | null>(null);
  const stopped = useRef(false);
  useEffect(() => { stopped.current = false; return () => { stopped.current = true; recorder.current?.stop(); }; }, []);
  const change = (kind: MotionKind, active: boolean) => setValues(previous => ({ ...previous, [kind]: active }));
  async function stress() {
    if (running || !root.current) return;
    setRunning(true); setTrace(null);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    // Establish a known starting endpoint before recording; do not count this as an input cycle.
    flushSync(() => setValues(initial()));
    await wait(360);
    if (stopped.current) return;
    const log = recordMotionTrace(root.current, reduced); recorder.current = log;
    for (let i = 0; i < 40; i++) {
      if (stopped.current) return;
      const active = i % 2 === 0;
      log.input(active);
      flushSync(() => setValues(Object.fromEntries(Object.keys(initial()).map(key => [key, active])) as typeof values));
      await wait(55);
    }
    await wait(360);
    if (stopped.current) return;
    setTrace(log.stop()); recorder.current = null; setRunning(false);
  }
  return <main className="brief-root brief-motion" data-brief-theme={theme} style={briefMotionVariables as React.CSSProperties}>
    <header className="brief-motion__header"><BriefBrand /><span>D-04 · Interactive motion reference</span></header>
    <div className="brief-motion__intro"><div><p className="brief-motion__eyebrow">Built for the twentieth use.</p><h1>Motion with a purpose.</h1><p>Touch, movement, completion. One calm rhythm.</p></div>
      <fieldset disabled={running} className="brief-motion__tools"><legend className="brief-sr-only">Reference settings</legend><BriefSegments label="Motion appearance" value={theme} onValueChange={setTheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <BriefSegments label="Motion preference" value={mode} onValueChange={setMode} options={[{ value: "system", label: "Use system" }, { value: "reduce", label: "Reduce motion" }]} />
        <BriefSegments label="Reference width" value={width} onValueChange={setWidth} options={[{ value: "wide", label: "Wide" }, { value: "compact", label: "Narrow" }]} />
      </fieldset></div>
    <div className="brief-motion__test"><div><strong>{reduced ? "Immediate placement" : "Standard motion"}</strong><p>20 cycles · 40 alternating intents · all six examples</p></div>
      <BriefButton variant="primary" onClick={stress} state={running ? "pending" : "idle"} stateLabels={{ pending: "Recording…" }}>Run 20-cycle check</BriefButton>
      <span role="status">{running ? "Recording browser frames." : trace ? trace.summary.passed ? "Returned to rest. No active animations." : "Check the trace before passing." : "Local examples. No live work runs."}</span>
    </div>
    <div ref={root} className="brief-motion__examples" data-width={width}>
      {(Object.keys(examples) as MotionKind[]).map((kind, index) => { const Example = examples[kind]; return <section key={kind} className={`brief-motion__example brief-motion__example--${kind}`}>
        <div className="brief-motion__caption"><span>0{index + 1}</span><h2>{names[kind]}</h2><small>{BRIEF_MOTION[kind].enter} / {BRIEF_MOTION[kind].exit}ms</small></div>
        <Example active={values[kind]} reduced={reduced} onChange={active => change(kind, active)} onSample={sample => recorder.current?.sample(sample)} />
        <div className="brief-motion__note"><p>{anchors[kind]}</p><BriefButton size="sm" variant="text" aria-pressed={values[kind]} onClick={() => change(kind, !values[kind])}>Toggle {names[kind].toLowerCase()}</BriefButton></div>
      </section>; })}
    </div>
    <details className="brief-motion__evidence"><summary>Recorded evidence and prototype limits</summary>
      <p>Browser timestamps and animation state, not a 60fps claim. Reduced motion uses the OS preference; this page can also request less motion. A preference change finishes at the latest target. No text scaling, queued choreography or real account actions.</p>
      <pre id="motion-trace">{trace ? JSON.stringify(trace, null, 2) : "Run a check to record this browser."}</pre>
    </details>
  </main>;
}
