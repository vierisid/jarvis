import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { makeCanvasFixture } from "./fixtures";
import type { WorkflowCanvasBinding } from "./WorkflowCanvasRoom";
import type { BriefShellPort } from "../../contracts";
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let host: HTMLDivElement, root: Root, fixture: ReturnType<typeof makeCanvasFixture>;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "https://jarvis.test/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
});
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); fixture = makeCanvasFixture(false); sessionStorage.clear(); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
const caps = { contractVersion: 1, capabilities: { workflowContext: { supported: true, ready: true, enabled: true, state: "ready", reason: null } } };
const navigated: unknown[] = [];
const shell = { mode: "live", route: { room: "workflow-draft", selection: { flowId: "meeting" } }, navigate: (route: unknown) => { navigated.push(route); } } as unknown as BriefShellPort;
const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.querySelector(".brief-button__label")?.textContent === name)!;
const feedback = () => host.querySelector(".brief-canvas-feedback")?.textContent ?? "";
const settle = (ms = 30) => React.act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function open(binding: Partial<WorkflowCanvasBinding> = {}) {
  const { WorkflowCanvasRoom } = await import("./WorkflowCanvasRoom");
  await React.act(async () => root.render(<div className="brief-root"><WorkflowCanvasRoom shell={shell} binding={{
    source: "live", scopeId: "s", flowId: "meeting", versionId: fixture.versionId, capabilities: caps, request: fixture.request, ...binding,
  }} /></div>));
  await settle();
}
async function typeIntoStep(name: string, value: string) {
  await React.act(async () => (host.querySelector(`.react-flow__node[data-id="${name}"]`) as HTMLElement | null)?.click());
  const field = host.querySelector('[aria-label="Step settings"] [contenteditable]') as HTMLElement;
  await React.act(async () => { field.textContent = value; field.dispatchEvent(new Event("input", { bubbles: true })); });
}
const offline: WorkflowCanvasBinding["request"] = async (input, init) => {
  if ((init?.method ?? "GET") !== "GET") throw new TypeError("Failed to fetch");
  return fixture.request(input, init);
};

test("an offline save says so, keeps the edits and keeps the Unsaved changes label", async () => {
  await open({ request: offline });
  await typeIntoStep("notes", "edited while offline");
  expect(feedback()).toBe("Unsaved changes");
  await React.act(async () => button("Save changes").click());
  await settle();
  expect(feedback()).toContain("You are offline, so this was not saved. Your edits are still here");
  expect(feedback()).toContain("Unsaved changes");
  expect(feedback()).not.toContain("Failed to fetch");
  expect(button("Save changes").disabled).toBe(false);
});

test("a workflow deleted in another tab is said in words, with a way out that discards the edits", async () => {
  const gone: WorkflowCanvasBinding["request"] = async (input, init) => (init?.method ?? "GET") === "PATCH"
    ? Response.json({ error: "workflow_removed", code: "workflow_removed" }, { status: 409 }) : fixture.request(input, init);
  await open({ request: gone });
  await typeIntoStep("notes", "edit after delete");
  await React.act(async () => button("Save changes").click());
  await settle();
  expect(host.textContent).not.toContain("workflow_removed");
  expect(host.querySelector(".brief-canvas-removed")?.textContent).toContain("This workflow was deleted in another tab or window.");
  expect(button("Save changes").disabled).toBe(true);
  await React.act(async () => button("Discard edits and go to All workflows").click());
  await settle(80);
  expect(navigated.at(-1)).toEqual({ room: "all-workflows", selection: {} });
});

test("unsaved edits are copied into the tab and come back after a reload", async () => {
  await open();
  await typeIntoStep("notes", "my careful edit");
  await settle(300);
  const keys = Object.keys(sessionStorage).filter(k => k.startsWith("jarvis:brief:workflow-edits:v1:s:meeting:"));
  expect(keys).toHaveLength(1);
  expect(sessionStorage.getItem(keys[0]!)).toContain("my careful edit");
  // The page is reloaded: a new room opens the same saved draft.
  await React.act(async () => root.render(null));
  fixture = makeCanvasFixture(false);
  await open();
  expect(feedback()).toContain("Restored your unsaved edits");
  expect(feedback()).toContain("Unsaved changes");
  expect(button("Save changes").disabled).toBe(false);
  // Saving, or discarding, drops the copy.
  await React.act(async () => button("Save changes").click());
  await settle();
  expect(sessionStorage.getItem(keys[0]!)).toBeNull();
  expect(JSON.stringify(fixture.snapshot().version.trigger)).toContain("my careful edit");
});

test("a copy made from an older revision of the draft is not put back over a newer one", async () => {
  await open();
  await typeIntoStep("notes", "stale edit");
  await settle(300);
  await React.act(async () => root.render(null));
  fixture = makeCanvasFixture(false);
  await fixture.request(`/api/workflows/meeting/versions/${fixture.versionId}`, { method: "PATCH", body: JSON.stringify({ displayName: "Changed elsewhere", trigger: fixture.snapshot().version.trigger, uiMeta: fixture.snapshot().uiMeta }) });
  await open();
  expect(feedback()).toContain("were not restored: this draft changed since");
  expect(JSON.stringify(fixture.snapshot().version.trigger)).not.toContain("stale edit");
  // The copy can never apply again, so it is gone.
  expect(Object.keys(sessionStorage).filter(k => k.startsWith("jarvis:brief:workflow-edits:"))).toEqual([]);
});

test("a credential saved in a step is never copied into the tab, and survives the restore and save", async () => {
  const { version, uiMeta } = fixture.snapshot();
  (version.trigger as any).nextAction.settings.input.headers = { Authorization: "Bearer saved-credential" };
  await fixture.request(`/api/workflows/meeting/versions/${fixture.versionId}`, { method: "PATCH", body: JSON.stringify({ displayName: version.displayName, trigger: version.trigger, uiMeta }) });
  await open();
  await typeIntoStep("notes", "edit beside a credential");
  await settle(300);
  const keys = Object.keys(sessionStorage).filter(k => k.startsWith("jarvis:brief:workflow-edits:v1:s:meeting:"));
  expect(keys).toHaveLength(1);
  const copy = sessionStorage.getItem(keys[0]!)!;
  expect(copy).toContain("edit beside a credential");
  expect(copy).not.toContain("saved-credential");
  await React.act(async () => root.render(null));
  await open();
  expect(feedback()).toContain("Restored your unsaved edits");
  expect(feedback()).not.toContain("Enter again");
  await React.act(async () => button("Save changes").click());
  await settle();
  const savedTrigger = JSON.stringify(fixture.snapshot().version.trigger);
  expect(savedTrigger).toContain("edit beside a credential");
  expect(savedTrigger).toContain("Bearer saved-credential");
});
