import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TOUR_STEPS, TourView, type TourIntent, type TourModel, type TourRoomRenderer } from "../index";
import "./preview.css";

/** Adapter fixture, not a duplicate dashboard or a claim of live D-room integration. */
const renderer: TourRoomRenderer = { isolation: "fixture-only", renderRoom: ({ step, theme, sidebar }) => ({
  status: "ready", content: <div className="tour-fixture" data-theme={theme} data-sidebar={sidebar}>
    <div className="tour-fixture__rail" aria-hidden="true"><span>UI</span>{TOUR_STEPS.slice(0, 8).map(item => <span key={item.id} data-selected={item.id === step.id}>{sidebar === "rail" ? item.room.slice(0, 1) : item.room}</span>)}</div>
    <div className="tour-fixture__content"><p className="tour-fixture__label">ROOM RENDERER FIXTURE</p><h1>{step.room}</h1>
      <p>The host supplies the approved dashboard room here.</p><p>This standalone preview checks the tutorial card. It does not recreate the D-line dashboard.</p>
      <div className="tour-fixture__subject">Highlighted subject stays above the tutorial.<span>Read-only fixture</span></div>
    </div></div>
}) };

function Preview() {
  const [model, setModel] = useState<TourModel>({ sessionId: "tour-fixture", stepId: "today", revision: 0, phase: "ready", theme: "light", sidebar: "expanded" });
  const [scenario, setScenario] = useState("ready");
  const [loadedStep, setLoadedStep] = useState<string | null>(null);
  useEffect(() => {
    setLoadedStep(null);
    if (scenario !== "delayed") return;
    const timer = setTimeout(() => setLoadedStep(model.stepId), 1200);
    return () => clearTimeout(timer);
  }, [scenario, model.stepId]);
  const roomState = scenario === "delayed" ? loadedStep === model.stepId ? "ready" : "loading" : scenario;
  const [reduced, setReduced] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [intent, setIntent] = useState("No navigation yet.");
  const onNavigate = (request: TourIntent) => {
    setIntent(`${request.action} from ${request.from}${request.to ? ` to ${request.to}` : ""}`);
    if (request.action === "skip" || request.action === "open-pebble") {
      setModel(current => ({ ...current, revision: current.revision + 1 }));
      return; // U06 and B06 own the continuation. Never mark onboarding complete.
    }
    setModel(current => ({ ...current, stepId: request.to!, revision: current.revision + 1 }));
  };
  return <><div className="tour-preview-tools" aria-label="Isolated review controls">
    <strong>ON-U-05 · Tutorial preview</strong>
    <label>Room <select value={model.stepId} onChange={event => setModel({ ...model, stepId: event.target.value, revision: model.revision + 1 })}>{TOUR_STEPS.map(step => <option key={step.id} value={step.id}>{step.room}</option>)}</select></label>
    <button onClick={() => setModel({ ...model, theme: model.theme === "light" ? "dark" : "light" })}>Switch to {model.theme === "light" ? "dark" : "light"}</button>
    <button onClick={() => setModel({ ...model, sidebar: model.sidebar === "rail" ? "expanded" : "rail" })}>{model.sidebar === "rail" ? "Expand" : "Collapse"} sidebar</button>
    <label>Room adapter <select value={scenario} onChange={event => { setScenario(event.target.value); setModel({ ...model, revision: model.revision + 1 }); }}><option>ready</option><option>delayed</option><option>absent</option><option>loading</option><option>error</option></select></label>
    <label><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />Reduced motion</label>
    <label><input type="checkbox" checked={zoom} onChange={event => setZoom(event.target.checked)} />200% preview</label>
    <output aria-live="polite">{intent}</output>
  </div><main className="tour-preview-stage" style={{ zoom: zoom ? 2 : 1 }}>
    <TourView model={model} onNavigate={onNavigate} reducedMotion={reduced} renderer={roomState === "absent" ? undefined : roomState === "ready" ? renderer : { isolation: "fixture-only", renderRoom: () => ({ status: roomState as "loading" | "error" }) }} />
  </main></>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
