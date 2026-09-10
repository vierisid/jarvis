import { useCallback, useEffect, useRef, useState } from "react";

/** The profile interview is always written, independent of the user's normal
 * voice settings. This hook owns only its socket, transcript and completion.
 * It never requests the Pebble's microphone or plays daemon audio. */
export type InterviewMessage =
  | { role: "assistant"; text: string; ts: number }
  | { role: "user"; text: string; ts: number };

type InterviewPhase = "connecting" | "ready" | "thinking" | "done" | "error";

/** `onAnswerReturned` receives an answer whose turn failed, so the caller can
 * put it back in its composer for a retry. */
export function useInterviewSession(onAnswerReturned?: (text: string) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const phaseRef = useRef<InterviewPhase>("connecting");
  // The answer the daemon is currently replying to, if any.
  const unansweredRef = useRef<string | null>(null);
  const onAnswerReturnedRef = useRef(onAnswerReturned);
  onAnswerReturnedRef.current = onAnswerReturned;
  const [phase, setPhase] = useState<InterviewPhase>("connecting");
  const [messages, setMessages] = useState<InterviewMessage[]>([]);
  const [factsRecorded, setFactsRecorded] = useState(0);
  const [farewell, setFarewell] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changePhase = useCallback((next: InterviewPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      changePhase("thinking");
      ws.send(JSON.stringify({
        type: "interview_start",
        payload: { speakReply: false },
        timestamp: Date.now(),
      }));
    };

    ws.onmessage = (event) => {
      // Ignore binary audio and all unrelated voice messages, including ones
      // broadcast by an older daemon. They cannot change interview state.
      if (typeof event.data !== "string") return;
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      switch (msg.type) {
        case "interview_assistant": {
          if (phaseRef.current === "done") return;
          unansweredRef.current = null;
          const text = String(msg.payload?.text ?? "").trim();
          if (text) setMessages((prev) => [
            ...prev, { role: "assistant", text, ts: msg.timestamp ?? Date.now() },
          ]);
          if (typeof msg.payload?.facts_recorded === "number") {
            setFactsRecorded(msg.payload.facts_recorded);
          }
          setError(null);
          changePhase("ready");
          break;
        }
        case "interview_done":
          unansweredRef.current = null;
          setFarewell(String(msg.payload?.farewell ?? ""));
          if (typeof msg.payload?.facts_recorded === "number") {
            setFactsRecorded(msg.payload.facts_recorded);
          }
          changePhase("done");
          break;
        case "interview_error": {
          if (phaseRef.current === "done") return;
          // The daemon rolls a failed turn back, so the answer never reached
          // the interview. Drop its bubble and hand the text back for a retry.
          const unanswered = unansweredRef.current;
          unansweredRef.current = null;
          if (unanswered !== null) {
            setMessages((prev) => (prev.at(-1)?.role === "user" ? prev.slice(0, -1) : prev));
            onAnswerReturnedRef.current?.(unanswered);
          }
          setError(String(msg.payload?.message ?? "Interview failed. Please try again."));
          changePhase("error");
          break;
        }
      }
    };

    ws.onerror = ws.onclose = () => {
      if (phaseRef.current === "done") return;
      setError("Connection lost. Reload to reconnect, or skip the interview.");
      changePhase("error");
    };

    return () => {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      wsRef.current = null;
      try { ws.close(); } catch { /* already closed */ }
    };
  }, [changePhase]);

  /** Returns false without clearing the draft if a turn is already running
   * or the connection went away. The ref also prevents a rapid double-send. */
  const sendUserMessage = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    const ws = wsRef.current;
    if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return false;
    if (phaseRef.current !== "ready" && phaseRef.current !== "error") return false;
    try {
      ws.send(JSON.stringify({
        type: "interview_user_message",
        payload: { text: trimmed, speakReply: false },
        timestamp: Date.now(),
      }));
    } catch {
      setError("Your answer wasn't sent. Check the connection and try again.");
      changePhase("error");
      return false;
    }
    unansweredRef.current = trimmed;
    setMessages((prev) => [...prev, { role: "user", text: trimmed, ts: Date.now() }]);
    setError(null);
    changePhase("thinking");
    return true;
  }, [changePhase]);

  return { phase, messages, factsRecorded, farewell, error, sendUserMessage };
}
