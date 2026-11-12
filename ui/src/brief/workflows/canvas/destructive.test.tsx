import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { makeCanvasFixture } from "./fixtures";
import type { WorkflowCanvasBinding } from "./WorkflowCanvasRoom";
import type { BriefShellPort } from "../../contracts";
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let Environment: typeof import("../../../v2/rooms/workflows/WorkflowEditorEnvironment").WorkflowEditorEnvironment;
let hook: typeof import("../../../v2/rooms/workflows/useWorkflowEditor").useWorkflowEditor;
let host: HTMLDivElement, root: Root, editor: ReturnType<typeof hook>, fixture: ReturnType<typeof makeCanvasFixture>;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowEditorEnvironment: Environment } = await import("../../../v2/rooms/workflows/WorkflowEditorEnvironment"));
  ({ useWorkflowEditor: hook } = await import("../../../v2/rooms/workflows/useWorkflowEditor"));
});
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); fixture = makeCanvasFixture(true); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
const caps = { contractVersion: 1, capabilities: { workflowContext: { supported: true, ready: true, enabled: true, state: "ready", reason: null } } };
const shell = { mode: "live", route: { room: "workflow-draft", selection: { flowId: "meeting" } }, navigate() {} } as unknown as BriefShellPort;
const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.querySelector(".brief-button__label")?.textContent === name)!;
const feedback = () => host.querySelector(".brief-canvas-feedback")?.textContent ?? "";
const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });

async function room(binding: Partial<WorkflowCanvasBinding>) {
  const { WorkflowCanvasRoom } = await import("./WorkflowCanvasRoom");
  await React.act(async () => root.render(<div className="brief-root"><WorkflowCanvasRoom shell={shell} binding={{
    source: "live", scopeId: "s", flowId: "meeting", versionId: fixture.versionId, capabilities: caps, request: fixture.request, ...binding,
  }} /></div>));
  await settle();
}

test("removing a router branch can be undone, and brings its steps back", async () => {
  function Harness() { editor = hook("meeting"); return null; }
  await React.act(async () => root.render(<Environment.Provider value={{ request: fixture.request, portalHost: null, workspace: true }}><Harness /></Environment.Provider>));
  const before = JSON.stringify(editor.draftTrigger);
  expect(before).toContain('"nested"');
  await React.act(async () => { editor.removeRouterBranch("router", 0); });
  expect(JSON.stringify(editor.draftTrigger)).not.toContain('"nested"');
  expect(editor.canUndo).toBe(true);
  await React.act(async () => { editor.undo(); });
  expect(JSON.stringify(editor.draftTrigger)).toBe(before);
});

test("a refused publish says which step is wrong in plain words", async () => {
  fixture = makeCanvasFixture(false);
  const refusal = Object.assign(new Error("Request unavailable (422)"), { status: 422, body: { error: "step_x (settings.input.mapping.h): ...", code: "WORKFLOW_NOT_READY",
    issues: [{ node: "draft", path: "settings.input.payload", code: "REFERENCE_SCOPE", message: 'Reference "step_1" is missing, later in the graph, or outside this branch/loop scope' }] } });
  await room({ publish: async () => { throw refusal; }, edit: undefined });
  await React.act(async () => button("Publish version").click());
  await settle();
  expect(feedback()).toContain("Publishing stopped.");
  expect(feedback()).toContain('"Draft the follow-up" uses the result of a step that was deleted or does not run before it (step_1)');
  expect(feedback()).not.toContain("could not be confirmed");
  // An answer with no readable body keeps the old advice to reopen.
  await room({ publish: async () => { throw new Error("Request unavailable (500)"); } });
  await React.act(async () => button("Publish version").click());
  await settle();
  expect(feedback()).toContain("could not be confirmed");
  // A server failure's own text is internal, not a reason a person can act on.
  await room({ publish: async () => { throw Object.assign(new Error("Request unavailable (500)"), { status: 500, body: { error: "SQLITE_BUSY: database is locked" } }); } });
  await React.act(async () => button("Publish version").click());
  await settle();
  expect(feedback()).toContain("could not be confirmed");
  expect(feedback()).not.toContain("SQLITE");
});

test("a draft that cannot run says why next to the button, and the server's readiness issues are listed", async () => {
  fixture = makeCanvasFixture(false);
  const request: WorkflowCanvasBinding["request"] = async (input, init) => String(input).endsWith("/readiness")
    ? Response.json({ ready: false, issues: [{ node: "draft", path: "settings.input.payload", code: "REFERENCE_SCOPE", message: 'Reference "step_1" is missing, later in the graph, or outside this branch/loop scope' }], runtimeChecks: [] })
    : fixture.request(input, init);
  await room({ request, publish: async () => {} });
  expect(button("Run workflow").disabled).toBe(true);
  expect(host.querySelector(".brief-canvas-run-reason")?.textContent).toBe("This draft cannot be published yet. See what to fix below.");
  expect(button("Run workflow").getAttribute("aria-describedby")).toBe("brief-run-reason");
  const list = [...host.querySelectorAll(".brief-canvas-setup")].find(e => e.textContent?.includes("Not ready to publish"))!;
  expect(list.textContent).toContain('"Draft the follow-up" uses the result of a step that was deleted');
  // With no known problem the reason is the plain next step.
  await room({ publish: async () => {} });
  expect(host.querySelector(".brief-canvas-run-reason")?.textContent).toBe("Publish this draft to run it.");
});
