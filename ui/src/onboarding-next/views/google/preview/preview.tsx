import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../../styles/globals.css";
import "../../../../v2/ui/primitives.css";
import { GoogleView, type GoogleConnectionState, type GoogleModel } from "../index";
import "./preview.css";

const cases: Record<string, GoogleConnectionState> = {
  idle: { state: "idle" },
  pending: { state: "pending", attemptId: "illustrative-attempt" },
  connected: { state: "connected", attemptId: "illustrative-attempt", accountLabel: "founder@example.com", grantedAccessSummary: "Read-only access to your calendar and Gmail." },
  cancelled: { state: "cancelled", attemptId: "illustrative-attempt" },
  expired: { state: "expired", attemptId: "illustrative-attempt" },
  denied: { state: "error", attemptId: "illustrative-attempt", message: "Google consent was denied. Try again, or skip for now." },
  window: { state: "error", attemptId: null, message: "The sign-in window could not be opened. Try again, or skip for now." },
  error: { state: "error", attemptId: null, message: "Could not confirm your Google connection. Try again, or skip for now." },
  unavailable: { state: "unavailable", message: "Google connection is unavailable on this instance. You can skip for now." },
};
function Preview() {
  const [theme, setTheme] = useState<GoogleModel["theme"]>("light");
  const [scenario, setScenario] = useState("idle");
  const [navigation, setNavigation] = useState<GoogleModel["navigation"]>({ kind: "ready" });
  const [long, setLong] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [reduced, setReduced] = useState(false);
  const [intents, setIntents] = useState<string[]>([]);
  const record = (intent: string) => setIntents(items => [...items, intent]);
  let connection = cases[scenario]!;
  if (long && (connection.state === "connected" || connection.state === "pending")) {
    connection = { ...connection, accountLabel: "founder-and-customer-research-team@our-company-with-a-long-name.example" };
  }
  return (
    <div className="google-preview-root" data-reduced={reduced} style={{ zoom, width: `${100 / zoom}vw`, height: `${100 / zoom}dvh` }}>
      <aside className="google-preview-tools" aria-label="Preview controls">
        <strong>ON-U-03 · Preview only</strong>
        <label>Theme <select value={theme} onChange={e => setTheme(e.target.value as GoogleModel["theme"])}><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label>Connection <select value={scenario} onChange={e => setScenario(e.target.value)}>{Object.keys(cases).map(key => <option key={key} value={key}>{key}</option>)}</select></label>
        <label>Navigation <select value={navigation.kind} onChange={e => {
          const kind = e.target.value;
          setNavigation(kind === "pending" ? { kind, message: "Opening the next step…" } : kind === "error" ? { kind, message: "The next step could not be opened. Try again." } : { kind: "ready" });
        }}><option value="ready">Ready</option><option value="pending">Pending</option><option value="error">Error</option></select></label>
        <label><input type="checkbox" checked={long} onChange={e => setLong(e.target.checked)} /> Long account</label>
        <label>Preview zoom <select value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value="1">100%</option><option value="2">200%</option></select></label>
        <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> No motion</label>
        <output aria-live="polite">{intents.length} intents · {intents.at(-1) ?? "None"}</output>
      </aside>
      <main><GoogleView model={{ theme, connection, navigation, progress: { current: 3, total: 6 } }}
        onConnect={() => { record("Connect"); setScenario("pending"); }}
        onCancel={id => { record(`Cancel ${id}`); setScenario("cancelled"); }}
        onBack={() => record("Back")} onSkip={() => record("Skip")} onContinue={() => record("Continue")} /></main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
