import React, { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BuildView, type BuildModel, type BuildIntent, type BuildPhase } from "../index";
import { phases } from "../state";
import "./preview.css";

const prompt = "After each meeting, use my notes to draft a follow-up. Ask me to review it before anything is sent.";
const initial = (jobId = "sample-job-1"): BuildModel => ({ journeyId: "sample-journey", jobId, requestId: "sample-request",
  revision: 1, title: "Meeting follow-ups", prompt, theme: "light", availability: "ready", transport: "connected",
  cancellation: "not_requested", status: { jobId, revision: 1, outcome: "working", phase: "understanding", completedPhases: [] },
  actions: { cancel: true, resume: true, retry: true, provide_input: true, explore: true, openResult: true } });
function Preview() {
  const [model, setModel] = useState<BuildModel>(initial);
  const eventRevision = useRef(100);
  const lastStatus = useRef(model.status);
  if (lastStatus.current?.jobId !== model.jobId || (model.status && model.status.revision > (lastStatus.current?.revision ?? -1))) lastStatus.current = model.status;
  const [fixture, setFixture] = useState("working");
  const [serial, setSerial] = useState(1);
  const [reduced, setReduced] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [failNext, setFailNext] = useState(false);
  const [intents, setIntents] = useState<BuildIntent[]>([]);
  const [exit, setExit] = useState<BuildIntent | null>(null);
  const select = (value: string) => {
    const jobId = "sample-job-" + (serial + 1); setSerial(serial + 1); setFixture(value); setExit(null);
    const next = { ...initial(jobId), theme: model.theme };
    if (value === "no-events") next.status = undefined;
    if (value === "queued") next.status = { jobId, revision: 1, outcome: "queued" };
    if (value === "needs_input") next.status = { jobId, revision: 1, outcome: "needs_input", phase: "understanding", missingInputs: ["Where should the workflow find your meeting notes?"] };
    if (value === "failed") next.status = { jobId, revision: 1, outcome: "failed", phase: "building", safeError: "The builder couldn’t finish the steps. Your original request is saved." };
    if (value === "timed-out") next.timedOut = true;
    if (value === "disconnected") next.transport = "disconnected";
    if (value === "cancelling") next.cancellation = "requested";
    if (value === "cancelled") next.status = { jobId, revision: 1, outcome: "cancelled" };
    if (value === "succeeded") { next.status = { jobId, revision: 1, outcome: "succeeded", completedPhases: phases.map(p => p.id) }; next.result = { state: "pending" }; }
    if (value === "unavailable") next.availability = "unavailable";
    setModel(next);
  };
  const advance = () => setModel(m => {
    const index = phases.findIndex(p => p.id === lastStatus.current?.phase);
    const phase = phases[Math.min(3, index + 1)]!.id;
    return { ...m, status: { jobId: m.jobId, revision: ++eventRevision.current, outcome: "working", phase,
      completedPhases: phases.slice(0, phases.findIndex(p => p.id === phase)).map(p => p.id) } };
  });
  const verify = () => setModel(m => ({ ...m, status: { jobId: m.jobId, revision: ++eventRevision.current, outcome: "succeeded", phase: "saving" as BuildPhase, completedPhases: phases.map(p => p.id) },
    result: { state: "ready", reference: { jobId: m.jobId, requestId: m.requestId, compositionRecordId: "sample-composition", flowId: "sample-flow", versionId: "sample-version", readiness: "ready", activation: "disabled" } } }));
  const onIntent = (intent: BuildIntent) => {
    setIntents(items => [...items, intent]);
    if (failNext) { setFailNext(false); return Promise.reject(new Error("Illustrative connection failure")); }
    if (intent.action === "open_result" || intent.action === "explore" || intent.action === "provide_input") { setExit(intent); return; }
    if (intent.action === "cancel") setModel(m => ({ ...m, revision: m.revision + 1, cancellation: "requested" }));
    if (intent.action === "resume") setModel(m => ({ ...m, revision: m.revision + 1, transport: "connected", timedOut: false }));
    if (intent.action === "retry") { const nextId = "sample-job-" + (serial + 1); setSerial(serial + 1); setModel({ ...initial(nextId), theme: model.theme }); }
  };
  return <main className="demo" data-theme={model.theme} data-enlarged={zoom}>
    <header className="demo-controls"><strong>ON-U-08 · UI fixture</strong>
      <label>Scenario <select value={fixture} onChange={e => select(e.target.value)}>
        {["working", "no-events", "queued", "needs_input", "failed", "timed-out", "disconnected", "cancelling", "cancelled", "succeeded", "unavailable"].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <button onClick={advance}>Next phase</button>
      <button onClick={() => setModel(m => ({ ...m, status: { jobId: m.jobId, revision: 0, outcome: "queued" } }))}>Send stale update</button>
      <button onClick={() => setModel(m => ({ ...m, revision: m.revision + 1, cancellation: "acknowledged", status: { jobId: m.jobId, revision: ++eventRevision.current, outcome: "cancelled" } }))}>Confirm cancellation</button>
      <button onClick={verify}>Verify saved draft</button>
      <button onClick={() => setModel(m => ({ ...m, theme: m.theme === "light" ? "dark" : "light" }))}>Appearance: {model.theme}</button>
      <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} />Reduce motion</label>
      <label><input type="checkbox" checked={zoom} onChange={e => setZoom(e.target.checked)} />Enlarged 200%</label>
      <label><input type="checkbox" checked={failNext} onChange={e => setFailNext(e.target.checked)} />Fail next action</label>
      <span aria-live="polite">{intents.length} emitted intents</span>
    </header>
    <div className="demo-stage">{exit ? <section className="demo-exit">
      <h1>{exit.action === "open_result" ? "Verified result handoff" : exit.action === "provide_input" ? "Return to your request" : "Explore Jarvis"}</h1>
      <p>{exit.action === "open_result" ? "The host would open this exact saved draft in ON-U-09. This fixture has no real workflow or canvas." : "The host handles this navigation while retaining the request and job."}</p>
      {exit.action === "open_result" && <p>{exit.result.flowId} · {exit.result.versionId} · Disabled</p>}
      <p>{model.prompt}</p><button onClick={() => select("working")}>Restart fixture</button>
    </section> : <BuildView model={model} onIntent={onIntent} reducedMotion={reduced} />}</div>
    <details className="demo-receipt"><summary>Illustrative intent receipt · no real job or workflow</summary><pre>{JSON.stringify(intents.at(-1) ?? null, null, 2)}</pre></details>
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => root.unmount());
}
