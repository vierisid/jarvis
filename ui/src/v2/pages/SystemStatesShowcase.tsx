import React, { useState } from "react";
import { SystemTakeoverContent, UpdateBanner, ProviderBusyBanner, type TakeoverKind } from "../shell/SystemStates";
import "../shell/SystemStates.css";
import "./SystemStatesShowcase.css";

/**
 * System-states gallery. Every state framed and viewable in both themes so the
 * set can be QA'd in isolation. Route: #/_states. Offline is the only one wired
 * to a real trigger in the live shell (see AppShell); the rest preview here and
 * via the localStorage overrides until their backends land.
 */

const TAKEOVERS: { kind: TakeoverKind; label: string }[] = [
  { kind: "offline", label: "Offline · can't reach the brain" },
  { kind: "updating", label: "Updating" },
  { kind: "crash", label: "Crash · recovered" },
  { kind: "quota", label: "Out of tokens" },
];

function CtxBehind() {
  return (
    <div className="sysx-ctx" aria-hidden="true">
      <div className="cc wide" /><div className="cc" /><div className="cc" /><div className="cc" /><div className="cc" />
    </div>
  );
}

function Frame({ label, tall, children }: { label: string; tall?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="sysx-frame" data-tall={tall ? "true" : "false"}>{children}</div>
      <div className="sysx-lab">{label}</div>
    </div>
  );
}

export function SystemStatesShowcase(): React.ReactElement {
  const [theme, setTheme] = useState<string>(() =>
    (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme")) || "light",
  );
  const flip = (t: string) => { document.documentElement.setAttribute("data-theme", t); setTheme(t); };

  return (
    <div className="sysx">
      <header className="sysx-head">
        <div>
          <h1>System states</h1>
          <p>When something's wrong, or changing. Two banners over a usable app; four takeovers when the agent can't act. The drop carries the mood.</p>
        </div>
        <div className="sysx-seg" role="group" aria-label="Theme">
          <button className={theme !== "dark" ? "on" : ""} onClick={() => flip("light")}>Light</button>
          <button className={theme === "dark" ? "on" : ""} onClick={() => flip("dark")}>Dark</button>
        </div>
      </header>

      <div className="sysx-grid">
        <Frame label="Update available · banner">
          <UpdateBanner version="0.9.3" />
          <CtxBehind />
        </Frame>
        <Frame label="Provider busy · banner (self-clearing)">
          <ProviderBusyBanner />
          <CtxBehind />
        </Frame>
        {TAKEOVERS.map((t) => (
          <Frame key={t.kind} label={t.label} tall>
            <SystemTakeoverContent kind={t.kind} data={{ version: "0.9.3", quotaTokens: "2M", quotaPlan: "Hosted + AI", resetDate: "Jul 15" }} />
          </Frame>
        ))}
      </div>
    </div>
  );
}
