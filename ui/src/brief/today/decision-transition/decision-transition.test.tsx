import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { confirmation, reconcileDecision, type DecisionOperation, type DecisionTransition } from "./controller";
import type { DecisionAction, DecisionBinding } from "../hero-paper/model";
import { samplePaper } from "../preview/fixtures";

GlobalRegistrator.register({ url: "http://localhost:4388/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let HeroPaper: typeof import("../hero-paper/HeroPaper").HeroPaper;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
let binding: DecisionBinding, reduced: boolean, remount: number;
let requests: Array<{ decisionId: string; revision: string; requestId: string; action: DecisionAction }>;
beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ HeroPaper } = await import("../hero-paper/HeroPaper"));
});
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  reduced = true; remount = 0; requests = [];
  const data = samplePaper("ready", false); data.decision.actions.push("reject"); data.actionLabels.reject = "Reject";
  binding = { source: "fixture", state: { status: "ready", data }, onAction: (decision, action, requestId) => {
    requests.push({ decisionId: decision.decisionId, revision: decision.revision, requestId: requestId!, action });
  } };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
async function render() { await React.act(async () => root.render(<main><HeroPaper key={remount} binding={binding} reducedMotion={reduced} /></main>)); }
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.querySelector(".brief-button__label")?.textContent === label || b.getAttribute("aria-label") === label)!;
const section = () => host.querySelector<HTMLElement>(".brief-today-decision")!;
const phase = () => section().dataset.transition;
async function click(label: string) { await React.act(async () => button(label).click()); }
async function wait(ms: number) { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
async function hover(enter: boolean) { await React.act(async () => {
  const stage = host.querySelector(".brief-today-paper-stage")!;
  stage.dispatchEvent(new PointerEvent(enter ? "pointerover" : "pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
  if (enter) stage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 101, clientY: 101 }));
}); }
const next = () => ({ status: "ready" as const, data: { ...samplePaper("invitation", false), queueCount: 1 } });
function receipt(overrides: Partial<Extract<DecisionOperation, { state: "confirmed" }>> = {}): DecisionOperation {
  const request = requests.at(-1)!;
  return { ...request, state: "confirmed", effect: request.action === "approve" ? "committed" : "not_started", ...overrides };
}
async function finish() { await wait(395); await wait(5); }

test("double press locks immediately even if the owner has not rendered its pending state", async () => {
  await render(); await hover(true);
  await React.act(async () => { button("Approve & send").click(); button("Keep draft").click(); button("Approve & send").click(); });
  await wait(10); await click("Approve & send");
  expect(requests).toHaveLength(1); expect(requests[0]?.revision).toBe("fixture-v1"); expect(requests[0]?.requestId).toBeTruthy();
  expect(phase()).toBe("pending"); expect(button("Approve & send").getAttribute("aria-disabled")).toBe("true");
});

test("confirmed receipt retains paper, summary and count until settlement, then raises only the next identity", async () => {
  await render(); await hover(true); const paper = host.querySelector("article");
  const summary = host.querySelector("h2")!.textContent;
  await click("Approve & send"); binding = { ...binding, state: next(), operation: receipt() }; await render();
  expect(phase()).toBe("confirmed"); expect(host.querySelector("article") === paper).toBe(true);
  expect(host.querySelector("h2")!.textContent).toBe(summary); expect(host.textContent).toContain("2 actions");
  expect(host.querySelector(".brief-decision-receipt")!.textContent).toBe("Execution confirmed");
  await finish(); expect(section().dataset.decisionId).toBe("fixture-decision-invitation"); expect(phase()).toBe("idle");
  expect(host.textContent).toContain("1 action"); expect(host.querySelectorAll("article").length).toBe(1);
  for (let i = 0; i < 10; i++) { await hover(true); await hover(false); }
  await click("Review invitation"); expect(host.querySelector(".brief-today-document-review")).not.toBeNull();
  await click("Keep draft"); expect(requests).toHaveLength(2); expect(requests[1]?.decisionId).toBe("fixture-decision-invitation");
});

test("draft and rejection receipts are distinct and do not claim a sent message", async () => {
  for (const action of ["keep_draft", "reject"] as const) {
    remount++; binding = { ...binding, state: { status: "ready", data: { ...samplePaper("ready", false), actionLabels: { keep_draft: "Keep draft", reject: "Reject" },
      decision: { ...samplePaper("ready", false).decision, actions: [action] } } }, operation: undefined }; await render();
    await click("Review follow-up"); await click(action === "reject" ? "Reject" : "Keep draft");
    binding = { ...binding, state: { status: "empty" }, operation: receipt() }; await render();
    expect(host.querySelector(".brief-decision-receipt")?.textContent).toBe(confirmation(action).message);
    expect(section().dataset.tone).toBe(action === "reject" ? "error" : "neutral");
    await finish(); expect(host.textContent).toContain("No decisions waiting");
  }
});

test("an appended goal never displaces the front while pending or settling", async () => {
  await render(); await click("Approve & send");
  binding = { ...binding, state: { status: "ready", data: samplePaper("queued", false) } }; await render();
  expect(section().dataset.decisionId).toBe("fixture-decision-follow-up");
  binding = { ...binding, state: next(), operation: receipt() }; await render();
  const invitation = next().data; binding = { ...binding, state: { status: "ready", data: { ...invitation, queueCount: 3 } } }; await render();
  expect(section().dataset.decisionId).toBe("fixture-decision-follow-up"); await finish();
  expect(section().dataset.decisionId).toBe("fixture-decision-invitation"); expect(host.textContent).toContain("3 actions");
});

test("next projection alone, wrong attempt, identity, revision or action cannot acknowledge this decision", async () => {
  await render(); await click("Approve & send"); binding = { ...binding, state: next() }; await render();
  expect(phase()).toBe("pending");
  for (const bad of [{ requestId: "old-attempt" }, { decisionId: "wrong" }, { revision: "old" }]) {
    binding = { ...binding, operation: receipt(bad) }; await render(); expect(phase()).toBe("pending");
  }
  binding = { ...binding, operation: receipt({ action: "keep_draft", effect: "not_started" }) }; await render();
  expect(phase()).toBe("blocked"); expect(section().dataset.decisionId).toBe("fixture-decision-follow-up");
});

test("approval without a committed effect is not completion", async () => {
  await render(); await click("Approve & send"); binding = { ...binding, state: next(), operation: receipt({ effect: "not_started" }) }; await render();
  await wait(450); expect(phase()).toBe("blocked"); expect(host.textContent).not.toContain("Execution confirmed");
});

test("errors, conflicts and unknown outcomes keep the affected paper, including when another item is supplied", async () => {
  await render(); await click("Approve & send");
  for (const state of ["error", "conflict", "unknown"] as const) {
    binding = { ...binding, state: next(), operation: { ...requests[0]!, state } }; await render();
    expect(phase()).toBe("blocked"); expect(section().dataset.decisionId).toBe("fixture-decision-follow-up");
    expect(button("Approve & send").getAttribute("aria-disabled")).toBe("true");
  }
  expect(requests).toHaveLength(1);
});

test("a refreshed conflicting version must be reviewed anew before a fresh request", async () => {
  await render(); await click("Approve & send"); binding = { ...binding, operation: { ...requests[0]!, state: "conflict" } }; await render();
  expect(phase()).toBe("blocked");
  const updated = samplePaper("ready", false); updated.decision.revision = "fixture-v2";
  binding = { ...binding, state: { status: "ready", data: updated } }; await render();
  expect(phase()).toBe("idle"); await click("Review follow-up"); await click("Approve & send");
  expect(requests).toHaveLength(2); expect(requests[1]?.revision).toBe("fixture-v2"); expect(requests[1]?.requestId).not.toBe(requests[0]?.requestId);
  binding = { ...binding, state: next(), operation: { ...receipt(), ...requests[0]! } }; await render(); expect(phase()).toBe("pending");
});

test("lost response and reloaded unresolved projection never retry or replay completion", async () => {
  binding = { ...binding, onAction: async () => { throw new Error("connection lost"); } };
  await render(); await click("Approve & send"); expect(phase()).toBe("blocked"); expect(host.textContent).toContain("response was lost");
  remount++; binding = { ...binding, state: { status: "ready", data: samplePaper("unknown", false) } }; await render();
  expect(host.textContent).toContain("Check the outcome"); expect(button("Approve & send")).toBeUndefined(); expect(phase()).toBe("idle");
});

test("a mounted historical receipt never plays a new completion", async () => {
  binding = { ...binding, operation: { state: "confirmed", decisionId: "fixture-decision-follow-up", revision: "fixture-v1", requestId: "historical", action: "approve", effect: "committed" } };
  await render(); expect(phase()).toBe("idle"); expect(button("Approve & send").disabled).toBe(true);
});

test("confirmed result waits for a fresh authoritative next projection, not a stale/failed read", async () => {
  await render(); await click("Approve & send"); binding = { ...binding, operation: receipt() }; await render(); await finish();
  expect(phase()).toBe("awaiting"); expect(host.textContent).toContain("Waiting for the refreshed decision stack");
  binding = { ...binding, state: { status: "stale", data: next().data, reason: "Old read" } }; await render(); expect(phase()).toBe("awaiting");
  binding = { ...binding, state: next() }; await render(); expect(section().dataset.decisionId).toBe("fixture-decision-invitation");
});

test("canonical failed or unknown outcome overrides even a conflicting optimistic receipt", () => {
  const paper = samplePaper("ready", false);
  const current: DecisionTransition = { paper, action: "approve", requestId: "a", phase: "pending", message: "Pending", tone: "attention" };
  for (const executionOutcome of ["failed", "unknown", "blocked"] as const) {
    const data = samplePaper("unknown", false); data.decision.approval!.executionOutcome = executionOutcome;
    const view: DecisionBinding = { source: "fixture", state: { status: "ready", data }, operation: { state: "confirmed", decisionId: paper.decision.decisionId,
      revision: paper.decision.revision, requestId: "a", action: "approve", effect: "committed" } };
    expect(reconcileDecision(current, view).phase).toBe("blocked");
  }
});

test("a failure received during settlement cancels advancement", async () => {
  await render(); await click("Approve & send"); binding = { ...binding, state: next(), operation: receipt() }; await render();
  expect(phase()).toBe("confirmed");
  binding = { ...binding, operation: { ...requests[0]!, state: "error", message: "Execution failed" } }; await render();
  await wait(450); expect(phase()).toBe("blocked"); expect(section().dataset.decisionId).toBe("fixture-decision-follow-up");
});

test("keyboard focus follows the next Review path without stealing focus from another control", async () => {
  await render(); await hover(true); await React.act(async () => button("Approve & send").focus());
  await click("Approve & send"); expect(document.activeElement === button("Approve & send")).toBe(true);
  binding = { ...binding, state: next(), operation: receipt() }; await render(); await finish();
  expect(document.activeElement === button("Review invitation")).toBe(true);
  await click("Review invitation"); await React.act(async () => button("Keep draft").focus()); await click("Keep draft");
  const external = document.createElement("button"); document.body.append(external); await React.act(async () => external.focus());
  binding = { ...binding, state: { status: "empty" }, operation: receipt() }; await render(); await finish();
  expect(document.activeElement === external).toBe(true); external.remove();
});

test("resolving an expanded review restores its pre-review scroll position for the next paper", async () => {
  await render(); await click("Review follow-up");
  const main = host.querySelector("main")!; main.scrollTop = 349;
  await click("Reject"); binding = { ...binding, state: next(), operation: receipt() }; await render(); await finish();
  expect(main.scrollTop).toBe(0); expect(section().dataset.decisionId).toBe("fixture-decision-invitation");
});

test("unmount cancels presentation timers and late callback failures cannot affect a new paper", async () => {
  let reject!: (error: Error) => void;
  binding = { ...binding, onAction: () => new Promise<void>((_, fail) => { reject = fail; }) };
  await render(); await click("Approve & send"); remount++; binding = { ...binding, state: next() }; await render();
  await React.act(async () => reject(new Error("late response")));
  expect(section().dataset.decisionId).toBe("fixture-decision-invitation"); expect(phase()).toBe("idle");
});

test("capability loss clears a retained document and cannot expose an old writer", async () => {
  await render(); await click("Approve & send");
  binding = { source: "fixture", state: { status: "unavailable", reason: "Decisions unavailable" } }; await render();
  expect(host.querySelector("article")).toBeNull(); expect(button("Approve & send")).toBeUndefined();
  expect(host.textContent).toContain("Decisions unavailable");
});
