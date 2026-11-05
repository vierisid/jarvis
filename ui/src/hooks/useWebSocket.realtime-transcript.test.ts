import { describe, expect, test } from "bun:test";
import { appendRealtimeTranscript, type ChatMessage } from "./useWebSocket.ts";

const shown = (m: ChatMessage[]) => m.map((x) => `${x.role}:${x.content}`);

describe("#1156: realtime transcripts in conversation order", () => {
  test("a user line that lands after the reply to it goes back before that reply", () => {
    let thread: ChatMessage[] = [];
    thread = appendRealtimeTranscript(thread, { role: "assistant", text: "Sure, opening it.", final: true, replyTo: "u1" }, 2, "a1");
    thread = appendRealtimeTranscript(thread, { role: "user", text: "Open settings", final: true, itemId: "u1" }, 3, "q1");
    expect(shown(thread)).toEqual(["user:Open settings", "assistant:Sure, opening it."]);
  });

  test("it goes before the first reply to it, after earlier turns", () => {
    let thread: ChatMessage[] = [];
    thread = appendRealtimeTranscript(thread, { role: "user", text: "Hi", final: true, itemId: "u0" }, 1, "q0");
    thread = appendRealtimeTranscript(thread, { role: "assistant", text: "Hello.", final: true, replyTo: "u0" }, 2, "a0");
    thread = appendRealtimeTranscript(thread, { role: "assistant", text: "Checking.", final: true, replyTo: "u1" }, 3, "a1");
    thread = appendRealtimeTranscript(thread, { role: "assistant", text: "Done.", final: true, replyTo: "u1" }, 4, "a2");
    thread = appendRealtimeTranscript(thread, { role: "user", text: "Check mail", final: true, itemId: "u1" }, 5, "q1");
    expect(shown(thread)).toEqual(["user:Hi", "assistant:Hello.", "user:Check mail", "assistant:Checking.", "assistant:Done."]);
  });

  test("a user line no reply names yet is appended", () => {
    const thread = appendRealtimeTranscript([], { role: "user", text: "Hello", final: true, itemId: "u9" }, 1, "q");
    expect(shown(thread)).toEqual(["user:Hello"]);
  });

  test("partials and empty text are not shown", () => {
    expect(appendRealtimeTranscript([], { role: "assistant", text: "Sur", final: false }, 1, "x")).toEqual([]);
    expect(appendRealtimeTranscript([], { role: "user", text: "", final: true }, 1, "x")).toEqual([]);
  });
});
