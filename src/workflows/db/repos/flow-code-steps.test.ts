/**
 * The CODE-step gate: item 3 of #467.
 *
 * A CODE step runs arbitrary JavaScript in the engine's child process with
 * this machine's privileges, so it is refused until the flow it lives in has
 * been opted in. These tests pin the three things that make the gate worth
 * having: it refuses at AUTHORING time (publish, enable, a direct run request)
 * and never per execution; it finds a CODE step wherever it hides, including
 * inside a LOOP body and behind a ROUTER branch; and a flow that was already
 * running one before the gate existed keeps running.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createManageWorkflowTool } from "../../../actions/tools/manage-workflow";
import { JarvisWorkflowRunnerAdapter } from "../../adapters/workflow-runner";
import { createWorkflowRoutes, type WorkflowRouteMap } from "../../api/routes";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../index";
import { createSchema } from "../schema";
import { findCodeStepNames, walkFlowNodes } from "../flow-graph";
import {
  createFlow,
  flowCodeStepsEnabled,
  getFlow,
  setFlowCodeStepsEnabled,
  updateFlowMetadata,
  updateFlowStatus,
  type FlowRow,
} from "./flow";
import { createDraftVersion, getFlowVersion, type FlowTriggerNode } from "./flow-version";
import { publishFlowVersion } from "./flow-publication";
import { assertCodeStepsAllowed, CodeStepsRefusedError } from "./flow-code-steps";
import { countQueued } from "./job-queue";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------- fixtures */

const CODE_STEP: FlowTriggerNode = {
  name: "compute_totals",
  type: "CODE",
  displayName: "Compute totals",
  settings: { sourceCode: { packageJson: "{}", code: "export const code = async () => ({});" } },
};

/** A plain chain: trigger -> piece -> CODE. */
function chainWithCode(): FlowTriggerNode {
  return {
    name: "trigger",
    type: "EMPTY",
    nextAction: {
      name: "step_1",
      type: "PIECE",
      settings: { pieceName: "@activepieces/piece-slack", actionName: "send_channel_message" },
      nextAction: { ...CODE_STEP },
    },
  };
}

/** The CODE step is the body of a LOOP, reachable only through firstLoopAction. */
function loopWithCode(): FlowTriggerNode {
  return {
    name: "trigger",
    type: "EMPTY",
    nextAction: {
      name: "loop_1",
      type: "LOOP_ON_ITEMS",
      settings: { items: "{{trigger.rows}}" },
      firstLoopAction: { ...CODE_STEP },
      nextAction: { name: "after_loop", type: "PIECE", settings: { pieceName: "p", actionName: "a" } },
    },
  };
}

/** The CODE step sits in the SECOND router branch -- #459's review found
 *  exactly this case reachable past a scan that only walked the chain. */
function routerWithCode(): FlowTriggerNode {
  return {
    name: "trigger",
    type: "EMPTY",
    nextAction: {
      name: "router_1",
      type: "ROUTER",
      settings: {
        executionType: "EXECUTE_FIRST_MATCH",
        branches: [
          {
            branchType: "CONDITION",
            branchName: "urgent",
            conditions: [[{ firstValue: "{{trigger.kind}}", operator: "TEXT_EXACTLY_MATCHES", secondValue: "urgent" }]],
          },
          { branchType: "FALLBACK", branchName: "everything else" },
        ],
      },
      children: [
        { name: "branch_a_step", type: "PIECE", settings: { pieceName: "p", actionName: "a" } },
        { name: "branch_b_step", type: "PIECE", settings: { pieceName: "p", actionName: "a" }, nextAction: { ...CODE_STEP } },
      ],
    },
  };
}

function cleanChain(): FlowTriggerNode {
  return {
    name: "trigger",
    type: "EMPTY",
    nextAction: { name: "step_1", type: "PIECE", settings: { pieceName: "p", actionName: "a" } },
  };
}

function fixture(trigger: FlowTriggerNode, displayName = "Nightly rollup") {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName, trigger });
  return { flow, version };
}

let routes: WorkflowRouteMap;
let refreshed: string[];

beforeEach(() => {
  initWorkflowDb(":memory:");
  refreshed = [];
  routes = createWorkflowRoutes({
    triggerManager: {
      refresh: async (id: string) => { refreshed.push(id); },
    } as NonNullable<Parameters<typeof createWorkflowRoutes>[0]>["triggerManager"],
  });
});
afterEach(() => closeWorkflowDb());

async function call(path: string, method: "GET" | "POST" | "PATCH", id: string, body?: unknown) {
  const req = new Request("http://localhost" + path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  }) as Request & { params: Record<string, string> };
  req.params = { id };
  const response = await routes[path]![method]!(req);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const tool = () => createManageWorkflowTool();

async function runTool(action: string, params: Record<string, unknown> = {}) {
  return JSON.parse(String(await tool().execute({ action, ...params }))) as Record<string, unknown>;
}

/* ------------------------------------------------------- CODE detection */

describe("CODE detection walks the whole graph", () => {
  test("a CODE step at the end of the chain is found", () => {
    expect(findCodeStepNames(chainWithCode())).toEqual(["compute_totals"]);
  });

  test("a CODE step inside a LOOP body is found", () => {
    expect(findCodeStepNames(loopWithCode())).toEqual(["compute_totals"]);
  });

  test("a CODE step inside a ROUTER branch is found", () => {
    expect(findCodeStepNames(routerWithCode())).toEqual(["compute_totals"]);
  });

  test("a flow with no CODE step reports none", () => {
    expect(findCodeStepNames(cleanChain())).toEqual([]);
  });

  test("every CODE step is reported, not just the first", () => {
    const trigger = loopWithCode();
    trigger.nextAction!.nextAction!.nextAction = { ...CODE_STEP, name: "post_process" };
    expect(findCodeStepNames(trigger)).toEqual(["compute_totals", "post_process"]);
  });

  test("a malformed graph terminates instead of throwing or spinning", () => {
    const self = { name: "loop", type: "PIECE" } as FlowTriggerNode;
    self.nextAction = self;
    expect(walkFlowNodes(self).length).toBe(1);
    expect(walkFlowNodes({ name: "n", type: "ROUTER", children: "not an array" } as never)).toHaveLength(1);
    expect(findCodeStepNames(null)).toEqual([]);
    expect(findCodeStepNames({ type: "CODE" } as FlowTriggerNode)).toEqual(["<unnamed>"]);
  });
});

/* ------------------------------------------------------------- publish */

describe("publish is refused until CODE is enabled for the flow", () => {
  for (const [shape, build] of [
    ["a plain chain", chainWithCode],
    ["a LOOP body", loopWithCode],
    ["a ROUTER branch", routerWithCode],
  ] as const) {
    test(`publish refuses a CODE step in ${shape}`, () => {
      const { flow, version } = fixture(build());
      // The message has to be publish's, not a downstream step's: the refusal
      // belongs to the moment a human asked to publish.
      expect(() => publishFlowVersion(flow.id)).toThrow("Enable code steps for this flow to publish");
      // Nothing committed: not locked, not attached, not enabled.
      const after = getFlow(flow.id)!;
      expect(after.published_version_id).toBeNull();
      expect(after.status).toBe("DISABLED");
      expect(getFlowVersion(version.id)!.state).toBe("DRAFT");
    });
  }

  test("the refusal names what was refused, the step, and how to enable it", () => {
    const { flow } = fixture(chainWithCode());
    let error: CodeStepsRefusedError | null = null;
    try { publishFlowVersion(flow.id); } catch (e) { error = e as CodeStepsRefusedError; }
    expect(error).toBeInstanceOf(CodeStepsRefusedError);
    expect(error!.message).toContain("This flow contains a CODE step");
    expect(error!.message).toContain('"compute_totals"');
    expect(error!.message).toContain("Enable code steps for this flow to publish");
    expect(error!.message).toContain(`POST /api/workflows/${flow.id}/code-steps {"enabled": true}`);
    expect(error!.status).toBe(403);
    expect(error!.stepNames).toEqual(["compute_totals"]);
  });

  test("publish succeeds once CODE is enabled for that flow", () => {
    const { flow, version } = fixture(chainWithCode());
    setFlowCodeStepsEnabled(flow.id, true);
    const published = publishFlowVersion(flow.id);
    expect(published.version.id).toBe(version.id);
    expect(published.version.state).toBe("LOCKED");
    expect(published.flow.status).toBe("ENABLED");
    expect(published.flow.published_version_id).toBe(version.id);
  });

  test("the grant is per flow, not global", () => {
    const enabled = fixture(chainWithCode(), "Opted in");
    const other = fixture(chainWithCode(), "Not opted in");
    setFlowCodeStepsEnabled(enabled.flow.id, true);
    expect(publishFlowVersion(enabled.flow.id).flow.status).toBe("ENABLED");
    expect(() => publishFlowVersion(other.flow.id)).toThrow(CodeStepsRefusedError);
  });

  test("a flow with no CODE step publishes with no opt-in at all", () => {
    const { flow, version } = fixture(cleanChain());
    const published = publishFlowVersion(flow.id);
    expect(published.version.id).toBe(version.id);
    expect(published.flow.status).toBe("ENABLED");
    expect(flowCodeStepsEnabled(getFlow(flow.id)!)).toBe(false);
  });

  test("revoking the grant refuses the next publish of the same flow", () => {
    const { flow } = fixture(chainWithCode());
    setFlowCodeStepsEnabled(flow.id, true);
    publishFlowVersion(flow.id);
    createDraftVersion({ flowId: flow.id, displayName: "v2", trigger: chainWithCode() });
    setFlowCodeStepsEnabled(flow.id, false);
    expect(() => publishFlowVersion(flow.id)).toThrow(CodeStepsRefusedError);
  });
});

/* -------------------------------------------------------------- enable */

describe("enabling a flow is gated too", () => {
  test("an unpublished CODE draft cannot be enabled into a trigger registration", () => {
    const { flow } = fixture(chainWithCode());
    expect(() => updateFlowStatus(flow.id, "ENABLED")).toThrow(CodeStepsRefusedError);
    expect(getFlow(flow.id)!.status).toBe("DISABLED");
  });

  test("disabling is never refused", () => {
    const { flow } = fixture(chainWithCode());
    expect(() => updateFlowStatus(flow.id, "DISABLED")).not.toThrow();
  });

  test("enable succeeds once the flow is opted in", () => {
    const { flow } = fixture(chainWithCode());
    setFlowCodeStepsEnabled(flow.id, true);
    updateFlowStatus(flow.id, "ENABLED");
    expect(getFlow(flow.id)!.status).toBe("ENABLED");
  });
});

/* ------------------------------------------------ direct run requests */

describe("a direct run request is refused the same way", () => {
  test("the HTTP run route refuses an unpublished CODE draft with 403", async () => {
    const { flow } = fixture(chainWithCode());
    const res = await call("/api/workflows/:id/run", "POST", flow.id, {});
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain("Enable code steps for this flow to run it");
    expect(countQueued()).toBe(0);
  });

  test("manage_workflow run refuses an unpublished CODE draft", async () => {
    const { flow } = fixture(chainWithCode());
    await expect(runTool("run", { flow: flow.id })).rejects.toThrow("Enable code steps for this flow");
    expect(countQueued()).toBe(0);
  });

  test("a nested run_workflow step cannot start an unpublished CODE draft", async () => {
    const { flow } = fixture(chainWithCode());
    const adapter = new JarvisWorkflowRunnerAdapter();
    await expect(adapter.start({ flowId: flow.id })).rejects.toThrow("Enable code steps for this flow");
  });

  test("the run route works again once the flow is opted in", async () => {
    const { flow } = fixture(chainWithCode());
    setFlowCodeStepsEnabled(flow.id, true);
    const res = await call("/api/workflows/:id/run", "POST", flow.id, {});
    expect(res.status).toBe(202);
  });
});

/* ------------------------------------------------- the LLM tool path */

describe("the manage_workflow path is refused exactly like the HTTP path", () => {
  test("publish through the tool is refused with the same actionable message", async () => {
    const { flow } = fixture(chainWithCode());
    await expect(runTool("publish", { flow: flow.id })).rejects.toThrow(
      "Enable code steps for this flow to publish",
    );
    expect(getFlow(flow.id)!.published_version_id).toBeNull();
  });

  test("enable through the tool is refused", async () => {
    const { flow } = fixture(loopWithCode());
    await expect(runTool("enable", { flow: flow.id })).rejects.toThrow("Enable code steps for this flow");
    expect(getFlow(flow.id)!.status).toBe("DISABLED");
  });

  test("the tool exposes no action that grants the permission", () => {
    const description = tool().description;
    // The model is told the refusal exists and that relaying it is the move,
    // but the grant route is deliberately absent: the permission is the user's
    // to give, and an LLM-authored FlowVersion is the threat it guards.
    expect(description).toContain("REFUSED");
    expect(description).toContain("no tool action");
    expect(description).not.toContain("code-steps");
    expect(Object.keys(tool().parameters)).not.toContain("codeSteps");
  });

  test("tool publish succeeds after the user opts the flow in", async () => {
    const { flow } = fixture(routerWithCode());
    setFlowCodeStepsEnabled(flow.id, true);
    const out = await runTool("publish", { flow: flow.id });
    expect(out.status).toBe("ENABLED");
  });
});

/* ------------------------------------------------------- the opt-in route */

describe("POST /api/workflows/:id/code-steps", () => {
  test("grants, reports and revokes the permission", async () => {
    const { flow } = fixture(chainWithCode());
    const granted = await call("/api/workflows/:id/code-steps", "POST", flow.id, { enabled: true });
    expect(granted.status).toBe(200);
    expect(granted.body.codeSteps).toMatchObject({ enabled: true, grantedBy: "user" });
    expect(await call("/api/workflows/:id/publish", "POST", flow.id, {}).then((r) => r.status)).toBe(200);

    const revoked = await call("/api/workflows/:id/code-steps", "POST", flow.id, { enabled: false });
    expect(revoked.body.codeSteps).toMatchObject({ enabled: false, grantedBy: null, grantedAt: null });
  });

  test("rejects a missing or non-boolean enabled and an unknown flow", async () => {
    const { flow } = fixture(chainWithCode());
    expect((await call("/api/workflows/:id/code-steps", "POST", flow.id, {})).status).toBe(400);
    expect((await call("/api/workflows/:id/code-steps", "POST", flow.id, { enabled: "yes" })).status).toBe(400);
    expect((await call("/api/workflows/:id/code-steps", "POST", "nope", { enabled: true })).status).toBe(404);
  });

  test("the generic flow PATCH cannot grant the permission through metadata", async () => {
    const { flow } = fixture(chainWithCode());
    const patched = await call("/api/workflows/:id", "PATCH", flow.id, {
      metadata: { code_steps_enabled: 1, codeSteps: { enabled: true } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.codeSteps).toMatchObject({ enabled: false });
    expect(() => publishFlowVersion(flow.id)).toThrow(CodeStepsRefusedError);
  });

  test("the publish route answers 403 and leaves the flow alone", async () => {
    const { flow } = fixture(routerWithCode());
    const res = await call("/api/workflows/:id/publish", "POST", flow.id, {});
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('"compute_totals"');
    expect(refreshed).toHaveLength(0);
  });

  test("the flow PATCH answers 403 when asked to enable a CODE draft", async () => {
    const { flow } = fixture(chainWithCode());
    const res = await call("/api/workflows/:id", "PATCH", flow.id, { status: "ENABLED" });
    expect(res.status).toBe(403);
    expect(getFlow(flow.id)!.status).toBe("DISABLED");
    expect(refreshed).toHaveLength(0);
  });
});

/* ------------------------------------------------------- grandfathering */

/**
 * The upgrade case. A brain that has been running a CODE flow on a cron for
 * months must not stop because it restarted on a newer build, and the user
 * must not silently acquire the permission on flows that never used one. The
 * migration is driven off the ALTER, so it fires exactly once: on the boot
 * that adds the column to a database that predates it.
 */
describe("existing flows are grandfathered on upgrade", () => {
  function onLegacyDb<T>(seed: () => T, assert: (seeded: T) => void): void {
    closeWorkflowDb();
    const directory = mkdtempSync(join(tmpdir(), "jarvis-code-steps-"));
    const path = join(directory, "legacy.db");
    try {
      initWorkflowDb(path);
      const seeded = seed();
      // Rewind to the pre-gate shape, then upgrade on a fresh connection the
      // way daemon startup does (Bun caches a `SELECT *` column map per
      // connection, so the reopen is not optional).
      const db = getWorkflowDb();
      db.exec("ALTER TABLE flow DROP COLUMN code_steps_granted_at");
      db.exec("ALTER TABLE flow DROP COLUMN code_steps_grant");
      db.exec("ALTER TABLE flow DROP COLUMN code_steps_enabled");
      closeWorkflowDb();
      initWorkflowDb(path);
      createSchema(getWorkflowDb());
      assert(seeded);
    } finally {
      closeWorkflowDb();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test("a published, enabled CODE flow keeps its permission and keeps running", () => {
    onLegacyDb(
      () => {
        const flow = createFlow();
        const version = createDraftVersion({ flowId: flow.id, displayName: "Nightly", trigger: loopWithCode() });
        // Publish the pre-gate way: lock, attach, enable, with no grant.
        getWorkflowDb().run(`UPDATE flow_version SET state = 'LOCKED' WHERE id = ?`, [version.id]);
        getWorkflowDb().run(`UPDATE flow SET published_version_id = ?, status = 'ENABLED' WHERE id = ?`, [version.id, flow.id]);
        return { flowId: flow.id, versionId: version.id, updated: getFlow(flow.id)!.updated };
      },
      ({ flowId, versionId, updated }) => {
        const row = getFlow(flowId)!;
        expect(flowCodeStepsEnabled(row)).toBe(true);
        expect(row.code_steps_grant).toBe("upgrade");
        expect(row.code_steps_granted_at).toBeGreaterThan(0);
        // The list order must not change under the user just because the
        // daemon restarted on a new build.
        expect(row.updated).toBe(updated);
        // And the gate lets the flow run, re-enable and re-publish.
        expect(() => assertCodeStepsAllowed(flowId, versionId, "run")).not.toThrow();
        expect(() => updateFlowStatus(flowId, "ENABLED")).not.toThrow();
        createDraftVersion({ flowId, displayName: "Nightly", trigger: loopWithCode() });
        expect(publishFlowVersion(flowId).flow.status).toBe("ENABLED");
      },
    );
  });

  test("an ENABLED flow running an unpublished CODE draft is grandfathered too", () => {
    onLegacyDb(
      () => {
        const flow = createFlow();
        createDraftVersion({ flowId: flow.id, displayName: "Draft cron", trigger: routerWithCode() });
        getWorkflowDb().run(`UPDATE flow SET status = 'ENABLED' WHERE id = ?`, [flow.id]);
        return flow.id;
      },
      (flowId) => expect(getFlow(flowId)!.code_steps_grant).toBe("upgrade"),
    );
  });

  test("a published flow with no CODE step is not silently granted anything", () => {
    onLegacyDb(
      () => {
        const flow = createFlow();
        const version = createDraftVersion({ flowId: flow.id, displayName: "Clean", trigger: cleanChain() });
        getWorkflowDb().run(`UPDATE flow SET published_version_id = ?, status = 'ENABLED' WHERE id = ?`, [version.id, flow.id]);
        return flow.id;
      },
      (flowId) => {
        expect(flowCodeStepsEnabled(getFlow(flowId)!)).toBe(false);
        expect(getFlow(flowId)!.code_steps_grant).toBeNull();
      },
    );
  });

  test("a never-published, disabled CODE draft is NOT granted", () => {
    onLegacyDb(
      () => {
        const flow = createFlow();
        createDraftVersion({ flowId: flow.id, displayName: "Parked", trigger: chainWithCode() });
        return flow.id;
      },
      (flowId) => {
        expect(flowCodeStepsEnabled(getFlow(flowId)!)).toBe(false);
        expect(() => publishFlowVersion(flowId)).toThrow(CodeStepsRefusedError);
      },
    );
  });

  test("a fresh database grandfathers nothing and starts every flow at OFF", () => {
    const { flow } = fixture(chainWithCode());
    const row: FlowRow = getFlow(flow.id)!;
    expect(row.code_steps_enabled).toBe(0);
    expect(row.code_steps_grant).toBeNull();
    // Re-running the schema is idempotent and must not hand out a grant.
    createSchema(getWorkflowDb());
    expect(flowCodeStepsEnabled(getFlow(flow.id)!)).toBe(false);
  });

  test("an unparseable trigger neither fails the boot nor earns a grant", () => {
    onLegacyDb(
      () => {
        const flow = createFlow();
        const version = createDraftVersion({ flowId: flow.id, displayName: "Broken", trigger: chainWithCode() });
        getWorkflowDb().run(`UPDATE flow_version SET trigger = 'not json' WHERE id = ?`, [version.id]);
        getWorkflowDb().run(`UPDATE flow SET published_version_id = ?, status = 'ENABLED' WHERE id = ?`, [version.id, flow.id]);
        return flow.id;
      },
      (flowId) => expect(flowCodeStepsEnabled(getFlow(flowId)!)).toBe(false),
    );
  });
});

/* ------------------------------------------------------------ housekeeping */

test("metadata still round-trips independently of the grant", () => {
  const { flow } = fixture(cleanChain());
  updateFlowMetadata(flow.id, { note: "kept" });
  setFlowCodeStepsEnabled(flow.id, true);
  const row = getFlow(flow.id)!;
  expect(JSON.parse(row.metadata!)).toEqual({ note: "kept" });
  expect(flowCodeStepsEnabled(row)).toBe(true);
});
