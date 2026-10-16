import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../../styles/globals.css";
import "../../../../v2/ui/primitives.css";
import { ExplainerView, explainerCopy, type ExplainerModel } from "../index";
import "./preview.css";

function Preview() {
  const [model, setModel] = useState<ExplainerModel>({ theme: "light", state: { kind: "ready" } });
  const [longCopy, setLongCopy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [reduced, setReduced] = useState(false);
  const [intents, setIntents] = useState<string[]>([]);
  return (
    <div className="explainer-preview-root" data-reduced={reduced} style={{ zoom, width: `${100 / zoom}vw`, height: `${100 / zoom}dvh` }}>
      <aside className="explainer-preview-tools" aria-label="Preview controls">
        <strong>ON-U-02 · Preview only</strong>
        <label>Theme <select value={model.theme} onChange={e => setModel({ ...model, theme: e.target.value as ExplainerModel["theme"] })}>
          <option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
        <label>View state <select value={model.state.kind} onChange={e => {
          const kind = e.target.value;
          setModel({ ...model, state: kind === "pending" ? { kind, message: "Opening the next step…" }
            : kind === "error" ? { kind, message: "The next step could not be opened. Please try again." } : { kind: "ready" } });
        }}><option value="ready">Ready</option><option value="pending">Pending</option><option value="error">Error</option></select></label>
        <label><input type="checkbox" checked={longCopy} onChange={e => setLongCopy(e.target.checked)} /> Long copy</label>
        <label>Preview zoom <select value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value="1">100%</option><option value="2">200%</option></select></label>
        <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> No motion</label>
        <output aria-live="polite">{intents.length} intents · {intents.at(-1) ?? "None"}</output>
      </aside>
      <main>
        <ExplainerView model={model} onBack={() => setIntents([...intents, "Back"])} onContinue={() => setIntents([...intents, "Continue"])}
          copy={longCopy ? { ...explainerCopy, title: "Less repetition in your everyday work. More room for everything you are building.", steps: [
            { ...explainerCopy.steps[0], description: "The same lead follow-up, checked against contact history and drafted again, several days a week." },
            { ...explainerCopy.steps[1], title: "A workflow draft takes shape for you to review", description: "Say yes and Jarvis drafts the steps, with every one waiting for your review before anything runs." },
            { ...explainerCopy.steps[2], description: "Less time on repeated follow-ups and more time to meet prospective partners and learn what they need." },
          ] } : undefined} />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
