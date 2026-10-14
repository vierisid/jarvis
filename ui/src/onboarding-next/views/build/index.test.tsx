import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { acceptStatus, type BuildStatus, verifiedReference, type DraftReference } from "./state";
import type { BuildModel, BuildIntent, BuildViewProps } from "./index";

const working: BuildStatus = { jobId: "job-1", revision: 1, outcome: "working", phase: "understanding" };
const reference: DraftReference = { jobId: "job-1", requestId: "request-1", compositionRecordId: "composition-1", flowId: "flow-1", versionId: "version-1", readiness: "ready", activation: "disabled" };
const success: BuildStatus = { ...working, revision: 3, outcome: "succeeded", completedPhases: ["understanding", "building", "validating", "saving"] };

test("status accepts higher revisions of the scoped job only and copies collections", () => {
  const initial = acceptStatus(null, working, "job-1")!;
  for (const incoming of [{ ...working, revision: 0 }, { ...working, phase: "building" as const }, { ...working, revision: 2, jobId: "other" },
    { ...working, revision: NaN }, { ...working, revision: 2, outcome: "unknown" } as never, { ...working, revision: 2, phase: "unknown" } as never]) {
    expect(acceptStatus(initial, incoming, "job-1")).toBe(initial);
  }
  const phases: BuildStatus["completedPhases"] = ["understanding"];
  const next = acceptStatus(initial, { ...working, revision: 2, phase: "building", completedPhases: phases }, "job-1")!;
  phases.push("saving"); expect(next.completedPhases).toEqual(["understanding"]);
});
test.each(["succeeded", "failed", "cancelled"] as const)("terminal %s cannot regress to another outcome", outcome => {
  const terminal = { ...working, revision: 3, outcome };
  expect(acceptStatus(terminal, { ...working, revision: 4 }, "job-1")).toBe(terminal);
  expect(acceptStatus(terminal, { ...terminal, revision: 4 }, "job-1")?.revision).toBe(4);
});
test("a result requires matching identities, disabled activation and a durable version", () => {
  expect(verifiedReference(reference, "job-1", "request-1")).toBe(true);
  for (const patch of [{ jobId: "other" }, { requestId: "other" }, { flowId: "" }, { versionId: " " }, { compositionRecordId: "" }, { activation: "enabled" }, { readiness: "unknown" }]) {
    expect(verifiedReference({ ...reference, ...patch } as DraftReference, "job-1", "request-1")).toBe(false);
  }
});

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let View: typeof import("./index").BuildView;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
let props: BuildViewProps;
let intents: BuildIntent[];
let effects = 0;
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
beforeAll(async () => {
  GlobalRegistrator.register(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react")); ({ createRoot } = await import("react-dom/client")); ({ BuildView: View } = await import("./index"));
  globalThis.fetch = Object.assign(async () => { effects++; throw new Error("Unexpected network"); }, { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = class { constructor() { effects++; throw new Error("Unexpected socket"); } } as never;
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
afterAll(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct; GlobalRegistrator.unregister(); });
async function mount(patch: Partial<BuildModel> = {}, overrides: Partial<BuildViewProps> = {}) {
  intents = []; effects = 0;
  props = { model: { journeyId: "journey-1", jobId: "job-1", requestId: "request-1", revision: 1, title: "Meeting follow-ups",
    prompt: "  After a call, draft a follow-up.\nAsk before sending.  ", theme: "light", availability: "ready",
    transport: "connected", cancellation: "not_requested", status: working,
    actions: { cancel: true, resume: true, retry: true, provide_input: true, explore: true, openResult: true }, ...patch },
    onIntent: intent => { intents.push(intent); }, ...overrides };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); await render();
}
async function render(patch: Partial<BuildModel> = {}) { props.model = { ...props.model, ...patch }; await act(async () => root!.render(<View {...props} />)); }
function button(text: string) { const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith(text)); if (!b) throw new Error("Missing " + text); return b; }
async function click(text: string) { await act(async () => button(text).click()); }

test("phase updates require provider events, don't infer completed phases or issue effects", async () => {
  await mount(); expect(host.querySelector('[data-active="true"]')?.textContent).toContain("Understanding");
  for (let i = 0; i < 10; i++) await render();
  expect(host.querySelectorAll('[data-state="complete"]').length).toBe(0); expect(intents).toEqual([]);
  await render({ status: { ...working, revision: 2, phase: "validating", completedPhases: ["understanding"] } });
  expect(host.querySelectorAll('[data-state="complete"]').length).toBe(1);
  expect(host.querySelector('[data-active="true"]')?.textContent).toContain("Checking");
  expect(effects).toBe(0); expect(host.textContent).not.toContain("%");
});
test("no events, unknown job and stale revisions never invent progress or success", async () => {
  await mount({ status: undefined }); expect(host.textContent).toContain("Waiting for the first build update");
  await render({ status: { ...working, jobId: "other" } }); expect(host.querySelector('[aria-current="step"]')).toBeNull();
  await render({ status: { ...working, revision: 5, phase: "saving" } });
  await render({ status: { ...working, revision: 2 } }); expect(host.querySelector('[aria-current="step"]')?.textContent).toContain("Saving");
  expect(intents).toEqual([]);
});
test("queued does not claim that work has begun", async () => {
  await mount({ status: { jobId: "job-1", revision: 1, outcome: "queued" } });
  expect(host.textContent).toContain("queued"); expect(host.querySelector('[data-active="true"]')).toBeNull();
});
test("a cancellation waits for acknowledgement, locks rapid clicks and ignores phase updates", async () => {
  await mount(); await act(async () => { button("Cancel build").click(); button("Cancel build").click(); });
  expect(intents.length).toBe(1); expect(intents[0]?.action).toBe("cancel");
  expect(host.textContent).toContain("Waiting for confirmation"); expect(host.textContent).not.toContain("was cancelled");
  await render({ status: { ...working, revision: 2, phase: "building" } }); await click("Cancellation requested"); expect(intents.length).toBe(1);
  await render({ revision: 2, cancellation: "requested" }); expect(host.textContent).not.toContain("was cancelled");
  await render({ revision: 3, cancellation: "acknowledged", status: { ...working, revision: 3, outcome: "cancelled" } });
  expect(host.textContent).toContain("was cancelled");
});
test("cancel acknowledgement alone is not a cancelled outcome", async () => {
  await mount({ cancellation: "acknowledged" }); expect(host.textContent).toContain("Waiting for confirmation");
  expect(host.textContent).not.toContain("was cancelled");
});
test.each([{ transport: "disconnected" as const }, { timedOut: true }])("uncertain transport cannot retry the build: %j", async patch => {
  await mount(patch); expect(host.textContent).not.toContain("Retry build"); expect(host.querySelector('[data-active="true"]')).toBeNull();
  await click("Cancel build"); expect(intents).toEqual([]); await click("Check status"); expect(intents[0]?.action).toBe("resume");
});
test("confirmed failure/timeout can request a retry retaining original identity", async () => {
  await mount({ timedOut: true, status: { ...working, outcome: "failed", safeError: "Time limit reached" } });
  expect(host.textContent).toContain("The build timed out"); await click("Retry build");
  expect(intents[0]).toMatchObject({ action: "retry", jobId: "job-1", requestId: "request-1", statusRevision: 1 });
});
test("missing details keep the request accessible without sending or modifying it", async () => {
  await mount({ status: { ...working, outcome: "needs_input", missingInputs: ["Where are the notes?"] } });
  await click("View your request"); expect(host.querySelector(".on-build__request p")?.textContent).toBe(props.model.prompt);
  await click("Add missing details"); expect(intents[0]?.action).toBe("provide_input"); expect(effects).toBe(0);
});
test.each(["pending", "unavailable"] as const)("succeeded with %s result does not open a fake canvas", async state => {
  await mount({ status: success, result: { state } });
  expect(intents).toEqual([]); expect(host.textContent).toContain("Finishing your workflow");
});
test("mismatched result never opens, matching saved result opens once without a timer", async () => {
  await mount({ status: success, result: { state: "ready", reference: { ...reference, jobId: "other" } } });
  expect(intents).toEqual([]);
  await render({ result: { state: "ready", reference } });
  expect(intents.length).toBe(1); expect(intents[0]).toMatchObject({ action: "open_result", result: reference });
  for (let i = 0; i < 10; i++) await render({ theme: i % 2 ? "dark" : "light", status: { ...working, revision: 0 } });
  expect(intents.length).toBe(1); expect(host.textContent).toContain("Opening your workflow");
});
test("pending cancellation cannot erase a draft that finished first", async () => {
  await mount(); await click("Cancel build");
  await render({ status: success, result: { state: "ready", reference } });
  expect(intents.map(i => i.action)).toEqual(["cancel", "open_result"]);
});
test("a saved draft on a cancelled job is explicit recovery, never automatic success", async () => {
  await mount({ status: { ...working, outcome: "cancelled" }, result: { state: "ready", reference } });
  expect(intents).toEqual([]); expect(host.textContent).toContain("before the build stopped");
  await click("Open saved draft"); expect(intents[0]?.action).toBe("open_result");
});
test("an open failure retries navigation to the same saved version, never creation", async () => {
  await mount({ status: success, result: { state: "ready", reference } }, { onIntent: intent => { intents.push(intent); throw new Error("private"); } });
  expect(host.textContent).not.toContain("private"); expect(button("Try opening again")).toBeTruthy();
  props.onIntent = intent => { intents.push(intent); }; await render(); await click("Try opening again");
  expect(intents[1]).toEqual(intents[0]); expect(intents.every(i => i.action === "open_result")).toBe(true);
});
test("unknown command delivery requires reconciliation; repeated checks reuse identity", async () => {
  await mount({}, { onIntent: intent => { intents.push(intent); return Promise.reject(new Error("private")); } });
  await click("Cancel build"); await click("Cancellation requested"); expect(intents.length).toBe(1);
  await click("Check status"); await click("Check status"); expect(intents.length).toBe(3); expect(intents[2]).toEqual(intents[1]);
  expect(host.textContent).not.toContain("private");
});
test("a late command rejection cannot overwrite newer authoritative acknowledgement", async () => {
  let reject!: () => void;
  await mount({}, { onIntent: () => new Promise<void>((_, fail) => { reject = () => fail(new Error("old")); }) });
  await click("Cancel build"); await render({ revision: 2, cancellation: "requested" }); await act(async () => reject());
  expect(host.textContent).not.toContain("couldn’t confirm"); expect(host.textContent).toContain("Waiting for confirmation");
});
test("new job scope ignores prior navigation failure and starts fresh", async () => {
  let reject!: () => void;
  await mount({ status: success, result: { state: "ready", reference } }, { onIntent: () => new Promise<void>((_, fail) => { reject = () => fail(new Error("old")); }) });
  await render({ jobId: "job-2", result: undefined, status: { ...working, jobId: "job-2" } }); await act(async () => reject());
  expect(host.textContent).not.toContain("couldn’t open"); expect(host.textContent).toContain("Building your first workflow");
});
test("missing capability and unavailable provider fail closed", async () => {
  await mount({ availability: "unsupported", status: success, result: { state: "ready", reference } });
  expect(intents).toEqual([]); await click("Explore Jarvis"); expect(intents).toEqual([]);
  await render({ availability: "ready", actions: {} }); expect(intents).toEqual([]);
});
test("request expansion, theme and reduced motion preserve focus and text", async () => {
  await mount(); await click("View your request"); const control = button("Hide your request"); control.focus();
  props.reducedMotion = true; await render({ theme: "dark", status: { ...working, revision: 2, phase: "building" } });
  expect(document.activeElement).toBe(control); expect(control.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[data-reduced-motion="true"]')).not.toBeNull(); expect(host.querySelector(".on-build__request p")?.textContent).toBe(props.model.prompt);
});
test("untrusted visible commentary and requests remain plain text", async () => {
  const text = '<img src=x onerror="fetch(1)">';
  await mount({ title: text, prompt: text, status: { ...working, outcome: "failed", safeError: text } });
  await click("View your request"); expect(host.querySelector("img")).toBeNull(); expect(effects).toBe(0);
});

test("removing the focused cancel control moves focus to recovery without stealing request focus", async () => {
  await mount(); button("Cancel build").focus();
  await render({ status: { ...working, revision: 2, outcome: "cancelled" } });
  expect(document.activeElement).toBe(button("Retry build"));
  button("View your request").focus();
  await render({ status: { ...working, revision: 3, outcome: "cancelled" }, theme: "dark" });
  expect(document.activeElement).toBe(button("View your request"));
});
test("withdrawn result ignores old navigation rejection and allows only the newly verified version", async () => {
  let reject!: () => void;
  await mount({ status: success, result: { state: "ready", reference } }, { onIntent: intent => {
    intents.push(intent); return new Promise<void>((_, fail) => { reject = () => fail(new Error("old")); });
  } });
  await render({ result: { state: "unavailable" } }); await act(async () => reject());
  expect(host.textContent).not.toContain("couldn’t open"); expect(host.textContent).not.toContain("Opening your workflow");
  props.onIntent = intent => { intents.push(intent); };
  await render({ result: { state: "ready", reference: { ...reference, versionId: "version-2" } } });
  expect(intents.length).toBe(2); expect(intents[1]?.action === "open_result" && intents[1].result.versionId).toBe("version-2");
});

test("a hanging cancel can be reconciled and its late failure cannot unlock the status check", async () => {
  let rejectCancel!: () => void;
  await mount({}, { onIntent: intent => {
    intents.push(intent);
    return new Promise<void>((_, fail) => { if (intent.action === "cancel") rejectCancel = () => fail(new Error("late")); });
  } });
  await click("Cancel build"); await click("Check status");
  expect(intents.map(i => i.action)).toEqual(["cancel", "resume"]);
  await act(async () => rejectCancel());
  expect(host.textContent).not.toContain("couldn’t confirm");
  expect(button("Checking status").getAttribute("aria-disabled")).toBe("true");
  expect(host.textContent).toContain("Waiting for confirmation");
});
