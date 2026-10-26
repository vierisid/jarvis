/**
 * #1080. An enabled workflow refused for what it is bound to says why on its
 * row in the Workflows room, and the badge opens the refused run. Driven
 * against the REAL list route, so the route's `blocked` and the hook and badge
 * that read it cannot drift apart.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../../../../../src/workflows/db";
import { createFlow } from "../../../../../src/workflows/db/repos/flow";
import { createDraftVersion } from "../../../../../src/workflows/db/repos/flow-version";
import { createFlowRun, updateRun } from "../../../../../src/workflows/db/repos/flow-run";
import { createWorkflowRoutes, type WorkflowRouteMap } from "../../../../../src/workflows/api/routes";

const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useWorkflowsData: typeof import("./useWorkflowsData").useWorkflowsData;
let FlowRow: typeof import("./WorkflowsRoom").FlowRow;
let useRunFocus: typeof import("./run-focus").useRunFocus;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let routes: WorkflowRouteMap;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useWorkflowsData } = await import("./useWorkflowsData"));
  ({ FlowRow } = await import("./WorkflowsRoom"));
  ({ useRunFocus } = await import("./run-focus"));
});

beforeEach(() => {
  initWorkflowDb(":memory:");
  routes = createWorkflowRoutes();
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.split("?")[0] !== "/api/workflows") return NativeResponse.json([]);
    return (routes["/api/workflows"]!.GET as (r: Request) => Response | Promise<Response>)(new NativeRequest(`http://localhost${url}`));
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  closeWorkflowDb();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

/** An enabled flow; `refused` gives it a live readiness refusal (Q-05 BINDING_STALE). */
function enabledFlow(refused: boolean): { flowId: string; runId?: string } {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "listed" });
  getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id]);
  if (!refused) return { flowId: flow.id };
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "FAILED", startTime: Date.now() });
  updateRun(run.id, { finishTime: Date.now(), failedStep: { name: "<readiness>", displayName: "Workflow readiness", errorMessage: "stale" },
    steps: { "<readiness>": { status: "FAILED", output: { readiness: { ready: false, issues: [
      { node: "send", path: "auth", code: "BINDING_STALE", message: "Connection account was deleted and created again" }] } } } } });
  return { flowId: flow.id, runId: run.id };
}

test("a blocked flow's row says why, and the badge opens the refused run", async () => {
  const blocked = enabledFlow(true);
  const fine = enabledFlow(false);
  const focused: Array<{ flowId: string; runId: string }> = [];
  const selected: string[] = [];
  const noop = () => undefined;
  function Probe() {
    const { flows } = useWorkflowsData();
    useRunFocus((target) => { focused.push(target); });
    return (
      <div>
        {flows.map((flow) => (
          <div key={flow.id} data-flow={flow.id}>
            <FlowRow flow={flow} selected={false} onSelect={() => selected.push(flow.id)} onEdit={noop} onRun={noop}
              onToggle={noop} onPublish={noop} onDelete={noop} />
          </div>
        ))}
      </div>
    );
  }
  await act(async () => root!.render(<Probe />));
  for (let i = 0; i < 50 && !host.querySelector(`[data-flow="${blocked.flowId}"]`); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  const row = host.querySelector(`[data-flow="${blocked.flowId}"]`)!;
  const badge = row.querySelector<HTMLElement>("[data-blocked-code]")!;
  expect(badge.getAttribute("data-blocked-code")).toBe("BINDING_STALE");
  expect(badge.textContent).toStartWith("Blocked: The workflow did not run");
  expect(badge.getAttribute("title")).toContain("did not run");
  expect(host.querySelector(`[data-flow="${fine.flowId}"] [data-blocked-code]`)).toBeNull();
  await act(async () => { badge.click(); });
  expect(focused).toEqual([{ flowId: blocked.flowId, runId: blocked.runId! }]);
  // The badge opens the run; it does not also select the row underneath.
  expect(selected).toEqual([]);
});

test("a run refused for its computer reads as the last run's outcome, not as blocked", async () => {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "listed" });
  getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id]);
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, startTime: Date.now() });
  getWorkflowDb().run(`INSERT INTO workflow_effect (id, run_id, status, record) VALUES (?, ?, 'blocked', ?)`, [`wfe_${run.id}`, run.id, JSON.stringify({
    id: `wfe_${run.id}`, runId: run.id, projectId: run.projectId, flowId: flow.id, versionId: version.id, versionDigest: "v", stepName: "send",
    executionPath: [], route: "tool", toolName: "t", actionCategory: "send_message", requestDigest: "r", arguments: {}, target: {}, provenance: {},
    decision: "allowed", reason: "", status: "blocked", approvalId: null, waitpointId: null, createdAt: Date.now(),
    outcome: { status: "blocked", code: "WORKFLOW_MACHINE_OFFLINE", effect: "not_started", message: "Bound computer mac-1 is offline" } })]);
  updateRun(run.id, { status: "FAILED", finishTime: Date.now(), failedStep: { name: "send", displayName: "Send", errorMessage: "offline" } });
  const noop = () => undefined;
  function Probe() {
    const { flows } = useWorkflowsData();
    return <div>{flows.map((f) => <FlowRow key={f.id} flow={f} selected={false} onSelect={noop} onEdit={noop} onRun={noop}
      onToggle={noop} onPublish={noop} onDelete={noop} />)}</div>;
  }
  await act(async () => root!.render(<Probe />));
  for (let i = 0; i < 50 && !host.querySelector("[data-blocked-code]"); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  const badge = host.querySelector<HTMLElement>("[data-blocked-code]")!;
  expect(badge.getAttribute("data-blocked-code")).toBe("WORKFLOW_MACHINE_OFFLINE");
  expect(badge.textContent).toStartWith("Last run refused: ");
  expect(badge.getAttribute("title")).toContain("offline");
});
