import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AnswerIntent, InterviewModel, InterviewViewProps } from "./index";

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let InterviewView: typeof import("./index").InterviewView;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
let props: InterviewViewProps;
let submitted: AnswerIntent[];
let retries: NonNullable<InterviewModel["recovery"]>[];
let navigation: string[];
const realFetch = globalThis.fetch;
const realSocket = globalThis.WebSocket;
const realAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let effects = 0;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react")); ({ createRoot } = await import("react-dom/client"));
  ({ InterviewView } = await import("./index"));
  globalThis.fetch = Object.assign(async () => { effects++; throw new Error("No UI network calls"); }, { preconnect: realFetch.preconnect });
  globalThis.WebSocket = class { constructor() { effects++; throw new Error("No UI socket"); } } as never;
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
afterAll(() => { globalThis.fetch = realFetch; globalThis.WebSocket = realSocket; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = realAct; GlobalRegistrator.unregister(); });

function model(): InterviewModel {
  return { theme: "light", sessionId: "session-1", turnId: "question-1", cursor: 1, phase: "ready",
    messages: [{ id: "question-1", role: "assistant", text: "What are you working on right now?" }],
    draft: { text: "I am building a SaaS product.", clientRequestId: "request-1" }, confirmedFactIds: [], navigation: { revision: 1, kind: "ready" } };
}
async function mount(patch: Partial<InterviewModel> = {}) {
  submitted = []; retries = []; navigation = []; effects = 0;
  props = { model: { ...model(), ...patch }, onDraftChange: text => { props.model = { ...props.model, draft: { text, clientRequestId: "edited-request" } }; },
    onSubmit: answer => submitted.push(answer), onRetry: recovery => retries.push(recovery), onSkip: () => navigation.push("skip"), onContinue: () => navigation.push("continue") };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); await render();
}
async function render(patch: Partial<InterviewModel> = {}) { props.model = { ...props.model, ...patch }; await act(async () => root!.render(<InterviewView {...props} />)); }
function button(name: string) { return Array.from(host.querySelectorAll("button")).find(el => el.textContent === name)!; }
function input() { return host.querySelector("textarea")!; }
async function click(name: string) { await act(async () => button(name).click()); }
async function key(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
  await act(async () => input().dispatchEvent(event)); return event;
}
const answer: AnswerIntent = { sessionId: "session-1", turnId: "question-1", clientRequestId: "request-1", text: "I am building a SaaS product." };

describe("ON-U-04 written interview", () => {
  test("renders only provider questions and emits a request without optimistic clearing or service effects", async () => {
    await mount(); input().focus(); const field = input(); await click("Send");
    expect(submitted).toEqual([answer]); expect(input()).toBe(field); expect(document.activeElement).toBe(field);
    expect(input().value).toBe(answer.text); expect(host.querySelector("h1")?.textContent).toBe("What are you working on right now?");
    expect(effects).toBe(0); expect(host.textContent).not.toContain("microphone"); expect(host.querySelector("audio")).toBeNull();
  });
  test("rapid click/Enter/repeat before provider acknowledgement emits one answer", async () => {
    await mount(); await act(async () => { button("Send").click(); button("Send").click(); input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await key({ repeat: true }); expect(submitted).toEqual([answer]);
    await render({ cursor: 2 }); await click("Send"); expect(submitted.length).toBe(1);
  });
  test("a new host request ID allows the next answer", async () => {
    await mount(); await click("Send"); await render({ phase: "thinking", cursor: 2 });
    await render({ phase: "ready", cursor: 3, turnId: "question-2", draft: { text: "Meeting follow-ups.", clientRequestId: "request-2" } });
    await click("Send"); expect(submitted.length).toBe(2); expect(submitted[1]?.turnId).toBe("question-2");
  });
  test.each(["connecting", "thinking", "error"] as const)("%s cannot send but keeps the unsent draft", async phase => {
    await mount({ phase }); await click("Send"); await key(); expect(submitted).toEqual([]); expect(input().value).toBe(answer.text);
  });
  test.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }])("IME and held Enter do not send: %j", async options => {
    await mount(); await key(options); expect(submitted).toEqual([]);
  });
  test("composition session blocks button sends until composition ends", async () => {
    await mount(); await act(async () => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await click("Send"); await key(); expect(submitted).toEqual([]);
    await act(async () => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await key(); expect(submitted).toEqual([answer]);
  });
  test.each([{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }])("modified Enter remains available to editing: %j", async options => {
    await mount(); const event = await key(options); expect(event.defaultPrevented).toBe(false); expect(submitted).toEqual([]);
  });
  test("ordinary Enter sends once, whitespace and missing identities never send", async () => {
    await mount(); const event = await key(); expect(event.defaultPrevented).toBe(true); expect(submitted.length).toBe(1);
    await render({ draft: { text: " \n ", clientRequestId: "empty" } }); await key();
    await render({ sessionId: null, draft: { text: "An answer", clientRequestId: "new" } }); await click("Send");
    expect(submitted.length).toBe(1);
  });
  test("failure and same-key retry preserve a newer unsent draft and the original answer", async () => {
    await mount(); await click("Send");
    await render({ phase: "error", cursor: 3, error: "Answer not confirmed.", recovery: { kind: "answer", answer }, draft: { text: "Another detail typed since.", clientRequestId: "next" } });
    input().focus(); const field = input();
    await act(async () => { button("Retry answer").click(); button("Retry answer").click(); });
    expect(retries).toEqual([{ kind: "answer", answer }]); expect(input().value).toBe("Another detail typed since.");
    expect(document.activeElement).toBe(field); expect(host.querySelector("details p")?.textContent).toBe(answer.text);
    await render({ cursor: 4, error: "Retry failed." }); await click("Retry answer"); expect(retries.length).toBe(2);
    expect(retries[1]).toEqual({ kind: "answer", answer });
  });
  test("recovery for another session/turn is not offered", async () => {
    await mount({ phase: "error", recovery: { kind: "answer", answer: { ...answer, turnId: "old-turn" } } });
    expect(button("Retry answer")).toBeUndefined(); expect(host.querySelector("details")).toBeNull();
  });
  test("reconnect is distinct from retry and does not invent a new question or clear text", async () => {
    await mount({ phase: "error", recovery: { kind: "session" }, error: "Connection lost." }); await click("Reconnect");
    expect(retries).toEqual([{ kind: "session" }]); expect(input().value).toBe(answer.text);
    await render({ phase: "ready", cursor: 2, resumed: true, recovery: undefined });
    expect(host.querySelectorAll("h1").length).toBe(1); expect(host.textContent).toContain("Resumed");
  });
  test("keyboard retry moves focus to the composer when its control disappears", async () => {
    await mount({ phase: "error", recovery: { kind: "session" } }); button("Reconnect").focus();
    await click("Reconnect"); await render({ phase: "ready", cursor: 2, recovery: undefined });
    expect(document.activeElement).toBe(input());
  });
  test("retry never steals focus after the user has moved elsewhere", async () => {
    await mount({ phase: "error", recovery: { kind: "session" } }); button("Reconnect").focus(); await click("Reconnect"); button("Skip").focus();
    await render({ phase: "ready", cursor: 2, recovery: undefined }); expect(document.activeElement).toBe(button("Skip"));
  });
  test("skip is an intent, blocked from duplicates, and requires provider confirmation", async () => {
    await mount(); button("Skip").focus();
    await act(async () => { button("Skip").click(); button("Skip").click(); button("Send").click(); });
    expect(navigation).toEqual(["skip"]); expect(submitted).toEqual([]); expect(host.querySelector("h1")?.textContent).not.toBe("Interview skipped.");
    await render({ navigation: { revision: 2, kind: "error", message: "Skip not saved." } }); await click("Skip"); expect(navigation).toEqual(["skip", "skip"]);
    await render({ phase: "skipped", navigation: { revision: 3, kind: "ready" } });
    expect(host.querySelector("h1")?.textContent).toBe("Interview skipped."); expect(input()).toBeNull(); expect(host.textContent).not.toContain("Got it.");
    expect(document.activeElement).toBe(button("Continue"));
    await click("Continue"); expect(navigation.at(-1)).toBe("continue");
  });
  test("navigation pending locks all inputs, send, retry and skip without losing focus", async () => {
    await mount({ phase: "error", recovery: { kind: "session" } }); input().focus(); const field = input();
    await render({ navigation: { revision: 2, kind: "pending", message: "Saving choice…" } });
    await click("Reconnect"); await click("Skip"); await key(); expect(retries).toEqual([]); expect(navigation).toEqual([]); expect(submitted).toEqual([]);
    expect(input().readOnly).toBe(true); expect(document.activeElement).toBe(field);
    await render({ theme: "dark", navigation: { revision: 3, kind: "error", message: "Could not save." } });
    expect(input().readOnly).toBe(false); expect(document.activeElement).toBe(field); expect(host.textContent).toContain("Could not save.");
  });
  test("counts use confirmed unique identities only and completion says Memory", async () => {
    await mount({ phase: "done", confirmedFactIds: ["work", "work", "goal", ""] });
    expect(host.querySelector("h1")?.textContent).toBe("Got it."); expect(host.textContent).toContain("2 facts in Memory");
    expect(host.textContent).not.toContain("Vault"); expect(host.textContent).not.toContain("goal created");
    await render({ confirmedFactIds: null }); expect(host.textContent).toContain("Saved context unconfirmed"); expect(host.textContent).not.toContain("0 facts");
    expect(host.textContent).not.toContain("plenty to start with");
  });
  test("streaming fragments are visible but only a completed answer is announced", async () => {
    await mount({ phase: "thinking", messages: [{ id: "reply-1", role: "assistant", text: "What work", streaming: true }] });
    const status = host.querySelector('.on-interview__sr[role="status"]')!;
    expect(status.textContent).toBe("Jarvis is preparing your reply.");
    await render({ cursor: 2, messages: [{ id: "reply-1", role: "assistant", text: "What work repeats?", streaming: true }] });
    expect(status.textContent).toBe("Jarvis is preparing your reply."); expect(host.querySelector("h1")?.textContent).toBe("What work repeats?");
    await render({ phase: "ready", cursor: 3, messages: [{ id: "reply-1", role: "assistant", text: "What work repeats?" }] });
    expect(status.textContent).toBe("What work repeats?");
    await render({ confirmedFactIds: ["new-fact"] }); expect(status.textContent).toBe("What work repeats?");
    expect(host.querySelector('[role="log"]')).toBeNull();
  });
  test("long and hostile text is escaped, not HTML, with no hidden reasoning", async () => {
    const text = "<img src=x onerror=alert(1)>" + "Long answer. ".repeat(600);
    await mount({ messages: [{ id: "u", role: "user", text }, { id: "a", role: "assistant", text: "Question?" }], draft: { text, clientRequestId: "long" } });
    expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain(text); expect(input().value).toBe(text);
    expect(host.textContent).not.toContain("reasoning"); expect(host.querySelectorAll('button:not([type="button"])').length).toBe(0);
  });
  test("a new session resets local guards without reusing previous input", async () => {
    await mount(); await click("Send"); await render({ sessionId: "session-2", draft: { text: "Other work", clientRequestId: "request-1" } });
    await click("Send"); expect(submitted.length).toBe(2); expect(submitted[1]?.sessionId).toBe("session-2"); expect(input().value).toBe("Other work");
  });
  test("a reader's anchor survives content growth and Latest question returns explicitly", async () => {
    await mount({ messages: [{ id: "user", role: "user", text: "Earlier answer" }, { id: "a", role: "assistant", text: "Question" }] });
    const stage = host.querySelector<HTMLElement>(".on-interview__stage")!;
    const row = host.querySelector<HTMLElement>('[data-reading-anchor="message:user"]')!;
    const heading = host.querySelector<HTMLElement>("h1")!;
    let rowY = 20;
    stage.getBoundingClientRect = () => ({ top: 0, bottom: 200 } as DOMRect);
    row.getBoundingClientRect = () => ({ top: rowY, bottom: rowY + 80 } as DOMRect);
    heading.getBoundingClientRect = () => ({ top: -200, bottom: -100 } as DOMRect);
    stage.scrollTop = 400;
    await act(async () => stage.dispatchEvent(new Event("scroll", { bubbles: true })));
    rowY = 65; await render({ cursor: 2, messages: [...props.model.messages] });
    expect(stage.scrollTop).toBe(445); expect(button("Latest question")).toBeDefined();
    await click("Latest question"); expect(stage.scrollTop).toBe(0); expect(button("Latest question")).toBeUndefined();
  });
  test("resizing an unchanged draft grows the composer without a height-observer loop", async () => {
    const original = globalThis.ResizeObserver;
    const originalFrame = window.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    const observations: { target?: Element; notify: () => void }[] = [];
    globalThis.ResizeObserver = class {
      record: { target?: Element; notify: () => void };
      constructor(callback: () => void) { this.record = { notify: callback }; observations.push(this.record); }
      observe(target: Element) { this.record.target = target; }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      await mount();
      const field = input();
      let width = 800;
      Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => width < 300 ? 82 : 42 });
      field.getBoundingClientRect = () => ({ width } as DOMRect);
      const observed = observations.find(item => item.target === field);
      expect(observed).toBeDefined();
      const resize = async () => { await act(async () => { observed!.notify(); frames.splice(0).forEach(callback => callback(0)); }); };
      await resize();
      expect(field.style.height).toBe("44px");
      width = 278;
      await resize();
      expect(field.style.height).toBe("82px");
      await resize();
      expect(field.style.height).toBe("82px");
      expect(field.value).toBe(answer.text);
      width = 800;
      await resize();
      expect(field.style.height).toBe("44px");
    } finally {
      globalThis.ResizeObserver = original;
      window.requestAnimationFrame = originalFrame;
    }
  });
});
