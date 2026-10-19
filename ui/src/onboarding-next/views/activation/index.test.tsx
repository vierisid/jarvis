import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ActivationIntent, ActivationViewProps, ActivationModel } from "./index";

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let View: typeof import("./index").ActivationView;
let examples: typeof import("./index").activationExamples;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
let props: ActivationViewProps;
let intents: ActivationIntent[];
let effects = 0;
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react")); ({ createRoot } = await import("react-dom/client"));
  ({ ActivationView: View, activationExamples: examples } = await import("./index"));
  globalThis.fetch = Object.assign(async () => { effects++; throw new Error("Unexpected network"); }, { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = class { constructor() { effects++; throw new Error("Unexpected socket"); } } as never;
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
afterAll(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct; GlobalRegistrator.unregister(); });
async function mount(model: Partial<ActivationModel> = {}, overrides: Partial<ActivationViewProps> = {}) {
  intents = []; effects = 0;
  props = { model: { journeyId: "j-1", revision: 1, theme: "light", availability: "ready", phase: "ready",
    draft: { prompt: "After each call, draft my follow-up.", contextRefs: [], answers: {} }, ...model },
    onDraftChange: draft => { props.model = { ...props.model, draft }; root!.render(<View {...props} />); },
    onIntent: intent => { intents.push(intent); }, ...overrides };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); await render();
}
async function render(patch: Partial<ActivationModel> = {}) { props.model = { ...props.model, ...patch }; await act(async () => root!.render(<View {...props} />)); }
function button(name: string) { const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name); if (!el) throw new Error(`Missing ${name}`); return el; }
function input() { return host.querySelector("textarea")!; }
async function click(name: string) { await act(async () => button(name).click()); }
async function key(options: KeyboardEventInit = {}) { const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options }); await act(async () => input().dispatchEvent(event)); return event; }

test("suggestions prefill editable text and focus the prompt without creating work", async () => {
  await mount();
  for (const example of examples) {
    await click(example.label); expect(input().value).toBe(example.prompt); expect(input().readOnly).toBe(false);
    expect(document.activeElement).toBe(input()); expect(button(example.label).getAttribute("aria-pressed")).toBe("true");
  }
  expect(intents).toEqual([]); expect(effects).toBe(0);
});
test("explicit create preserves raw text and explicit references, without routing to Talk or enabling work", async () => {
  const draft = { prompt: "  Use these notes.\nKeep my phrasing.  ", contextRefs: [{ kind: "memory", id: "fact-1" }], answers: { source: "Meeting notes" } };
  await mount({ draft }); await click("Create my workflow");
  expect(intents.length).toBe(1); const intent = intents[0]!; expect(intent.action).toBe("create");
  if (intent.action !== "create") throw new Error("Expected create");
  expect(intent.request).toEqual({ schemaVersion: 1, requestId: expect.any(String), intentVersion: 1, prompt: draft.prompt, contextRefs: draft.contextRefs });
  expect(intent.answers).toEqual(draft.answers); expect(input().value).toBe(draft.prompt);
  draft.contextRefs[0]!.id = "changed"; draft.answers.source = "Changed";
  expect(intent.request.contextRefs[0]!.id).toBe("fact-1"); expect(intent.answers.source).toBe("Meeting notes");
  expect(host.textContent).not.toContain("Talk"); expect(effects).toBe(0);
});
test.each([{ name: "empty", prompt: "" }, { name: "blank", prompt: " \n\t" }, { name: "overlong", prompt: "x".repeat(2001) }])("invalid local input cannot submit or be truncated: $name", async ({ prompt }) => {
  await mount({ draft: { prompt, contextRefs: [], answers: {} } }); await click("Create my workflow"); await key({ ctrlKey: true });
  expect(intents).toEqual([]); expect(input().value).toBe(prompt); expect(button("Create my workflow").getAttribute("aria-disabled")).toBe("true");
});
test("long valid input remains intact", async () => {
  const prompt = "x".repeat(2000); await mount({ draft: { prompt, contextRefs: [], answers: {} } }); await click("Create my workflow");
  expect(intents[0]?.action === "create" && intents[0].request.prompt).toBe(prompt);
});
test("clicks and keyboard submit in the same turn emit once; resolved delivery does not acknowledge a job", async () => {
  await mount({}, { onIntent: async intent => { intents.push(intent); } });
  const create = button("Create my workflow"); await act(async () => { create.click(); create.click(); input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
  await click("Explore Jarvis first"); await click("Back to the tour");
  expect(intents.length).toBe(1); expect(button("Checking your request…").getAttribute("aria-disabled")).toBe("true");
});
test("explore wins a same-turn race with create and retains the request", async () => {
  await mount(); await act(async () => { button("Explore Jarvis first").click(); button("Create my workflow").click(); });
  expect(intents).toEqual([{ journeyId: "j-1", revision: 1, from: "activation", action: "explore", to: "exited", draft: props.model.draft }]);
});
test("back and explore remain available with an absent provider, and return keeps the draft", async () => {
  await mount({ availability: "unsupported" }); await click("Create my workflow"); expect(intents).toEqual([]);
  const draft = props.model.draft; await click("Back to the tour"); expect(intents[0]?.action).toBe("back");
  await render({ revision: 2 }); await click("Explore Jarvis first"); expect(intents[1]?.action).toBe("explore"); expect(input().value).toBe(draft.prompt);
});
test("returned validation preserves the original request and allows an edited resubmission with a new identity", async () => {
  await mount(); await click("Create my workflow"); const first = intents[0]!;
  await render({ revision: 2, phase: "invalid", message: "Tell us the result you want." });
  expect(input().value).toBe(props.model.draft.prompt); expect(input().getAttribute("aria-invalid")).toBe("true");
  await click("Weekly update"); await click("Create my workflow"); const second = intents[1]!;
  if (first.action !== "create" || second.action !== "create") throw new Error("Expected requests");
  expect(second.request.requestId).not.toBe(first.request.requestId); expect(second.request.prompt).toBe(examples[1].prompt);
});
test("missing details stay in the same form and answers accompany the unchanged prompt", async () => {
  await mount({ phase: "needs_input", issues: [{ id: "notes", kind: "detail", label: "Where are the notes?", message: "Choose a source." }],
    draft: { prompt: "Draft my follow-up", contextRefs: [], answers: { notes: "My meeting notes" } } });
  expect(host.querySelector("input")?.value).toBe("My meeting notes"); await click("Create my workflow");
  const intent = intents[0]!; if (intent.action !== "create") throw new Error("Expected create");
  expect(intent.request.prompt).toBe("Draft my follow-up"); expect(intent.answers.notes).toBe("My meeting notes");
});
test("connection choice only emits the required issue and preserves text", async () => {
  await mount({ phase: "needs_input", issues: [{ id: "google", kind: "connection", label: "Google required", message: "Choose an account." }] }, { canResolveConnection: true });
  await click("Choose connection"); expect(intents[0]).toEqual({ journeyId: "j-1", revision: 1, from: "activation", action: "resolve_connection", issueId: "google", draft: props.model.draft });
  expect(effects).toBe(0);
});
test.each(["checking", "submitting", "accepted", "recovery"] as const)("%s cannot remove a reference from an in-flight request", async phase => {
  const reference = { kind: "note", id: "selected" };
  const draft = { prompt: "Draft from my notes", contextRefs: [reference], answers: { notes: "Retain these" } };
  await mount({ phase: phase === "recovery" ? "ready" : phase, draft,
    issues: [{ id: "reference-0", kind: "detail", label: "Review this selection", message: "Unavailable", reference }],
    ...(phase === "recovery" ? { pendingRequest: { request: { schemaVersion: 1, intentVersion: 1, requestId: "pending", prompt: draft.prompt, contextRefs: [reference] }, answers: draft.answers } } : {}) });
  await click("Remove selection"); expect(props.model.draft).toEqual(draft); expect(intents).toEqual([]); expect(effects).toBe(0);
});
test("a stale reference issue cannot remove a newer selection occupying the same position", async () => {
  const old = { kind: "note", id: "old" }, replacement = { kind: "note", id: "new" };
  await mount({ issues: [{ id: "reference-0", kind: "detail", label: "Review", message: "Unavailable", reference: old }],
    draft: { prompt: "Keep my request", contextRefs: [replacement], answers: { notes: "Keep my answer" } } });
  expect([...host.querySelectorAll("button")].some(b => b.textContent === "Remove selection")).toBe(false);
  await click("Create my workflow"); const intent = intents[0]!;
  if (intent.action !== "create") throw Error("Expected create");
  expect(intent.request.contextRefs).toEqual([replacement]); expect(intent.answers.notes).toBe("Keep my answer");
});
test("Create locks reference removal immediately, before React commits the pending state", async () => {
  const reference = { kind: "note", id: "selected" };
  const draft = { prompt: "Keep this request", contextRefs: [reference], answers: {} };
  await mount({ draft, issues: [{ id: "reference-0", kind: "detail", label: "Review", message: "Unavailable", reference }] });
  await act(async () => { button("Create my workflow").click(); button("Remove selection").click(); });
  expect(intents.length).toBe(1); expect(props.model.draft.contextRefs).toEqual([reference]);
});
test.each(["throw", "reject"] as const)("%s submission retries the exact identity/body and prevents unsafe edits or exit", async failure => {
  await mount({}, { onIntent: intent => { intents.push(intent); if (failure === "throw") throw new Error("secret"); return Promise.reject(new Error("secret")); } });
  await click("Create my workflow"); expect(input().readOnly).toBe(true); expect(host.textContent).not.toContain("secret");
  await click("Weekly update"); await click("Explore Jarvis first"); await click("Back to the tour"); expect(intents.length).toBe(1);
  props.onIntent = intent => { intents.push(intent); }; await render(); await click("Retry same request"); expect(intents[1]).toEqual(intents[0]);
});
test("authoritative pending request restores the same identity on remount", async () => {
  const request = { schemaVersion: 1 as const, requestId: "existing", intentVersion: 1 as const, prompt: "Original", contextRefs: [] };
  await mount({ pendingRequest: { request, answers: { notes: "source" } }, draft: { prompt: "Original", contextRefs: [], answers: { notes: "source" } } });
  await click("Retry same request"); const intent = intents[0]!; if (intent.action !== "create") throw new Error("Expected create");
  expect(intent.request).toEqual(request); expect(intent.answers).toEqual({ notes: "source" });
});
test("stale rejection cannot unlock an acknowledged or newer pending state", async () => {
  let reject!: () => void; await mount({}, { onIntent: () => new Promise<void>((_, fail) => { reject = () => fail(new Error("old")); }) }); await click("Create my workflow");
  await render({ revision: 2, phase: "accepted" }); await act(async () => reject());
  expect(host.textContent).not.toContain("couldn’t confirm"); expect(button("Checking your request…").getAttribute("aria-disabled")).toBe("true");
});
test("a different journey ignores an old failure and receives fresh entry focus", async () => {
  let reject!: () => void; await mount({}, { onIntent: () => new Promise<void>((_, fail) => { reject = () => fail(new Error("old")); }) }); await click("Create my workflow");
  await render({ journeyId: "j-2", draft: { prompt: "New journey", contextRefs: [], answers: {} } }); await act(async () => reject());
  expect(input().value).toBe("New journey"); expect(document.activeElement).toBe(input()); expect(input().readOnly).toBe(false);
});
test.each(["checking", "submitting", "accepted"] as const)("%s cannot resubmit or leave", async phase => {
  await mount({ phase }); await click("Checking your request…"); await click("Explore Jarvis first"); await key({ ctrlKey: true }); expect(intents).toEqual([]);
});
test("Enter writes lines; IME and held shortcut do not submit", async () => {
  await mount(); expect((await key()).defaultPrevented).toBe(false);
  await key({ ctrlKey: true, isComposing: true }); await key({ ctrlKey: true, keyCode: 229 }); await key({ ctrlKey: true, repeat: true }); expect(intents).toEqual([]);
  await act(async () => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await click("Create my workflow"); expect(intents).toEqual([]);
  await act(async () => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))); await key({ ctrlKey: true }); expect(intents.length).toBe(1);
});
test("theme changes retain input identity, draft and focus", async () => {
  await mount(); const field = input(); await render({ theme: "dark" }); expect(input()).toBe(field); expect(document.activeElement).toBe(field); expect(field.value).toBe(props.model.draft.prompt);
});
test("untrusted prompt and feedback render as text, not markup", async () => {
  const text = '<img src=x onerror="fetch(1)">'; await mount({ message: text, draft: { prompt: text, contextRefs: [], answers: {} } });
  expect(host.querySelector("img")).toBeNull(); expect(input().value).toBe(text); expect(effects).toBe(0);
});
test("width changes resize outside observer delivery, ignore height-only changes and cancel on unmount", async () => {
  const originalObserver = globalThis.ResizeObserver;
  const originalFrame = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let notify!: () => void;
  let scheduled: FrameRequestCallback | undefined;
  let requests = 0;
  let cancelled = 0;
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { notify = callback; }
    observe() {} unobserve() {} disconnect() { disconnected = true; }
  } as never;
  globalThis.requestAnimationFrame = callback => { scheduled = callback; return ++requests; };
  globalThis.cancelAnimationFrame = handle => { if (handle) cancelled = handle; };
  try {
    await mount(); const field = input(); const before = field.style.height;
    Object.defineProperty(field, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(field, "scrollHeight", { configurable: true, value: 210 });
    notify(); expect(field.style.height).toBe(before); expect(requests).toBe(1);
    scheduled!(0); expect(field.style.height).toBe("210px"); notify(); expect(requests).toBe(1);
    Object.defineProperty(field, "clientWidth", { configurable: true, value: 280 }); notify();
    await act(async () => root!.unmount()); root = undefined;
    expect(disconnected).toBe(true); expect(cancelled).toBe(2);
  } finally {
    globalThis.ResizeObserver = originalObserver; globalThis.requestAnimationFrame = originalFrame; globalThis.cancelAnimationFrame = originalCancel;
  }
});
