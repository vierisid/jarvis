import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let useInterviewSession: typeof import("./useInterviewSession").useInterviewSession;
let OnboardingWizard: typeof import("./OnboardingWizard").OnboardingWizard;
let session: ReturnType<typeof useInterviewSession>;
let root: ReturnType<typeof createRoot> | null;
let host: HTMLElement;
const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
const realAudioContext = globalThis.AudioContext;
let audioOpened = 0;

class InterviewSocket {
  static OPEN = 1;
  static latest: InterviewSocket;
  readyState = 1;
  sent: Array<{ type: string; payload?: Record<string, unknown>; timestamp: number }> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  failSend = false;
  constructor(_url: string) { InterviewSocket.latest = this; }
  send(raw: string) {
    if (this.failSend) throw new Error("disconnected during send");
    this.sent.push(JSON.parse(raw));
  }
  receive(type: string, payload: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useInterviewSession } = await import("./useInterviewSession"));
  ({ OnboardingWizard } = await import("./OnboardingWizard"));
});

beforeEach(() => {
  globalThis.WebSocket = InterviewSocket as never;
  audioOpened = 0;
  globalThis.AudioContext = class { constructor() { audioOpened++; } } as never;
  globalThis.fetch = (async () => Response.json({ hosted_llm: true })) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  root = null;
});

afterAll(() => {
  globalThis.WebSocket = realWebSocket;
  globalThis.AudioContext = realAudioContext;
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

function Harness() { session = useInterviewSession(); return null; }
async function mountHook() {
  await act(async () => root!.render(<Harness />));
  const socket = InterviewSocket.latest;
  await act(async () => socket.onopen?.());
  return socket;
}

async function mountInterview() {
  const status = {
    setup_completed: true, setup_completed_at: 1,
    setup_skipped_profile: false, profile_completed: false,
    tutorial_completed: false, tutorial_completed_at: null,
    tutorial_dismissed: false, tutorial_progress_step: null, last_reset_at: null,
  };
  await act(async () => root!.render(<OnboardingWizard status={status} onComplete={() => {}} />));
  const socket = InterviewSocket.latest;
  await act(async () => socket.onopen?.());
  return socket;
}

async function typeAnswer(value: string) {
  const textarea = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

describe("written interview session", () => {
  test("requests written replies and never listens to or plays legacy voice messages", async () => {
    const socket = await mountHook();
    expect(socket.sent).toEqual([{ type: "interview_start", payload: { speakReply: false }, timestamp: expect.any(Number) }]);
    await act(async () => {
      socket.receive("interview_assistant", { text: "What are you building?", will_speak: true });
      socket.receive("tts_start");
      socket.onmessage?.({ data: new ArrayBuffer(12) });
      socket.receive("tts_end");
      socket.receive("interview_listen_state", { armed: true });
      socket.receive("interview_user_transcript", { text: "An unrelated voice message" });
    });
    expect(session.phase).toBe("ready");
    expect(session.messages.map((m) => m.text)).toEqual(["What are you building?"]);
    expect(audioOpened).toBe(0);
    expect(socket.sent.map((m) => m.type)).toEqual(["interview_start"]);
    await act(async () => { expect(session.sendUserMessage("  A small company  ")).toBe(true); });
    expect(socket.sent[1]?.payload).toEqual({ text: "A small company", speakReply: false });
    expect(session.phase).toBe("thinking");
  });

  test("prevents rapid duplicate replies and preserves rejected answers for retry", async () => {
    const socket = await mountHook();
    await act(async () => socket.receive("interview_assistant", { text: "What repeats?" }));
    await act(async () => {
      expect(session.sendUserMessage("Weekly reporting")).toBe(true);
      expect(session.sendUserMessage("Weekly reporting")).toBe(false);
    });
    expect(socket.sent.filter((m) => m.type === "interview_user_message")).toHaveLength(1);
    await act(async () => socket.receive("interview_error", { message: "Please try again." }));
    socket.failSend = true;
    await act(async () => { expect(session.sendUserMessage("Review before sharing")).toBe(false); });
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(session.error).toContain("wasn't sent");
    socket.failSend = false;
    await act(async () => { expect(session.sendUserMessage("Review before sharing")).toBe(true); });
    expect(session.error).toBeNull();
  });

  test("completion stays complete when audio, stale replies or socket close arrive", async () => {
    const socket = await mountHook();
    await act(async () => {
      socket.receive("interview_done", { farewell: "Ready when you are.", facts_recorded: 3 });
      socket.receive("interview_assistant", { text: "A stale reply" });
      socket.receive("interview_error", { message: "A stale error" });
      socket.receive("tts_end");
      socket.close();
    });
    expect(session.phase).toBe("done");
    expect(session.farewell).toBe("Ready when you are.");
    expect(session.factsRecorded).toBe(3);
    expect(session.messages).toHaveLength(0);
    expect(session.error).toBeNull();
  });

  test("reports disconnected sessions and detaches all socket handlers on unmount", async () => {
    const socket = await mountHook();
    await act(async () => socket.close());
    expect(session.phase).toBe("error");
    expect(session.error).toContain("Reload to reconnect");
    expect(session.sendUserMessage("An answer")).toBe(false);
    await act(async () => root!.unmount());
    root = null;
    expect([socket.onopen, socket.onmessage, socket.onerror, socket.onclose]).toEqual([null, null, null, null]);
  });
});

describe("written interview UI", () => {
  test("offers written answers and keeps Skip available without requesting a microphone", async () => {
    const socket = await mountInterview();
    await act(async () => {
      socket.receive("interview_assistant", { text: "What are you building?", will_speak: true });
    });
    expect(host.querySelector('textarea[aria-label="Your written answer"]')).not.toBeNull();
    expect(host.textContent).toContain("A few written answers");
    expect(host.textContent).not.toMatch(/Listening|just talk|voice mode|text only/i);
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent === "Skip")).toBe(true);
    expect(socket.sent.map((m) => m.type)).toEqual(["interview_start"]);
    expect(audioOpened).toBe(0);
  });

  test("retains a typed answer if sending fails and displays it once sent", async () => {
    const socket = await mountInterview();
    await act(async () => socket.receive("interview_assistant", { text: "What repeats?" }));
    const textarea = await typeAnswer("Weekly company updates");
    const send = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Send")!;
    expect(send.disabled).toBe(false);
    socket.failSend = true;
    await act(async () => send.click());
    expect(textarea.value).toBe("Weekly company updates");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("wasn't sent");
    socket.failSend = false;
    await act(async () => send.click());
    expect(textarea.value).toBe("");
    expect(host.querySelector(".obw-bub.me")?.textContent).toBe("Weekly company updates");
    expect(send.disabled).toBe(true);
  });

  test("Enter never submits during composition, with Shift, or while a reply is pending", async () => {
    const socket = await mountInterview();
    const textarea = await typeAnswer("An answer in progress");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(textarea.value).toBe("An answer in progress");
    expect(socket.sent).toHaveLength(1);
    await act(async () => socket.receive("interview_assistant", { text: "What matters this week?" }));
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    });
    expect(socket.sent).toHaveLength(1);
    expect(textarea.value).toBe("An answer in progress");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(socket.sent[1]?.payload).toEqual({ text: "An answer in progress", speakReply: false });
    expect(textarea.value).toBe("");
  });
});
