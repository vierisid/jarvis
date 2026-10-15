import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../../styles/globals.css";
import "../../../../v2/ui/primitives.css";
import { InterviewView, type InterviewModel, type AnswerIntent } from "../index";
import "./preview.css";

// Representative existing themes, not a production questionnaire or model reply.
const questions = [
  "I'd like to understand what you're building and where repetition gets in the way. What are you working on right now?",
  "What work do you find yourself repeating each week?",
  "Which tools do you use for that routine?",
  "Which parts need your judgment or approval?",
];
function initial(): InterviewModel {
  return { theme: "light", sessionId: "example-session", turnId: "question-1", cursor: 1, phase: "ready",
    messages: [{ id: "question-1", role: "assistant", text: questions[0]! }],
    draft: { text: "", clientRequestId: "example-request-1" }, confirmedFactIds: [], navigation: { revision: 1, kind: "ready" } };
}
function Preview() {
  const [model, setModel] = useState<InterviewModel>(initial);
  const [scenario, setScenario] = useState("ready");
  const [fail, setFail] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [reduced, setReduced] = useState(false);
  const [intents, setIntents] = useState<string[]>([]);
  const counter = useRef(1);
  const pending = useRef<AnswerIntent | null>(null);
  const question = useRef(0);
  const record = (value: string) => setIntents(items => [...items, value]);
  const configure = (value: string) => {
    setScenario(value); pending.current = null; question.current = 0;
    const next = { ...initial(), theme: model.theme, cursor: ++counter.current,
      sessionId: `example-session-${counter.current}`, navigation: { revision: counter.current, kind: "ready" as const } };
    if (value === "connecting") { next.phase = "connecting"; next.messages = []; next.turnId = null; }
    if (value === "resumed" || value === "long") {
      next.resumed = true; next.confirmedFactIds = ["work", "goal"];
      next.messages = [{ id: "user-1", role: "user", text: "I'm building a SaaS product. I want to win ten design partners." },
        { id: "question-2", role: "assistant", text: questions[1]! }]; next.turnId = "question-2";
      if (value === "long") next.messages = [...Array.from({ length: 12 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? "user" as const : "assistant" as const,
        text: (i % 2 ? "I collect meeting notes, prepare the next steps and check the pilot dates. " : "Which part of your follow-up needs your judgment? ").repeat(6) })), ...next.messages];
    }
    if (value === "error") { next.phase = "error"; next.error = "Connection lost. Reconnect to continue."; next.recovery = { kind: "session" }; next.draft.text = "Keep this draft while I reconnect."; }
    if (value === "saving-error") { next.phase = "error"; next.error = "Your latest context could not be saved. Reconnect to retry saving."; next.recovery = { kind: "session" }; next.confirmedFactIds = ["work"]; }
    if (value === "thinking") next.phase = "thinking";
    if (value === "streaming") { next.phase = "thinking"; next.messages = [{ id: "stream-1", role: "assistant", text: "What work do you", streaming: true }]; }
    if (value === "done") { next.phase = "done"; next.confirmedFactIds = ["work", "goal", "routine", "tools", "scope", "rhythm"]; }
    if (value === "skipped") next.phase = "skipped";
    if (value === "unknown") { next.phase = "done"; next.confirmedFactIds = null; }
    setModel(next);
  };
  const accept = (answer: AnswerIntent) => {
    record(`Submit ${answer.clientRequestId}`); pending.current = answer;
    setModel(current => ({ ...current, cursor: ++counter.current, phase: fail ? "error" : "thinking",
      error: fail ? "Your answer could not be confirmed. Retry it here." : undefined,
      recovery: fail ? { kind: "answer", answer } : undefined,
      messages: current.messages.some(message => message.id === answer.clientRequestId) ? current.messages
        : [...current.messages, { id: answer.clientRequestId, role: "user", text: answer.text }] }));
  };
  const returnReply = () => {
    record("Illustrative reply"); question.current = Math.min(questions.length - 1, question.current + 1);
    const id = `reply-${++counter.current}`;
    setModel(current => ({ ...current, phase: "ready", cursor: counter.current, turnId: id, recovery: undefined, error: undefined,
      messages: [...current.messages.filter(message => !message.streaming), { id, role: "assistant", text: questions[question.current]! }],
      confirmedFactIds: [...(current.confirmedFactIds ?? []), `fact-${id}`],
      draft: current.draft.text === pending.current?.text ? { text: "", clientRequestId: `request-${counter.current}` } : current.draft }));
    pending.current = null;
  };
  return <div className="interview-preview" data-reduced={reduced} style={{ zoom, width: `${100 / zoom}vw`, height: `${100 / zoom}dvh` }}>
    <aside className="interview-preview-tools" aria-label="Preview controls">
      <strong>ON-U-04 · Preview only</strong>
      <label>Theme <select value={model.theme} onChange={e => setModel(current => ({ ...current, theme: e.target.value as "light" | "dark" }))}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label>Scenario <select value={scenario} onChange={e => configure(e.target.value)}>{["ready", "connecting", "thinking", "streaming", "resumed", "error", "saving-error", "long", "done", "skipped", "unknown"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} /> Fail next answer</label>
      <button type="button" onClick={returnReply}>Return reply</button>
      <button type="button" onClick={() => setModel(current => ({ ...current, cursor: ++counter.current, messages: current.messages.map(message => message.streaming ? { ...message, text: message.text + " find yourself repeating" } : message) }))}>Stream fragment</button>
      <label>Navigation <select value={model.navigation.kind} onChange={e => setModel(current => ({ ...current, navigation: { revision: ++counter.current, kind: e.target.value as InterviewModel["navigation"]["kind"], message: e.target.value === "error" ? "Your choice was not saved. Try again." : "Saving your choice…" } }))}><option>ready</option><option>pending</option><option>error</option></select></label>
      <label>Preview zoom <select value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value="1">100%</option><option value="2">200%</option></select></label>
      <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> No motion</label>
      <output aria-live="polite">{intents.length} intents · {intents.at(-1) ?? "None"}</output>
    </aside>
    <main><InterviewView model={model}
      onDraftChange={text => setModel(current => ({ ...current, draft: { text, clientRequestId: `request-${++counter.current}` } }))}
      onSubmit={accept} onRetry={recovery => {
        record(recovery.kind === "answer" ? `Retry ${recovery.answer.clientRequestId}` : "Reconnect");
        if (recovery.kind === "answer") pending.current = recovery.answer;
        setModel(current => ({ ...current, phase: recovery.kind === "answer" ? "thinking" : "ready", cursor: ++counter.current, resumed: recovery.kind === "session" || current.resumed, error: undefined, recovery: undefined }));
      }} onSkip={() => { record("Skip"); setModel(current => ({ ...current, phase: "skipped", cursor: ++counter.current, navigation: { revision: counter.current, kind: "ready" } })); }}
      onContinue={() => { record("Continue"); setModel(current => ({ ...current, navigation: { revision: ++counter.current, kind: "pending", message: "Next: the room tour. Preview ends here." } })); }} /></main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
