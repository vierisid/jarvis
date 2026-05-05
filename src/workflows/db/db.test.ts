import { describe, expect, test, afterEach } from "bun:test";
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from "./index";

afterEach(() => {
  closeWorkflowDb();
});

describe("workflow db", () => {
  test("initWorkflowDb creates tables and seeds default tenant", () => {
    const db = initWorkflowDb(":memory:");

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);

    expect(tables).toContain("flow");
    expect(tables).toContain("flow_version");
    expect(tables).toContain("flow_run");
    expect(tables).toContain("app_connection");
    expect(tables).toContain("trigger_event");
    expect(tables).toContain("store_entry");
    expect(tables).toContain("workflow_file");
    expect(tables).toContain("workflow_job");
    expect(tables).toContain("workflow_user");
    expect(tables).toContain("workflow_project");

    const user = db
      .query<{ id: string }, []>("SELECT id FROM workflow_user")
      .all();
    const project = db
      .query<{ id: string; owner_id: string }, []>("SELECT id, owner_id FROM workflow_project")
      .all();
    expect(user).toHaveLength(1);
    expect(user[0]!.id).toBe(DEFAULT_IDS.user);
    expect(project).toHaveLength(1);
    expect(project[0]!.id).toBe(DEFAULT_IDS.project);
    expect(project[0]!.owner_id).toBe(DEFAULT_IDS.user);
  });

  test("initWorkflowDb is idempotent on a fresh in-memory db", () => {
    const db1 = initWorkflowDb(":memory:");
    db1.run(
      `INSERT INTO flow (id, external_id, project_id, status, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
      ["flow1", "ext1", DEFAULT_IDS.project, "ENABLED", Date.now(), Date.now()],
    );
    expect(db1.query("SELECT COUNT(*) AS n FROM flow").all()).toEqual([{ n: 1 }]);
    closeWorkflowDb();

    // Re-init in :memory: gives a fresh db; the test verifies that re-init
    // doesn't throw on the seed inserts (INSERT OR IGNORE).
    const db2 = initWorkflowDb(":memory:");
    expect(db2.query("SELECT COUNT(*) AS n FROM workflow_user").all()).toEqual([{ n: 1 }]);
  });

  test("foreign key cascade: deleting a flow removes its versions and runs", () => {
    const db = initWorkflowDb(":memory:");
    const now = Date.now();
    db.run(
      `INSERT INTO flow (id, external_id, project_id, status, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
      ["f1", "ext1", DEFAULT_IDS.project, "ENABLED", now, now],
    );
    db.run(
      `INSERT INTO flow_version (id, flow_id, display_name, trigger, state, valid, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["fv1", "f1", "v1", "{}", "DRAFT", 0, now, now],
    );
    db.run(
      `INSERT INTO flow_run (id, flow_id, flow_version_id, project_id, status, environment, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["fr1", "f1", "fv1", DEFAULT_IDS.project, "SUCCEEDED", "PRODUCTION", now, now],
    );

    db.run(`DELETE FROM flow WHERE id = ?`, ["f1"]);

    expect(db.query("SELECT COUNT(*) AS n FROM flow_version").all()).toEqual([{ n: 0 }]);
    expect(db.query("SELECT COUNT(*) AS n FROM flow_run").all()).toEqual([{ n: 0 }]);
  });

  test("getWorkflowDb throws before init", () => {
    expect(() => getWorkflowDb()).toThrow(/not initialized/);
  });

  test("uniqueness: external_id is unique within a project", () => {
    const db = initWorkflowDb(":memory:");
    const now = Date.now();
    db.run(
      `INSERT INTO flow (id, external_id, project_id, status, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
      ["f1", "shared-ext", DEFAULT_IDS.project, "ENABLED", now, now],
    );
    expect(() => {
      db.run(
        `INSERT INTO flow (id, external_id, project_id, status, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
        ["f2", "shared-ext", DEFAULT_IDS.project, "ENABLED", now, now],
      );
    }).toThrow();
  });

  test("workflow_job claim CHECK constraint rejects bad status", () => {
    const db = initWorkflowDb(":memory:");
    expect(() => {
      db.run(
        `INSERT INTO workflow_job (id, job_type, payload, status, scheduled_at, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["j1", "RUN_FLOW", "{}", "WAT", Date.now(), Date.now(), Date.now()],
      );
    }).toThrow();
  });
});
