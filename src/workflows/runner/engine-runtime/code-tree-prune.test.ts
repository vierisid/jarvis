/**
 * #865: `workflow-codes/<versionId>` trees are pruned when nothing needs them,
 * and never one a published or draft version, an unfinished run, a queued job,
 * a run in this process or a recent run in another process still needs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import { createDraftVersion, lockVersion } from "../../db/repos/flow-version";
import { createFlowRun } from "../../db/repos/flow-run";
import { createWaitpoint } from "../../db/repos/waitpoint";
import { enqueue } from "../../db/repos/job-queue";
import { versionIdsNeedingCodeTrees } from "../../db/repos/code-tree-retention";
import { DEFAULT_IDS } from "../../db/schema";
import { leaseCodeTree } from "./code-materialize";
import { pruneCodeTrees, startCodeTreeRetention } from "./code-tree-prune";

const DAY = 24 * 60 * 60_000;
let base: string;

beforeEach(() => {
  initWorkflowDb(":memory:");
  base = mkdtempSync(join(tmpdir(), "jarvis-code-trees-"));
});
afterEach(() => {
  closeWorkflowDb();
  rmSync(base, { recursive: true, force: true });
});

/** A tree as materialization leaves it, last used `ageMs` ago. */
function tree(versionId: string, ageMs = 2 * DAY): string {
  const dir = join(base, versionId);
  mkdirSync(join(dir, "step_1", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "step_1", "index.js"), "exports.code = async () => 1;");
  const at = new Date(Date.now() - ageMs);
  utimesSync(dir, at, at);
  return dir;
}

const flow = () => createFlow({ projectId: DEFAULT_IDS.project });
const locked = (flowId: string) => lockVersion(createDraftVersion({ flowId, displayName: "v" }).id);
function runWith(flowId: string, versionId: string, status: string): string {
  const run = createFlowRun({ flowId, flowVersionId: versionId });
  // Straight to the status: the rules read the column, whatever path set it.
  getWorkflowDb().run(`UPDATE flow_run SET status = ? WHERE id = ?`, [status, run.id]);
  return run.id;
}

/** Attach without publish's readiness checks: only the column matters here. */
function publish(flowId: string, versionId: string): void {
  getWorkflowDb().run(`UPDATE flow SET published_version_id = ? WHERE id = ?`, [versionId, flowId]);
}

const prune = (opts: { now?: number } = {}) =>
  pruneCodeTrees({ baseCodeDir: base, needed: versionIdsNeedingCodeTrees, ...opts });

describe("pruneCodeTrees with the database's rules", () => {
  test("removes only the trees no version, run, job or recent use needs", async () => {
    const f = flow();
    const published = locked(f.id);
    publish(f.id, published.id);
    const draft = createDraftVersion({ flowId: f.id, displayName: "draft" });
    const replaced = locked(f.id); // published once, then replaced: no runs left
    const finished = locked(f.id);
    runWith(f.id, finished.id, "SUCCEEDED");
    const stopped = locked(f.id);
    runWith(f.id, stopped.id, "STOPPED");
    const queued = locked(f.id);
    runWith(f.id, queued.id, "QUEUED");
    const running = locked(f.id);
    runWith(f.id, running.id, "RUNNING");
    const paused = locked(f.id);
    const pausedRun = runWith(f.id, paused.id, "PAUSED");
    createWaitpoint({ flowRunId: pausedRun, projectId: DEFAULT_IDS.project, stepName: "wait", type: "WEBHOOK" });
    const unknown = locked(f.id);
    runWith(f.id, unknown.id, "SOME_FUTURE_STATUS");
    const jobbed = locked(f.id);
    runWith(f.id, jobbed.id, "SUCCEEDED");
    enqueue({ jobType: "RUN_FLOW", flowId: f.id, flowVersionId: jobbed.id, payload: {} });

    const keep = [published.id, draft.id, queued.id, running.id, paused.id, unknown.id, jobbed.id];
    const go = [replaced.id, finished.id, stopped.id, "deleted_flow_version"];
    for (const id of [...keep, ...go]) tree(id);

    const { removed } = await prune();

    expect(removed.sort()).toEqual([...go].sort());
    for (const id of keep) expect(existsSync(join(base, id, "step_1", "index.js"))).toBe(true);
    for (const id of go) expect(existsSync(join(base, id))).toBe(false);
    // Nothing of the removal is left behind either.
    expect(readdirSync(base).filter((e) => e.startsWith("."))).toEqual([]);
  });

  test("each rule alone keeps its tree", async () => {
    // One version per rule, so dropping any one rule from the query loses
    // exactly one tree here.
    const f = flow();
    const published = locked(f.id);
    publish(f.id, published.id);
    const draft = createDraftVersion({ flowId: f.id, displayName: "draft" });
    const paused = locked(f.id);
    runWith(f.id, paused.id, "PAUSED");
    const jobbed = locked(f.id);
    enqueue({ jobType: "RUN_FLOW", flowId: f.id, flowVersionId: jobbed.id, payload: {} });
    expect([...versionIdsNeedingCodeTrees()].sort()).toEqual([published.id, draft.id, paused.id, jobbed.id].sort());
  });

  test("only a flow's current draft keeps its tree, not every draft it ever had", async () => {
    const f = flow();
    const older = createDraftVersion({ flowId: f.id, displayName: "older" });
    const current = createDraftVersion({ flowId: f.id, displayName: "current" });
    getWorkflowDb().run(`UPDATE flow_version SET updated = 1 WHERE id = ?`, [older.id]);
    getWorkflowDb().run(`UPDATE flow_version SET updated = 2 WHERE id = ?`, [current.id]);
    const needed = versionIdsNeedingCodeTrees();
    expect(needed.has(current.id)).toBe(true);
    expect(needed.has(older.id)).toBe(false);
  });

  test("a draft pinned by a Brief removal is the current draft, even when a newer one exists", async () => {
    const f = flow();
    const pinned = createDraftVersion({ flowId: f.id, displayName: "pinned" });
    const newer = createDraftVersion({ flowId: f.id, displayName: "newer" });
    getWorkflowDb().run(`UPDATE flow_version SET updated = 1 WHERE id = ?`, [pinned.id]);
    getWorkflowDb().run(`UPDATE flow_version SET updated = 2 WHERE id = ?`, [newer.id]);
    getWorkflowDb().run(`UPDATE brief_workflow_slots SET pinned_draft_id = ? WHERE flow_id = ?`, [pinned.id, f.id]);
    const needed = versionIdsNeedingCodeTrees();
    expect(needed.has(pinned.id)).toBe(true);
    expect(needed.has(newer.id)).toBe(false);
  });

  test("a running job keeps its tree too", async () => {
    const f = flow();
    const v = locked(f.id);
    const job = enqueue({ jobType: "RUN_FLOW", flowId: f.id, flowVersionId: v.id, payload: {} });
    getWorkflowDb().run(`UPDATE workflow_job SET status = 'RUNNING' WHERE id = ?`, [job.id]);
    expect(versionIdsNeedingCodeTrees().has(v.id)).toBe(true);
  });

  test("a finished or dropped job does not keep a tree", async () => {
    const f = flow();
    const v = locked(f.id);
    const job = enqueue({ jobType: "RUN_FLOW", flowId: f.id, flowVersionId: v.id, payload: {} });
    getWorkflowDb().run(`UPDATE workflow_job SET status = 'SUCCEEDED' WHERE id = ?`, [job.id]);
    expect(versionIdsNeedingCodeTrees().has(v.id)).toBe(false);
  });

  test("a tree used within the last day is kept: another process may be running it", async () => {
    tree("recent_version", DAY - 60_000);
    tree("old_version", DAY + 60_000);
    const { removed } = await prune();
    expect(removed).toEqual(["old_version"]);
    expect(existsSync(join(base, "recent_version"))).toBe(true);
  });

  test("a tree a run in this process holds is kept until it lets go", async () => {
    tree("leased_version");
    const release = leaseCodeTree(base, "leased_version");
    expect((await prune()).removed).toEqual([]);
    expect(existsSync(join(base, "leased_version", "step_1", "index.js"))).toBe(true);
    release();
    expect((await prune()).removed).toEqual(["leased_version"]);
  });

  test("leases are counted: one run finishing does not uncover another's tree", async () => {
    tree("shared_version");
    const first = leaseCodeTree(base, "shared_version");
    const second = leaseCodeTree(base, "shared_version");
    first();
    first(); // releasing twice is a no-op, not a second release
    expect((await prune()).removed).toEqual([]);
    second();
    expect((await prune()).removed).toEqual(["shared_version"]);
  });

  test("leaves anything that is not a version tree alone, and finishes an interrupted prune", async () => {
    writeFileSync(join(base, "README"), "x");
    mkdirSync(join(base, ".hidden"));
    mkdirSync(join(base, "dotted.name"));
    mkdirSync(join(base, ".pruning-old-1234"));
    for (const name of [".hidden", "dotted.name"]) {
      const at = new Date(Date.now() - 2 * DAY);
      utimesSync(join(base, name), at, at);
    }
    // A link named like a version, to a directory outside the code directory
    // that looks like an old unneeded tree: neither is touched.
    const outside = mkdtempSync(join(tmpdir(), "jarvis-code-trees-outside-"));
    try {
      writeFileSync(join(outside, "keep.txt"), "x");
      const at = new Date(Date.now() - 2 * DAY);
      utimesSync(outside, at, at);
      symlinkSync(outside, join(base, "linkedversion"));
      // The link itself looks old too, so only the is-a-directory rule keeps it.
      lutimesSync(join(base, "linkedversion"), at, at);
      await prune();
      expect(readdirSync(base).sort()).toEqual([".hidden", "README", "dotted.name", "linkedversion"]);
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("when the needed set cannot be read, nothing is removed", async () => {
    tree("some_version");
    await expect(
      pruneCodeTrees({ baseCodeDir: base, needed: () => { throw new Error("database closed"); } }),
    ).rejects.toThrow("database closed");
    expect(existsSync(join(base, "some_version"))).toBe(true);
  });

  test("a missing code directory is nothing to do", async () => {
    expect((await pruneCodeTrees({ baseCodeDir: join(base, "absent"), needed: () => new Set() })).removed).toEqual([]);
  });
});

describe("startCodeTreeRetention", () => {
  test("prunes at once, and a failing pass is logged rather than thrown", async () => {
    tree("old_version");
    const lines: string[] = [];
    const ok = startCodeTreeRetention({ baseCodeDir: base, needed: () => new Set(), log: (l) => lines.push(l) });
    await ok.idle();
    ok.stop();
    expect(existsSync(join(base, "old_version"))).toBe(false);
    expect(lines.join("\n")).toContain("removed 1 unused CODE-step tree");

    tree("other_version");
    const failing = startCodeTreeRetention({
      baseCodeDir: base,
      needed: () => { throw new Error("database closed"); },
      log: (l) => lines.push(l),
    });
    await failing.idle();
    failing.stop();
    expect(existsSync(join(base, "other_version"))).toBe(true);
    expect(lines.join("\n")).toContain("CODE-step tree prune failed (continuing): database closed");
  });
});
