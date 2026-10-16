import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivationView, type ActivationIntent, type ActivationModel } from "../index";
import "./preview.css";

function Preview() {
  const [model, setModel] = useState<ActivationModel>({ journeyId: "sample-journey", revision: 1, theme: "light",
    availability: "ready", phase: "ready", draft: { prompt: "", contextRefs: [], answers: {} } });
  const [response, setResponse] = useState("accept");
  const [intents, setIntents] = useState<ActivationIntent[]>([]);
  const [exit, setExit] = useState(false);
  const [zoom, setZoom] = useState(false);
  const onIntent = (intent: ActivationIntent) => {
    setIntents(old => [...old, intent]);
    if (intent.action === "create") {
      if (response === "error") throw new Error("Illustrative transport failure");
      if (response === "pending") { setModel(m => ({ ...m, phase: "submitting", pendingRequest: { request: intent.request, answers: intent.answers } })); return; }
      setModel(m => ({ ...m, revision: m.revision + 1, pendingRequest: undefined,
        phase: response === "details" || response === "connection" ? "needs_input" : response === "invalid" ? "invalid" : "accepted",
        issues: response === "details" ? [{ id: "notes", kind: "detail", label: "Where are your meeting notes?", message: "Name the source you want this workflow to use." }]
          : response === "connection" ? [{ id: "google", kind: "connection", label: "Choose a Google account", message: "This example needs a verified Google connection before it can continue." }] : [],
        message: response === "invalid" ? "Add a recurring task and the result you want." : undefined }));
    } else if (intent.action === "resolve_connection") {
      setModel(m => ({ ...m, revision: m.revision + 1, phase: "ready", issues: [], message: "Sample connection selected. No real account was connected.",
        draft: { ...m.draft, contextRefs: [{ kind: "connection", id: "sample-google-connection" }] } }));
    } else setExit(true);
  };
  return <main className="demo" data-theme={model.theme} data-enlarged={zoom}>
    <header className="demo-controls">
      <strong>ON-U-07 · UI fixture</strong>
      <button onClick={() => setModel(m => ({ ...m, theme: m.theme === "light" ? "dark" : "light" }))}>Appearance: {model.theme}</button>
      <label>Response <select value={response} onChange={e => setResponse(e.target.value)}>
        <option value="accept">Accepted handoff</option><option value="details">Missing detail</option><option value="connection">Missing connection</option>
        <option value="invalid">Validation error</option><option value="error">Transport error</option><option value="pending">Stay pending</option>
      </select></label>
      <label><input type="checkbox" checked={model.availability !== "ready"} onChange={e => setModel(m => ({ ...m, availability: e.target.checked ? "unavailable" : "ready" }))} />Missing provider</label>
      <label><input type="checkbox" checked={zoom} onChange={e => setZoom(e.target.checked)} />Enlarged 200%</label>
      <button onClick={() => { setExit(false); setModel(m => ({ ...m, revision: m.revision + 1, phase: "ready", message: undefined, issues: [], pendingRequest: undefined })); }}>Return to request</button>
      <span aria-live="polite">{intents.length} emitted intents</span>
    </header>
    <div className="demo-stage">{exit ? <section className="demo-exit"><h1>Journey handoff</h1><p>{intents.at(-1)?.action === "explore" ? "Explore first. No workflow was created." : "Return to the tour."}</p>
      <button onClick={() => { setExit(false); setModel(m => ({ ...m, revision: m.revision + 1 })); }}>Return with saved text</button></section>
      : <ActivationView model={model} onDraftChange={draft => setModel(m => ({ ...m, draft }))} onIntent={onIntent} canResolveConnection />}</div>
    <details className="demo-receipt"><summary>Illustrative intent receipt · no real job or workflow</summary><pre>{JSON.stringify(intents.at(-1) ?? null, null, 2)}</pre></details>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
