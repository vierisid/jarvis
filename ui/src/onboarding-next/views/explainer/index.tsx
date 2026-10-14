import { useId } from "react";
import { Button } from "../../../v2/ui/Button";
import "./explainer.css";

/** Local structural projection. The optional host owns routing and persistence. */
export interface ExplainerModel {
  theme: "light" | "dark";
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

/** Approved Figma 1097:16424. These are illustrative benefits, not live activity. */
export const explainerCopy: Readonly<ExplainerCopy> = {
  title: "Less repetition. More room to build.",
  description: "With Awareness on, Jarvis watches your screen, finds repeated work, and prepares workflows for you to review.",
  steps: [
    { title: "Jarvis notices", description: "The same research before every sales call." },
    { title: "A workflow takes shape", description: "Context and questions, prepared before the call." },
    { title: "Your goal moves forward", description: "More time to win your next design partner." },
  ],
  alternativeTitle: "Already know what to automate?",
  alternativeDescription: "Describe it in Workflows. Jarvis builds the steps with you.",
};

export interface ExplainerViewProps {
  model: ExplainerModel;
  onBack: () => void;
  onContinue: () => void;
  copy?: Readonly<ExplainerCopy>;
}

/** A standalone, scrollable view. It neither requests permissions nor starts Awareness. */
export function ExplainerView({ model, onBack, onContinue, copy = explainerCopy }: ExplainerViewProps) {
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
