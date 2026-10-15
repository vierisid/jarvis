import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../../styles/globals.css";
import "../../../../v2/ui/primitives.css";
import { WelcomeView, welcomeCopy, type WelcomeModel } from "../index";
import "./preview.css";

function Preview() {
  const [model, setModel] = useState<WelcomeModel>({ theme: "light", installMode: "hosted", state: { kind: "ready" } });
  const [longCopy, setLongCopy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [intentCount, setIntentCount] = useState(0);
  const [lastIntent, setLastIntent] = useState("None");
  function recordIntent(intent: string) {
    setIntentCount((count) => count + 1);
    setLastIntent(intent);
  }
  return (
    <div className="welcome-preview-root" style={{ zoom, width: `${100 / zoom}vw`, height: `${100 / zoom}dvh` }}>
      <aside className="welcome-preview-tools" aria-label="Preview controls">
        <strong>ON-U-01 · Preview only</strong>
        <label>Install mode <select value={model.installMode} onChange={(event) => setModel({ ...model, installMode: event.target.value as WelcomeModel["installMode"] })}>
          <option value="hosted">Hosted</option><option value="self">Self-hosted</option><option value="unknown">Unknown</option>
        </select></label>
        <label>View state <select value={model.state.kind} onChange={(event) => {
          const kind = event.target.value;
          setModel({ ...model, state: kind === "pending"
            ? { kind, message: "Preparing your setup…" }
            : kind === "error" ? { kind, message: "Setup could not be opened. Please try again." } : { kind: "ready" } });
        }}>
          <option value="ready">Ready</option><option value="pending">Pending</option><option value="error">Error</option>
        </select></label>
        <label><input type="checkbox" checked={longCopy} onChange={(event) => setLongCopy(event.target.checked)} /> Long copy</label>
        <label>Preview zoom <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
          <option value="1">100%</option><option value="2">200%</option>
        </select></label>
        <output aria-live="polite">{intentCount} intents · {lastIntent}</output>
      </aside>
      <main>
        <WelcomeView
          model={model}
          copy={longCopy ? { ...welcomeCopy, title: "Your AI Co-Founder, for everything you are building.", description: `${welcomeCopy.description} Bring the routines you know well and the ones you have not had time to improve. You stay in control of the work, the tools and each next step.` } : undefined}
          onSetUp={() => recordIntent("Set up Jarvis")}
          onExit={() => recordIntent("Exit")}
          onThemeChange={(theme) => setModel({ ...model, theme })}
        />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
