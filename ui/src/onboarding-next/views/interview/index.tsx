import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../../v2/ui/Button";
import "./interview.css";

export interface InterviewMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Partial text is visible but never announced token by token. */
  streaming?: boolean;
}
export interface AnswerIntent {
  sessionId: string;
  turnId: string;
  clientRequestId: string;
  text: string;
}
export interface InterviewModel {
  theme: "light" | "dark";
  sessionId: string | null;
  turnId: string | null;
  /** Provider event cursor, including a fresh revision after each failed retry. */
  cursor: number;
  phase: "connecting" | "ready" | "thinking" | "error" | "done" | "skipped";
  resumed?: boolean;
  messages: readonly InterviewMessage[];
  /** Host retains drafts, allocates request IDs and clears only acknowledged text. */
  draft: { text: string; clientRequestId: string };
  confirmedFactIds: readonly string[] | null;
  error?: string;
  recovery?: { kind: "session" } | { kind: "answer"; answer: AnswerIntent };
  /** Must describe saved context only, not configured goals or permissions. */
  farewell?: string;
  navigation: { revision: number; kind: "ready" | "pending" | "error"; message?: string };
}
export interface InterviewViewProps {
  model: InterviewModel;
  onDraftChange: (text: string) => void;
  onSubmit: (answer: AnswerIntent) => void;
  onRetry: (recovery: NonNullable<InterviewModel["recovery"]>) => void;
  onSkip: () => void;
  onContinue: () => void;
}

const PHASE_LABEL = {
  connecting: "Connecting", ready: "Your turn", thinking: "Preparing your reply",
  error: "Needs attention", done: "Complete", skipped: "Skipped",
} as const;

/** Provider-owned conversation, local input/scroll feedback only. No service effects. */
export function InterviewView(props: InterviewViewProps) {
  return <InterviewPanel key={props.model.sessionId ?? "not-connected"} {...props} />;
}

function InterviewPanel({ model, onDraftChange, onSubmit, onRetry, onSkip, onContinue }: InterviewViewProps) {
  const headingId = useId();
  const inputId = useId();
  const helpId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sentRef = useRef<string | null>(null);
  const retryRef = useRef<string | null>(null);
  const navRef = useRef<string | null>(null);
  const retryFocus = useRef(false);
  const skipFocus = useRef(false);
  const continueRef = useRef<HTMLDivElement>(null);
  const [sentKey, setSentKey] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const [navKey, setNavKey] = useState<string | null>(null);
  const reading = useRef(false);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const [hasNewReply, setHasNewReply] = useState(false);
  const terminal = model.phase === "done" || model.phase === "skipped";
  const navigationKey = JSON.stringify([model.sessionId, model.navigation.revision]);
  const locked = model.navigation.kind === "pending" || navKey === navigationKey;
  const requestKey = JSON.stringify([model.sessionId, model.draft.clientRequestId]);
  const recoveryKey = JSON.stringify([model.sessionId, model.cursor, model.recovery]);
  const latest = model.messages.findLast(message => message.role === "assistant");
  const history = model.messages.filter(message => message !== latest);
  const confirmedCount = model.confirmedFactIds === null ? null
    : new Set(model.confirmedFactIds.filter(id => id.trim())).size;
  const factCopy = confirmedCount === null ? "Saved context unconfirmed"
    : `${confirmedCount} ${confirmedCount === 1 ? "fact" : "facts"} in Memory`;
  const canSend = !locked && model.phase === "ready" && !latest?.streaming
    && !!model.sessionId && !!model.turnId && !!model.draft.clientRequestId.trim()
    && !!model.draft.text.trim() && sentKey !== requestKey;
  const recoveryValid = model.recovery?.kind === "session" || (model.recovery?.kind === "answer"
    && model.recovery.answer.sessionId === model.sessionId && model.recovery.answer.turnId === model.turnId);
  const canRetry = !locked && model.phase === "error" && recoveryValid && retryKey !== recoveryKey;

  // Readable transcript is not a live region. Announce completed replies once,
  // not every streaming fragment, cursor update or confirmed fact increment.
  const completed = model.messages.findLast(message => message.role === "assistant" && !message.streaming);
  const announcement = terminal ? (model.phase === "done" ? `Interview complete. ${factCopy}.` : `Interview skipped. ${factCopy}.`)
    : model.phase === "thinking" || latest?.streaming ? "Jarvis is preparing your reply."
    : model.phase === "connecting" ? "Connecting to the interview."
    : model.phase === "ready" ? `${model.resumed ? "Interview resumed. " : ""}${completed?.text ?? "Ready for your answer."}` : "";

  const captureAnchor = () => {
    const box = stageRef.current;
    if (!box) return;
    reading.current = box.scrollTop > 24;
    const top = box.getBoundingClientRect().top;
    const node = Array.from(box.querySelectorAll<HTMLElement>("[data-reading-anchor]"))
      .find(el => el.getBoundingClientRect().bottom > top + 1);
    anchor.current = node ? { id: node.dataset.readingAnchor!, offset: node.getBoundingClientRect().top - top } : null;
    if (!reading.current) setHasNewReply(false);
  };
  const restoreAnchor = () => {
    const box = stageRef.current;
    if (!box) return;
    if (!reading.current) { box.scrollTop = 0; return; }
    const previous = anchor.current;
    if (!previous) return;
    const node = Array.from(box.querySelectorAll<HTMLElement>("[data-reading-anchor]"))
      .find(el => el.dataset.readingAnchor === previous.id);
    if (node) box.scrollTop += node.getBoundingClientRect().top - box.getBoundingClientRect().top - previous.offset;
  };
  useLayoutEffect(() => {
    restoreAnchor();
    if (reading.current) setHasNewReply(true);
  }, [model.cursor, model.messages]);
  useLayoutEffect(() => {
    const box = stageRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(restoreAnchor);
    observer.observe(box);
    return () => observer.disconnect();
  }, [terminal]);
  const resizeComposer = () => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    const border = input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.max(44, Math.min(input.scrollHeight + border, 132))}px`;
  };
  useLayoutEffect(resizeComposer, [model.draft.text, terminal]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === "undefined") return;
    let width = input.getBoundingClientRect().width;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth === width) return; // Height changes must not form a resize loop.
      width = nextWidth;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      // Changing observed geometry inside delivery causes browser loop warnings.
      frame = window.requestAnimationFrame(() => { frame = undefined; resizeComposer(); });
    });
    observer.observe(input);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [terminal]);
  useLayoutEffect(() => {
    if (retryFocus.current && model.phase !== "error") {
      if (document.activeElement === document.body) {
        if (terminal) continueRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
        else inputRef.current?.focus({ preventScroll: true });
      }
      retryFocus.current = false;
    }
    if (skipFocus.current && terminal) {
      if (document.activeElement === document.body) continueRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      skipFocus.current = false;
    }
  }, [model.phase, terminal]);

  const submit = () => {
    if (!canSend || composing.current || navRef.current === navigationKey || sentRef.current === requestKey) return;
    sentRef.current = requestKey; setSentKey(requestKey);
    onSubmit({ sessionId: model.sessionId!, turnId: model.turnId!, clientRequestId: model.draft.clientRequestId, text: model.draft.text });
  };
  const retry = () => {
    if (!canRetry || !model.recovery || navRef.current === navigationKey || retryRef.current === recoveryKey) return;
    retryFocus.current = document.activeElement?.classList.contains("on-interview__retry") ?? false;
    retryRef.current = recoveryKey; setRetryKey(recoveryKey);
    onRetry(model.recovery);
  };
  const navigate = (action: () => void) => {
    if (locked || navRef.current === navigationKey) return;
    navRef.current = navigationKey; setNavKey(navigationKey); action();
  };

  return (
    <section className="on-interview" data-theme={model.theme} data-phase={model.phase} data-context={confirmedCount !== null && confirmedCount > 0} aria-labelledby={headingId}>
      <div className="on-interview__layout">
        {!terminal && <header className="on-interview__header">
          <p>Jarvis · your work, in your words</p>
          <span className="on-interview__facts">{factCopy}</span>
          <Button className="on-interview__control on-interview__skip" aria-disabled={locked} onClick={() => {
            skipFocus.current = document.activeElement?.classList.contains("on-interview__skip") ?? false;
            navigate(onSkip);
          }}>Skip</Button>
        </header>}
        <div className="on-interview__stage" ref={stageRef} onScroll={captureAnchor} tabIndex={0} role="region" aria-label="Interview conversation">
          <div className="on-interview__stage-content">
            <div className="on-interview__pebble" aria-hidden="true"><span /></div>
            {!terminal && <p className="on-interview__phase">{PHASE_LABEL[model.phase]}{model.resumed && <span> · Resumed</span>}</p>}
            <h1 id={headingId} data-reading-anchor={latest ? `message:${latest.id}` : "question"}>
              {model.phase === "done" ? "Got it." : model.phase === "skipped" ? "Interview skipped."
                : latest?.text || (model.phase === "connecting" ? "Getting ready to chat…" : "Your interview will appear here.")}
            </h1>
            <p className="on-interview__help">{terminal
              ? model.phase === "skipped" ? "You can tell Jarvis more about your work anytime."
                : model.farewell?.trim() || (confirmedCount ? "I have plenty to start with. Welcome to Jarvis." : "You’re ready to explore Jarvis.")
              : "A few written answers about what you’re building, what repeats, and where you want help."}</p>
            {terminal ? <>
              <p className="on-interview__facts on-interview__saved">{factCopy}</p>
              <div ref={continueRef}><Button variant="primary" className="on-interview__control on-interview__continue" aria-disabled={locked} onClick={() => navigate(onContinue)}>Continue</Button></div>
            </> : <div className="on-interview__history">
              {history.map(message => <p key={message.id} data-reading-anchor={`message:${message.id}`}
                className={`on-interview__message on-interview__message--${message.role}`}>
                <span className="on-interview__sr">{message.role === "user" ? "You: " : "Jarvis: "}</span>{message.text}
              </p>)}
            </div>}
          </div>
        </div>
        {!terminal && <div className="on-interview__footer">
          <div className="on-interview__feedback">
            <p role="alert">{model.phase === "error" ? model.error?.trim() || "The interview could not continue. Your draft is still here." : ""}</p>
            {model.phase === "error" && recoveryValid && model.recovery?.kind === "answer" && <details className="on-interview__unconfirmed">
              <summary>Answer awaiting confirmation</summary><p>{model.recovery.answer.text}</p>
            </details>}
            {model.phase === "error" && recoveryValid && <Button className="on-interview__control on-interview__retry" aria-disabled={!canRetry} onClick={retry}>
              {model.recovery?.kind === "answer" ? "Retry answer" : "Reconnect"}
            </Button>}
            {hasNewReply && <Button className="on-interview__control on-interview__latest" onClick={() => {
              reading.current = false; anchor.current = null; setHasNewReply(false);
              if (stageRef.current) stageRef.current.scrollTop = 0;
            }}>Latest question</Button>}
          </div>
          <div className="on-interview__composer">
            <label className="on-interview__sr" htmlFor={inputId}>Your written answer</label>
            <textarea id={inputId} ref={inputRef} rows={1} value={model.draft.text} placeholder="Type your answer"
              readOnly={locked} aria-describedby={helpId} onChange={event => onDraftChange(event.target.value)}
              onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={event => {
                if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
                  || event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                if (!event.repeat) submit();
              }} />
            <Button variant="primary" className="on-interview__control on-interview__send" aria-disabled={!canSend} onClick={submit}>Send</Button>
          </div>
          <p className="on-interview__input-help" id={helpId}>Enter to send · Shift + Enter for a new line</p>
        </div>}
        <div className="on-interview__navigation">
          <p role="status">{model.navigation.kind === "pending" ? model.navigation.message || "Saving your choice…" : ""}</p>
          <p role="alert">{model.navigation.kind === "error" ? model.navigation.message || "Could not continue. Try again." : ""}</p>
        </div>
        <p className="on-interview__sr" role="status" aria-atomic="true">{announcement}</p>
      </div>
    </section>
  );
}
