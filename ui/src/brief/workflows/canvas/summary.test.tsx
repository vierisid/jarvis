import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { makeCanvasFixture } from "./fixtures";
import type { BriefShellPort } from "../../contracts";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

test("the workflow page opens with a plain-English summary of what the workflow does, and no 'Programmed' label", async () => {
  const { WorkflowCanvasRoom } = await import("./WorkflowCanvasRoom");
  const fixture = makeCanvasFixture(true);
  const shell = { mode: "preview", route: { room: "workflow", selection: { flowId: "meeting" } }, navigate: () => {} } as unknown as BriefShellPort;
  const caps = { contractVersion: 1, capabilities: { workflowContext: { supported: true, ready: true, enabled: true, state: "ready", reason: null } } };
  await React.act(async () => root.render(
    <div className="brief-root">
      <WorkflowCanvasRoom shell={shell} binding={{ source: "fixture", scopeId: "canvas-test", flowId: "meeting", versionId: fixture.versionId, capabilities: caps, request: fixture.request }} />
    </div>));
  await React.act(async () => new Promise((r) => setTimeout(r, 50)));
  const summary = host.querySelector('[data-testid="workflow-summary"]')!;
  expect(summary).not.toBeNull();
  expect(summary.textContent).toStartWith("When you run it, then read meeting notes, then draft the follow-up, then ");
  expect(summary.textContent).toContain("if interested is true");
  expect(summary.textContent).toContain("; otherwise ");
  expect(summary.textContent).toContain("for each item");
  expect(host.textContent).not.toContain("Programmed");
});
