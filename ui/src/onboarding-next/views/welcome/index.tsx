import { useId, type ReactNode } from "react";
import { Button } from "../../../v2/ui/Button";
import "./welcome.css";

export type WelcomeTheme = "light" | "dark";

/** Local structural projection. No dependency on an unmerged journey provider. */
export interface WelcomeModel {
  theme: WelcomeTheme;
  installMode: "hosted" | "self" | "unknown";
  state: { kind: "ready" } | { kind: "pending"; message: string } | { kind: "error"; message: string };
}

export interface WelcomeCopy {
  title: string;
  subtitle: string;
  description: string;
}

export const welcomeCopy: Readonly<WelcomeCopy> = {
  title: "Your AI Co-Founder.",
  subtitle: "Let’s make room to build.",
  description: "Give repetitive work a workflow. Jarvis helps you find what to automate, build the steps, and use AI where judgment matters. First, let’s connect your tools and learn how you work.",
};

const setupNotes: Record<WelcomeModel["installMode"], string> = {
  hosted: "AI and voice are included with your plan. The interview is written. After setup, voice replies start enabled; change or turn them off in Settings → Channels.",
  self: "Choose your AI and optional voice, then tell Jarvis a little about your work. You can skip optional steps and return later.",
  unknown: "Tell Jarvis a little about your work in a short written interview. You can skip optional steps and return later.",
};

export interface SetupFrameProps {
  theme: WelcomeTheme;
  labelledBy: string;
  children: ReactNode;
}

/** An ordinary scrollable surface, not a modal or a live onboarding entry. */
export function SetupFrame({ theme, labelledBy, children }: SetupFrameProps) {
  return (
    <section className="on-welcome" data-theme={theme} aria-labelledby={labelledBy}>
      <div className="on-welcome__content">{children}</div>
    </section>
  );
}

export interface WelcomeViewProps {
  model: WelcomeModel;
  onSetUp: () => void;
  onExit: () => void;
  onThemeChange: (theme: WelcomeTheme) => void;
  copy?: Readonly<WelcomeCopy>;
}

/** Emits intents only. The host owns persistence, routing and pending state. */
export function WelcomeView({ model, onSetUp, onExit, onThemeChange, copy = welcomeCopy }: WelcomeViewProps) {
  const headingId = useId();
  const themeLabelId = useId();
  const pending = model.state.kind === "pending";

  return (
    <SetupFrame theme={model.theme} labelledBy={headingId}>
      <div className="on-welcome__brand">
        <div className="on-welcome__mark-space" aria-hidden="true">
          <div className="on-welcome__pebble" />
        </div>
        <div className="on-welcome__wordmark" aria-label="usejarvis">
          <span>use</span>jarvis
        </div>
      </div>
      <h1 id={headingId} className="on-welcome__heading">
        {copy.title}<br />{copy.subtitle}
      </h1>
      <p className="on-welcome__description">{copy.description}</p>
      <p className="on-welcome__note">{setupNotes[model.installMode]}</p>

      <div className="on-welcome__appearance">
        <p id={themeLabelId} className="on-welcome__label">Choose your look</p>
        <div className="on-welcome__themes" role="group" aria-labelledby={themeLabelId}>
          {(["light", "dark"] as const).map((theme) => (
            <Button
              key={theme}
              className="on-welcome__control on-welcome__theme"
              aria-pressed={model.theme === theme}
              onClick={() => { if (model.theme !== theme) onThemeChange(theme); }}
            >
              {theme === "light" ? "Light" : "Dark"}
            </Button>
          ))}
        </div>
      </div>

      <div className="on-welcome__actions">
        <Button
          variant="primary"
          className="on-welcome__control on-welcome__start"
          aria-disabled={pending}
          onClick={() => { if (!pending) onSetUp(); }}
        >Set up Jarvis</Button>
        <Button
          className="on-welcome__control on-welcome__exit"
          aria-disabled={pending}
          onClick={() => { if (!pending) onExit(); }}
        >I’ll do this later</Button>
      </div>
      <div className="on-welcome__feedback">
        <p role="status">{model.state.kind === "pending" ? model.state.message : ""}</p>
        <p role="alert">{model.state.kind === "error" ? model.state.message : ""}</p>
      </div>
    </SetupFrame>
  );
}
