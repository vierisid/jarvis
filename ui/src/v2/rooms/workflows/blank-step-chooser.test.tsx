import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { makeCanvasFixture } from "../../../brief/workflows/canvas/fixtures";

// #1419: in the legacy editor a blank step is reachable from the keyboard.
// Enter opens the chooser, Escape leaves the step as it was with focus back on
// it, and choosing Router turns the step into a Router in place.
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let Env: typeof import("./WorkflowEditorEnvironment").WorkflowEditorEnvironment;
let WorkflowEditor: typeof import("./WorkflowEditor").WorkflowEditor;
let host: HTMLDivElement;
let root: Root;
let fixture: ReturnType<typeof makeCanvasFixture>;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowEditorEnvironment: Env } = await import("./WorkflowEditorEnvironment"));
  ({ WorkflowEditor } = await import("./WorkflowEditor"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture = makeCanvasFixture(false);
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const frames = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.setTimeout(resolve, 0))));
const node = (id: string) => host.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
const chooser = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Add piece"]');
const key = async (target: Element, k: string) => {
  await React.act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  await React.act(async () => { await frames(); });
};

async function mountWithBlank(displayName = "New step") {
  const version = fixture.snapshot().version;
  const notes = version.trigger.nextAction!;
  notes.nextAction = { name: "blank", type: "PIECE", displayName, settings: { input: {} }, nextAction: notes.nextAction };
  await fixture.request(`/api/workflows/meeting/versions/${fixture.versionId}`, { method: "PATCH", body: JSON.stringify({ trigger: version.trigger }) });
  await React.act(async () => root.render(
    <Env.Provider value={{ request: fixture.request, portalHost: null, workspace: false }}>
      <WorkflowEditor flowId="meeting" onClose={() => {}} />
    </Env.Provider>,
  ));
  await React.act(async () => { await frames(); });
  expect(node("blank")).not.toBeNull();
}

test("Enter on a blank step opens the chooser; Escape closes it and puts focus back on the step", async () => {
  await mountWithBlank();
  const blank = node("blank")!;
  blank.focus();
  await key(blank, "Enter");
  const dialog = chooser();
  expect(dialog).not.toBeNull();
  // Focus is in the chooser's search field, not left behind on the canvas.
  expect(dialog!.contains(document.activeElement)).toBe(true);
  await key(document.activeElement!, "Escape");
  expect(chooser()).toBeNull();
  expect(document.activeElement).toBe(node("blank"));
  expect(node("blank")!.textContent).not.toContain("Router");
});

test("choosing Router from the keyboard replaces the blank step in place and keeps focus on it", async () => {
  await mountWithBlank("Check stock");
  const before = host.querySelectorAll(".react-flow__node").length;
  node("blank")!.focus();
  await key(node("blank")!, "Enter");
  const search = chooser()!.querySelector<HTMLInputElement>("input")!;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Router");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const active = chooser()!.querySelector('[role="option"][aria-selected="true"]');
  expect(active?.textContent).toContain("Router");
  await key(search, "Enter");
  expect(chooser()).toBeNull();
  // Same node, same place: no loose Router next to a still-blank step.
  expect(host.querySelectorAll(".react-flow__node").length).toBe(before);
  expect(document.activeElement).toBe(node("blank"));
  // The name the person gave the placeholder is kept.
  expect(node("blank")!.textContent).toContain("Check stock");
});
