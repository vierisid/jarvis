/**
 * #652. `GET /api/workflows/:id/runs` changed from a bare array to
 * `{ items, nextOffset }`, and its two dashboard consumers changed with it.
 * This drives both hooks against the REAL route handler, so the hooks and the
 * route cannot drift apart again without this failing: a hook still reading an
 * array gets an object, and shows no runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { closeWorkflowDb, initWorkflowDb } from "../../../../../src/workflows/db";
import { createFlow } from "../../../../../src/workflows/db/repos/flow";
import { createDraftVersion } from "../../../../../src/workflows/db/repos/flow-version";
import { createFlowRun } from "../../../../../src/workflows/db/repos/flow-run";
import { createWorkflowRoutes, type WorkflowRouteMap } from "../../../../../src/workflows/api/routes";

const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useFlowRuns: typeof import("./useFlowRuns").useFlowRuns;
let useWorkflowsData: typeof import("./useWorkflowsData").useWorkflowsData;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let routes: WorkflowRouteMap;
let flowId: string;
let runIds: string[];

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useFlowRuns } = await import("./useFlowRuns"));
  ({ useWorkflowsData } = await import("./useWorkflowsData"));
});

beforeEach(() => {
  initWorkflowDb(":memory:");
  routes = createWorkflowRoutes();
  const flow = createFlow();
  const version = createDraftVersion({
    flowId: flow.id, displayName: "listed",
    trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
  });
  runIds = [0, 1, 2].map((i) =>
    createFlowRun({ flowId: flow.id, flowVersionId: version.id, triggeredBy: `run_${i}`, status: "SUCCEEDED" }).id);
  flowId = flow.id;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    const match = /^\/api\/workflows\/([^/]+)\/runs$/u.exec(path);
    if (!match) return NativeResponse.json([]);
    const request = Object.assign(new NativeRequest(`http://localhost${url}`), { params: { id: match[1]! } });
    const handler = routes["/api/workflows/:id/runs"]!.GET as (r: Request) => Response | Promise<Response>;
    return handler(request);
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

/** Shown ids, in the order the hook holds them. */
const shown = () => host.querySelector("[data-runs]")!.getAttribute("data-runs")!.split(",").filter(Boolean);

/** Wait for the hook to land its first page, rather than for one fixed tick. */
async function settled(): Promise<void> {
  for (let i = 0; i < 50 && shown().length === 0; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

test("useFlowRuns shows the route's page, newest first", async () => {
  function Probe() {
    const { runs } = useFlowRuns(flowId);
    return <div data-runs={runs.map((run) => run.id).join(",")} />;
  }
  await act(async () => root!.render(<Probe />));
  await settled();
  expect(shown()).toEqual([...runIds].reverse());
});

test("useWorkflowsData shows the route's page for the selected flow", async () => {
  function Probe() {
    // Selecting a flow is what loads its runs (`refreshRuns` in an effect).
    const { selectedRuns, setSelectedFlowId } = useWorkflowsData();
    return (
      <div data-runs={selectedRuns.map((run) => run.id).join(",")}>
        <button type="button" onClick={() => setSelectedFlowId(flowId)}>select</button>
      </div>
    );
  }
  await act(async () => root!.render(<Probe />));
  await act(async () => { host.querySelector("button")!.click(); });
  await settled();
  expect(shown()).toEqual([...runIds].reverse());
});
