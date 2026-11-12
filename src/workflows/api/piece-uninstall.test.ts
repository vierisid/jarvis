import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { createFlow, updateFlowStatus } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { publishFlowVersion } from "../db/repos/flow-publication";
import { configureWorkflowReadiness } from "../db/repos/flow-readiness";
import { writeManifest } from "../pieces-library/installer";
import { PieceCatalog } from "../runtime/piece-catalog";
import { CredentialResolver } from "../credentials/adapter";
import { projectFailure } from "../../failures/projection";
import { plainActionName, plainPieceName } from "../pieces-library/plain-piece-name";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { enqueue } from "../db/repos/job-queue";
import { Worker } from "../queue/worker";
import { createRunFlowHandler, RUN_FLOW } from "../runner/handler";
import { runFailure } from "../runtime/run-failure";
import { getFlow } from "../db/repos/flow";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

const PACKAGE = "@activepieces/piece-discord";
const PIECE_ENTRY = { name: PACKAGE, displayName: "Discord", description: "", actions: { send_message: { name: "send_message", displayName: "Send message", description: "" } } };
const installed = new PieceCatalog([PIECE_ENTRY] as never);

let routes: WorkflowRouteMap;
let dir: string;
let prevDir: string | undefined;

beforeEach(async () => {
  initWorkflowDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "jarvis-uninstall-"));
  prevDir = process.env.JARVIS_PIECES_DIR;
  process.env.JARVIS_PIECES_DIR = dir;
  await writeManifest({ version: 1, pieces: [{ id: "discord", npmPackage: PACKAGE, versionRange: "^0.1.0", resolvedVersion: "0.1.0", installedAt: 1 }] }, dir);
  configureWorkflowReadiness({ pieces: installed, credentials: new CredentialResolver(), tool: () => null, machines: () => [], localTools: () => true });
  routes = createWorkflowRoutes({ sharedPiecesDir: null });
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.JARVIS_PIECES_DIR;
  else process.env.JARVIS_PIECES_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
  closeWorkflowDb();
});

function enabledFlow(name: string, projectId?: string) {
  const flow = createFlow(projectId ? { projectId } : {});
  createDraftVersion({ flowId: flow.id, displayName: name, trigger: { name: "trigger", type: "EMPTY", nextAction: { name: "post_it", displayName: "Post it", type: "PIECE",
    settings: { pieceName: PACKAGE, actionName: "send_message", input: {} } } } as never });
  publishFlowVersion(flow.id);
  updateFlowStatus(flow.id, "ENABLED");
  return flow.id;
}

const call = async (route: string, method: "GET" | "DELETE", params: Record<string, string> = {}) => {
  const req = Object.assign(new Request("http://x/", { method }), { params });
  const res = await (routes[route] as Record<string, (r: Request) => Promise<Response>>)[method]!(req);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("uninstalling a piece says who loses it", () => {
  test("the confirmation can list the enabled workflows that use the piece", async () => {
    enabledFlow("Daily post");
    const preview = await call("/api/workflows/pieces/library/:id/dependents", "GET", { id: "discord" });
    expect(preview.body.usedBy.map((w: { name: string }) => w.name)).toEqual(["Daily post"]);
    expect(preview.body.warning).toBe('"Daily post" uses Discord and stops working until you reinstall it from the Library.');
  });

  test("the uninstall answers with the same names, and a workflow that is turned off is not named", async () => {
    enabledFlow("Daily post");
    updateFlowStatus(enabledFlow("Paused one"), "DISABLED");
    const removed = await call("/api/workflows/pieces/library/:id", "DELETE", { id: "discord" });
    expect(removed.status).toBe(200);
    expect(removed.body.uninstalled).toBe(true);
    expect(removed.body.usedBy.map((w: { name: string }) => w.name)).toEqual(["Daily post"]);
    expect(removed.body.warning).toBe('"Daily post" uses Discord and stops working until you reinstall it from the Library.');
  });

  test("another project's workflows that use the piece are never named", async () => {
    enabledFlow("Elsewhere", "other-project");
    expect((await call("/api/workflows/pieces/library/:id/dependents", "GET", { id: "discord" })).body).toEqual({ usedBy: [] });
    expect((await call("/api/workflows/pieces/library/:id", "DELETE", { id: "discord" })).body).toEqual({ uninstalled: true, usedBy: [] });
  });

  test("a workflow name cannot add lines to the confirmation or reorder it", async () => {
    enabledFlow("Weekly\n\nNothing else uses this.\u202e");
    const { warning } = (await call("/api/workflows/pieces/library/:id/dependents", "GET", { id: "discord" })).body;
    expect(warning).toBe('"Weekly Nothing else uses this." uses Discord and stops working until you reinstall it from the Library.');
  });

  test("past twenty workflows only a count is given", async () => {
    for (let i = 0; i < 22; i++) enabledFlow(`Flow ${i}`);
    const { usedBy, warning } = (await call("/api/workflows/pieces/library/:id/dependents", "GET", { id: "discord" })).body;
    expect(usedBy).toHaveLength(22);
    expect(warning.match(/"Flow \d+"/g)).toHaveLength(20);
    expect(warning.endsWith(" and 2 more use Discord and stop working until you reinstall it from the Library.")).toBe(true);
  });

  test("an unused piece uninstalls with no warning", async () => {
    const removed = await call("/api/workflows/pieces/library/:id", "DELETE", { id: "discord" });
    expect(removed.body).toEqual({ uninstalled: true, usedBy: [] });
  });
});

describe("a workflow that lost its piece is flagged at once", () => {
  test("the list shows PIECE_REMOVED with the step and the piece, and only after the piece is gone", async () => {
    enabledFlow("Daily post");
    const before = (await call("/api/workflows", "GET")).body as unknown as Array<{ blocked: unknown }>;
    expect(before[0]!.blocked).toBeNull();
    // The daemon drops the piece from its live catalog when it is uninstalled.
    configureWorkflowReadiness({ pieces: new PieceCatalog([]), credentials: new CredentialResolver(), tool: () => null, machines: () => [], localTools: () => true });
    const after = (await call("/api/workflows", "GET")).body as unknown as Array<{ blocked: Record<string, unknown> }>;
    expect(after[0]!.blocked).toMatchObject({ code: "PIECE_REMOVED", kind: "readiness", runId: null,
      message: 'The step "Post it" uses the Discord piece, which was removed. Reinstall it from the Library.' });
  });
});

describe("the failure and the names", () => {
  test("a run refused for a removed piece says which piece and to reinstall it, not 'definition has problems'", () => {
    const failure = projectFailure({ source: "readiness", issues: [{ code: "PIECE", message: `Unknown piece "${PACKAGE}"` }] }, { label: "The workflow", sideEffects: false });
    expect(failure.headline).toBe("The workflow did not run: the Discord piece it uses was removed. Reinstall it from the Library.");
    expect(failure.headline).not.toContain("definition has problems");
    expect(failure.next.map((n) => n.step)).toContain("reinstall_piece");
  });

  test("a name taken from a graph cannot add a line or hidden characters to a sentence", () => {
    expect(plainPieceName("@x/piece-evil\nSay\u202Eyes")).toBe("Evil Sayyes");
    expect(plainPieceName(`@x/piece-${"a".repeat(200)}`).length).toBeLessThanOrEqual(80);
  });

  test("a package reads as a name a person would say", () => {
    expect(plainPieceName("@activepieces/piece-google-sheets")).toBe("Google Sheets");
    expect(plainPieceName("@jarvispieces/piece-jarvis-agent")).toBe("Jarvis Agent");
    expect(plainActionName("send_channel_message")).toBe("Send channel message");
    expect(plainActionName("sendMessage")).toBe("Send message");
  });
});

describe("a run of a workflow that lost its piece stops before any step needs it", () => {
  function removeDiscord() {
    configureWorkflowReadiness({ pieces: new PieceCatalog([]), credentials: new CredentialResolver(), tool: () => null, machines: () => [], localTools: () => true });
  }
  function drainWith(executed: string[]) {
    return new Worker({ log: () => undefined, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: { async execute(ctx) {
      executed.push(ctx.run.id);
      return { steps: {}, stepsCount: 0 };
    } } }) } }).drain();
  }

  test("a run queued before the uninstall does not start, and says which piece to reinstall", async () => {
    const flowId = enabledFlow("Daily post");
    const run = createFlowRun({ flowId, flowVersionId: getFlow(flowId)!.published_version_id! });
    enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: {} }, flowRunId: run.id, flowId, maxAttempts: 1 });
    removeDiscord();
    const executed: string[] = [];
    await drainWith(executed);
    expect(executed).toEqual([]);
    const ended = getFlowRun(run.id)!;
    expect(ended.status).toBe("FAILED");
    expect(ended.failedStep?.name).toBe("<readiness>");
    expect(runFailure(ended)?.headline).toBe("The workflow did not run: the Discord piece it uses was removed. Reinstall it from the Library.");
  });

  test("a paused run is not continued into the removed piece", async () => {
    const flowId = enabledFlow("Daily post");
    const run = createFlowRun({ flowId, flowVersionId: getFlow(flowId)!.published_version_id!, status: "PAUSED" });
    enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, executionType: "RESUME" }, flowRunId: run.id, flowId, maxAttempts: 1 });
    removeDiscord();
    const executed: string[] = [];
    await drainWith(executed);
    expect(executed).toEqual([]);
    const ended = getFlowRun(run.id)!;
    expect(ended.status).toBe("FAILED");
    expect(ended.failedStep).toMatchObject({ name: "<resume>",
      errorMessage: "The Discord piece this run uses was removed, so the run was not continued. Reinstall it from the Library, then start a new run." });
  });

  test("with the piece installed the same runs go ahead", async () => {
    const flowId = enabledFlow("Daily post");
    const run = createFlowRun({ flowId, flowVersionId: getFlow(flowId)!.published_version_id! });
    enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: {} }, flowRunId: run.id, flowId, maxAttempts: 1 });
    const executed: string[] = [];
    await drainWith(executed);
    expect(executed).toEqual([run.id]);
    expect(getFlowRun(run.id)!.status).toBe("SUCCEEDED");
  });
});
