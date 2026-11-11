import { useId } from "react";
import { Button } from "../../../v2/ui/Button";
import "./explainer.css";

/** Local structural projection. The optional host owns routing and persistence. */
export interface ExplainerModel {
  theme: "light" | "dark";
  /** Whether this install will propose routines ("on"), or not ("self" = off on a self-hosted install, "off" = off or unknown).
   * Absent means unknown, which is shown as off: the explainer only promises what this install will do. */
  suggestions?: "on" | "self" | "off";
  state: { kind: "ready" } | { kind: "pending"; message: string } | { kind: "error"; message: string };
}

export interface ExplainerCopy {
  title: string;
  description: string;
  steps: readonly [
    { title: string; description: string },
    { title: string; description: string },
    { title: string; description: string },
  ];
  alternativeTitle: string;
  alternativeDescription: string;
}

/**
 * Layout from Figma 1097:16424. The copy is held to what Awareness does on main
 * (docs/opportunity-routines.md): it recognizes a few ordered, multi-step routines
 * from screen captures and asks before anything runs. This copy is shown only
 * when prepared opportunities are on, and those draft the workflow for review
 * before the person is asked (src/awareness/prepared-opportunities.ts), so the
 * copy promises that nothing runs, not that nothing is drafted, until they say
 * yes. It never runs one automatically or measures time saved.
 * The example uses a supported routine (lead follow-up); research and reading
 * contexts are deliberately ignored by the classifier.
 */
export const explainerCopy: Readonly<ExplainerCopy> = {
  title: "Less repetition. More room to build.",
  description: "With Awareness on, Jarvis looks for multi-step routines you repeat on screen and asks whether to turn one into a workflow. Nothing runs until you say yes.",
  steps: [
    { title: "Jarvis notices", description: "The same lead follow-up, repeated over several days." },
    { title: "A workflow takes shape", description: "Jarvis drafts the steps for you to review." },
    { title: "Your goal moves forward", description: "Less time on follow-ups, more on your next design partner." },
  ],
  alternativeTitle: "Already know what to automate?",
  alternativeDescription: "Describe it in Workflows. Jarvis builds the steps with you.",
};

/**
 * Shown when prepared opportunities are off (self-hosted default, see
 * docs/hosted-dashboard.md) or not confirmed. Same layout, no promise of a
 * prepared routine proposal. Workflows is the path that works everywhere. It
 * names what is off (prepared opportunities, as Today does) rather than saying
 * suggestions are off: with Awareness on, a recognized routine is still raised
 * as a question notification without preparation.
 */
export const explainerCopyWithoutSuggestions: Readonly<ExplainerCopy> = {
  title: "Less repetition. More room to build.",
  description: "Describe a recurring job in Workflows and Jarvis builds it with you. Nothing runs until you review it.",
  steps: [
    { title: "You describe the job", description: "The same lead follow-up you send every week." },
    { title: "A workflow takes shape", description: "Jarvis drafts the steps for you to review." },
    { title: "Your goal moves forward", description: "Less time on follow-ups, more on your next design partner." },
  ],
  alternativeTitle: "Want Jarvis to prepare workflows from your routines?",
  alternativeDescription: "Prepared opportunities are off on this Jarvis for now.",
};
/** Small secondary detail for a self-hosted operator. */
export const SELF_HOSTED_SUGGESTIONS_HINT = "To turn them on, set JARVIS_BRIEF_PREPARED_OPPORTUNITIES=1 and restart Jarvis.";

export interface ExplainerViewProps {
  model: ExplainerModel;
  onBack: () => void;
  onContinue: () => void;
  copy?: Readonly<ExplainerCopy>;
}

/** A standalone, scrollable view. It neither requests permissions nor starts Awareness. */
export function ExplainerView({ model, onBack, onContinue, copy: copyOverride }: ExplainerViewProps) {
  const copy = copyOverride ?? (model.suggestions === "on" ? explainerCopy : explainerCopyWithoutSuggestions);
  const headingId = useId();
  const pending = model.state.kind === "pending";
  return (
    <section className="on-explainer" data-theme={model.theme} aria-labelledby={headingId}>
      <div className="on-explainer__content">
        <div className="on-explainer__pebble" aria-hidden="true" />
        <h1 id={headingId}>{copy.title}</h1>
        <p className="on-explainer__description">{copy.description}</p>

        <ol className="on-explainer__steps" aria-label="From repetition to your goal">
          {copy.steps.map((step, index) => (
            <li key={index} className="on-explainer__step">
              <span className="on-explainer__number" aria-hidden="true">0{index + 1}</span>
              <h2>{step.title}</h2>
              <p>{step.description}</p>
              {index < 2 && <span className="on-explainer__arrow" aria-hidden="true">→</span>}
            </li>
          ))}
        </ol>

        <div className="on-explainer__alternative">
          <h2>{copy.alternativeTitle}</h2>
          <p>{copy.alternativeDescription}</p>
          {!copyOverride && model.suggestions === "self" && <p className="on-explainer__hint">{SELF_HOSTED_SUGGESTIONS_HINT}</p>}
        </div>

        <div className="on-explainer__actions">
          <Button className="on-explainer__control on-explainer__back" aria-disabled={pending}
            onClick={() => { if (!pending) onBack(); }}>Back</Button>
          <Button variant="primary" className="on-explainer__control on-explainer__continue" aria-disabled={pending}
            onClick={() => { if (!pending) onContinue(); }}>Continue</Button>
        </div>
        <div className="on-explainer__feedback">
          <p role="status">{model.state.kind === "pending" ? model.state.message : ""}</p>
          <p role="alert">{model.state.kind === "error" ? model.state.message : ""}</p>
        </div>
      </div>
    </section>
  );
}
