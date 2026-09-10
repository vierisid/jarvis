import React, { useId, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import "./WorkflowActivation.css";

const EXAMPLES = [
  { label: "Weekly update", task: "Every Friday, turn the notes I provide into a weekly company update with progress, blockers and next steps." },
  { label: "Meeting follow-up", task: "After a meeting, use the notes I provide to draft a follow-up and a list of actions for me to review." },
  { label: "Competitor brief", task: "Each week, check the competitor sources I provide and prepare a brief of what changed and what matters to my company." },
];

export function buildWorkflowRequest(routine: string): string {
  return `Help me create a workflow for this recurring task:\n\n${routine.trim()}\n\nAsk me for any missing details or connections you need. Use programmatic steps for known operations and AI where understanding or judgment is needed. Create a draft for me to review, with any schedule or trigger disabled. Do not publish, enable or run the workflow yet.`;
}

export function WorkflowActivation({ onContinue }: {
  onContinue: (prompt?: string) => void | Promise<void>;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const [routine, setRoutine] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const continueToJarvis = async (prompt?: string) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await onContinue(prompt);
    } catch {
      setError("Couldn’t open Jarvis. Your task is still here. Try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <form className="obw-activation" onSubmit={(event) => {
      event.preventDefault();
      if (routine.trim()) void continueToJarvis(buildWorkflowRequest(routine));
    }}>
      <label htmlFor={id}>What’s one task you keep doing?</label>
      <p className="obw-activation__intro" id={`${id}-help`}>
        Describe the repetition. Jarvis can help turn it into your first workflow.
      </p>
      <textarea
        ref={input}
        id={id}
        value={routine}
        onChange={(event) => setRoutine(event.target.value)}
        placeholder="Every week, I…"
        rows={3}
        maxLength={2000}
        disabled={pending}
        aria-describedby={`${id}-help ${id}-review`}
      />
      <div className="obw-activation__examples" role="group" aria-label="Example recurring tasks">
        <span>Try an example</span>
        {EXAMPLES.map((example) => (
          <button type="button" key={example.label} disabled={pending} onClick={() => {
            setRoutine(example.task);
            input.current?.focus();
          }}>{example.label}</button>
        ))}
      </div>
      <p className="obw-activation__note" id={`${id}-review`}>
        You’ll review and send the request in Talk. Start with a draft, then inspect the steps before you run anything.
      </p>
      {error && <p className="obw-activation__error" role="alert">{error}</p>}
      <button className="obw-btn obw-btn-pri" type="submit" disabled={pending || !routine.trim()}>
        {pending ? "Opening Jarvis…" : "Review request in Talk"}<ArrowRight size={15} aria-hidden="true" />
      </button>
      <button className="obw-skip" type="button" disabled={pending} onClick={() => void continueToJarvis()}>
        Explore Jarvis first
      </button>
    </form>
  );
}
