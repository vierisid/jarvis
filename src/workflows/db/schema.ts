/**
 * SQLite schema for the Jarvis workflow runtime.
 *
 * Mirrors the activepieces domain model (see
 * src/workflows/activepieces/packages/shared/src/lib/automation/) but flattened
 * for SQLite: JSON blobs in TEXT columns, integer epoch-ms timestamps, foreign
 * keys with ON DELETE CASCADE where ownership is clear.
 *
 * Single-tenant: there is one user and one project, hardcoded as constants in
 * `DEFAULT_IDS`. We keep `project_id` columns on `flow`, `flow_run`,
 * `app_connection`, etc. so vendored activepieces code that filters by
 * `project_id` keeps working without modification, but those columns reference
 * a constant value rather than a row in a tenant table.
 */

import type { Database } from "bun:sqlite";
import { hasCodeStep } from "./flow-graph";
import type { FlowTriggerNode } from "./repos/flow-version";

export const DEFAULT_IDS = {
  user: "jrv_user_default",
  project: "jrv_proj_default",
} as const;

const STATEMENTS: string[] = [
  // Cancellation is a durable dispatch fence, separate from effect receipts.
  `CREATE TABLE IF NOT EXISTS workflow_run_cancellation (
    run_id TEXT PRIMARY KEY REFERENCES flow_run(id) ON DELETE CASCADE,
    acknowledged_at INTEGER NOT NULL,
    status_at_request TEXT NOT NULL,
    in_flight_may_have_completed INTEGER NOT NULL
  )`,
  // --- Flow definitions ---
  `CREATE TABLE IF NOT EXISTS flow (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_id TEXT,
    folder_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('ENABLED', 'DISABLED')),
    operation_status TEXT NOT NULL DEFAULT 'NONE',
    published_version_id TEXT,
    schema_version TEXT,
    template_id TEXT,
    time_saved_per_run INTEGER,
    metadata TEXT,
    -- Per-flow opt-in for CODE steps. A CODE step runs arbitrary JavaScript in
    -- the engine's child process with this machine's privileges, so a flow
    -- containing one is refused at publish until the flag is set FOR THAT FLOW
    -- (see repos/flow-code-steps.ts). Deliberately its own column, not a key
    -- in metadata: the metadata blob is replaced wholesale by
    -- PATCH /api/workflows/:id, and a privilege grant must not be something an
    -- unrelated write can hand out or discard by accident.
    code_steps_enabled INTEGER NOT NULL DEFAULT 0,
    -- 'user' when a human turned it on, 'upgrade' when the flag was
    -- grandfathered onto a flow that was already running CODE before the gate
    -- existed. Kept so the dashboard can show WHY a flow has the permission
    -- and the user can take it back.
    code_steps_grant TEXT,
    code_steps_granted_at INTEGER,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flow_project ON flow(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_flow_status ON flow(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_external ON flow(project_id, external_id)`, // expand-contract-ok: base-schema index (created with the table)

  // Engine-managed trigger state lives in `engine_listeners` (JSON array of
  // AppEventListener `{ events, identifierValue }`, returned by upstream's
  // EXECUTE_TRIGGER_HOOK(ON_ENABLE) for webhook-strategy triggers) and
  // `engine_schedule` (JSON `{ cronExpression, timezone? }` set by polling
  // triggers via `setSchedule`). TriggerManager reads these to wire the
  // CronScheduler / WebhookManager without re-running the engine on every
  // refresh.
  `CREATE TABLE IF NOT EXISTS flow_version (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('DRAFT', 'LOCKED')),
    valid INTEGER NOT NULL DEFAULT 0,
    schema_version TEXT,
    updated_by TEXT,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    connection_ids TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    backup_files TEXT,
    engine_listeners TEXT,
    engine_schedule TEXT,
    sample_data TEXT,
    sample_input TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flow_version_flow ON flow_version(flow_id)`,
  `CREATE INDEX IF NOT EXISTS idx_flow_version_state ON flow_version(state)`,

  // --- Flow execution ---
  `CREATE TABLE IF NOT EXISTS flow_run (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
    flow_version_id TEXT NOT NULL REFERENCES flow_version(id),
    project_id TEXT NOT NULL,
    parent_run_id TEXT,
    fail_parent_on_failure INTEGER NOT NULL DEFAULT 0,
    triggered_by TEXT,
    status TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('PRODUCTION', 'TESTING')),
    steps TEXT,
    failed_step TEXT,
    step_name_to_test TEXT,
    execution_config TEXT,
    start_time INTEGER,
    finish_time INTEGER,
    archived_at INTEGER,
    steps_count INTEGER,
    logs_file_id TEXT,
    tags TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flow_run_flow ON flow_run(flow_id)`,
  `CREATE INDEX IF NOT EXISTS idx_flow_run_status ON flow_run(status)`,
  `CREATE INDEX IF NOT EXISTS idx_flow_run_project ON flow_run(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_flow_run_started ON flow_run(start_time)`,
  `CREATE INDEX IF NOT EXISTS idx_flow_run_parent ON flow_run(parent_run_id)`,

  // Durable effect identity and dispatch fence, independent of run-log uploads.
  `CREATE TABLE IF NOT EXISTS workflow_effect (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES flow_run(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    approval_id TEXT,
    waitpoint_id TEXT,
    record TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_effect_run ON workflow_effect(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_effect_pending ON workflow_effect(status)`,

  // --- Credentials per piece (OAuth tokens, API keys, etc.) ---
  // Sensitive `value` is stored as JSON; encryption-at-rest via the keychain
  // is layered in at the repository level (Phase 2 step 15).
  `CREATE TABLE IF NOT EXISTS app_connection (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    type TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('PROJECT', 'PLATFORM')),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'MISSING', 'ERROR')),
    piece_name TEXT NOT NULL,
    piece_version TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_id TEXT,
    value TEXT NOT NULL,
    metadata TEXT,
    pre_select_for_new_projects INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_app_connection_project ON app_connection(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_app_connection_piece ON app_connection(piece_name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_app_connection_external ON app_connection(project_id, piece_name, external_id)`, // expand-contract-ok: base-schema index (created with the table)

  // --- Trigger events: webhook payloads, polling captures, event-bus emissions awaiting flow execution ---
  `CREATE TABLE IF NOT EXISTS trigger_event (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    source_name TEXT,
    consumed INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trigger_event_flow ON trigger_event(flow_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trigger_event_consumed ON trigger_event(consumed, created)`,

  // --- Key-value store used by the activepieces 'store' core piece ---
  `CREATE TABLE IF NOT EXISTS store_entry (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_store_entry_project_key ON store_entry(project_id, key)`, // expand-contract-ok: base-schema index (created with the table)

  // --- Files passed between steps (file-helper, image-helper, etc.) ---
  `CREATE TABLE IF NOT EXISTS workflow_file (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    flow_id TEXT,
    type TEXT NOT NULL,
    file_name TEXT,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    metadata TEXT,
    created INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_file_project ON workflow_file(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_file_flow ON workflow_file(flow_id)`,

  // --- Async pause for flows that called context.run.createWaitpoint(). The
  // engine returns the resumeUrl; when something hits that URL (timer or
  // webhook), we resume the run via RUN_FLOW(executionType=RESUME). ---
  `CREATE TABLE IF NOT EXISTS waitpoint (
    id TEXT PRIMARY KEY,
    flow_run_id TEXT NOT NULL REFERENCES flow_run(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    step_name TEXT NOT NULL,
    type TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT 'V1',
    resume_date_time TEXT,
    response_to_send TEXT,
    worker_handler_id TEXT,
    http_request_id TEXT,
    created INTEGER NOT NULL,
    resumed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_waitpoint_run_step ON waitpoint(flow_run_id, step_name)`,

  // --- In-process job queue (replaces BullMQ/Redis). Workers claim rows by
  // atomic UPDATE WHERE status='QUEUED' AND scheduled_at <= now. ---
  `CREATE TABLE IF NOT EXISTS workflow_job (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    flow_run_id TEXT,
    flow_id TEXT,
    flow_version_id TEXT,
    payload TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    locked_until INTEGER,
    scheduled_at INTEGER NOT NULL,
    last_error TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_job_claim ON workflow_job(status, scheduled_at, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_job_flow_run ON workflow_job(flow_run_id)`,

  // --- Editor-only sidecar for flow_version: stores node x/y positions and
  // any "orphan" steps the user dragged onto the canvas but didn't connect.
  // The engine never reads this -- it serializes/runs only the tree rooted
  // at flow_version.trigger. Keeping orphans + positions here means the
  // visual editor can survive reloads without polluting the executable
  // schema. Cascaded DELETE on flow_version removes the sidecar too. ---
  `CREATE TABLE IF NOT EXISTS flow_version_ui_meta (
    version_id TEXT PRIMARY KEY REFERENCES flow_version(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  )`,
];

/** Apply the schema to a fresh or existing database. Idempotent. */
export function createSchema(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  for (const stmt of STATEMENTS) db.exec(stmt);
  applyAdditiveColumnMigrations(db);
}

/**
 * Add columns that were introduced after the initial CREATE TABLE definition
 * for tables that already exist on disk. SQLite has no `ALTER TABLE ADD
 * COLUMN IF NOT EXISTS`, so we shell-check via `PRAGMA table_info` and only
 * issue the ALTER when the column is missing. Each entry is idempotent and
 * safe on fresh databases (where the column already exists from CREATE).
 */
function applyAdditiveColumnMigrations(db: Database): void {
  type ColMigration = { table: string; column: string; ddl: string };
  const migrations: ColMigration[] = [
    { table: "flow_run", column: "execution_config", ddl: "ALTER TABLE flow_run ADD COLUMN execution_config TEXT" },
    { table: "flow_version", column: "engine_listeners", ddl: "ALTER TABLE flow_version ADD COLUMN engine_listeners TEXT" },
    { table: "flow_version", column: "engine_schedule", ddl: "ALTER TABLE flow_version ADD COLUMN engine_schedule TEXT" },
    // sample_data: JSON map { [stepName]: sampleOutput } fed to the engine
    // when running with stepNameToTest so preceding steps' outputs are
    // populated. Editable per-step in the visual editor; NULL means "use the
    // piece's intrinsic sampleData."
    { table: "flow_version", column: "sample_data", ddl: "ALTER TABLE flow_version ADD COLUMN sample_data TEXT" },
    // sample_input: JSON map { [stepName]: inputOverride } applied by
    // the engine ONLY during test-from-here runs (stepNameToTest set).
    // The override replaces that step's `settings.input` so the user can
    // exercise a step manually with curated parameters without
    // re-editing the production input. Production runs ignore this map.
    { table: "flow_version", column: "sample_input", ddl: "ALTER TABLE flow_version ADD COLUMN sample_input TEXT" },
    // code_steps_*: per-flow opt-in for CODE steps (see the flow table above).
    // The grant defaults to OFF, so a flow authored after this version has to
    // be opted in explicitly before it can publish.
    {
      table: "flow",
      column: "code_steps_enabled",
      ddl: "ALTER TABLE flow ADD COLUMN code_steps_enabled INTEGER NOT NULL DEFAULT 0",
    },
    { table: "flow", column: "code_steps_grant", ddl: "ALTER TABLE flow ADD COLUMN code_steps_grant TEXT" },
    { table: "flow", column: "code_steps_granted_at", ddl: "ALTER TABLE flow ADD COLUMN code_steps_granted_at INTEGER" },
  ];
  const added = new Set<string>();
  for (const m of migrations) {
    const cols = db.query(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === m.column)) continue;
    db.exec(m.ddl);
    added.add(`${m.table}.${m.column}`);
  }
  // Data backfills run after ALL the ALTERs, never inline with one of them:
  // this one writes three columns and would fail if it ran between two.
  //
  // It fires only when THIS boot introduced the gate's columns, which can only
  // happen on a database that predates them. A fresh database gets them from
  // CREATE TABLE, adds nothing, and never backfills -- right, since it has no
  // flows that predate the gate. Any of the three counts, so a boot that died
  // between two ALTERs still backfills on its next attempt.
  const gateColumns = ["code_steps_enabled", "code_steps_grant", "code_steps_granted_at"];
  if (gateColumns.some((column) => added.has(`flow.${column}`))) grandfatherRunningCodeFlows(db);
}

/**
 * One-time grandfathering for the CODE-step gate.
 *
 * Refusing at publish is the right place for a flow someone is authoring, but
 * a version bump is not an authoring moment: an automation that has been
 * running a CODE step on a cron for months must not stop because the daemon
 * restarted on a newer build, and the user must not silently acquire the new
 * permission on flows that never used it.
 *
 * So the grant is written only for flows that are runnable RIGHT NOW (ENABLED,
 * or carrying a published version) whose runnable version actually contains a
 * CODE step -- the exact set that would otherwise break -- and it is stamped
 * `upgrade` so the dashboard can say the permission was inherited and the user
 * can revoke it. Every other flow, including one holding an unpublished CODE
 * draft, starts at OFF and has to be opted in.
 *
 * `updated` is deliberately NOT touched: the workflows list orders by
 * `flow.updated DESC`, and reshuffling someone's list on an upgrade would be a
 * visible side effect of a migration that is supposed to change nothing.
 */
function grandfatherRunningCodeFlows(db: Database): void {
  const candidates = db
    .query<{ id: string; version_id: string | null }, []>(
      `SELECT f.id AS id,
              COALESCE(f.published_version_id,
                       (SELECT v.id FROM flow_version v
                         WHERE v.flow_id = f.id AND v.state = 'DRAFT'
                         ORDER BY v.updated DESC LIMIT 1)) AS version_id
         FROM flow f
        WHERE f.status = 'ENABLED' OR f.published_version_id IS NOT NULL`,
    )
    .all();
  const at = Date.now();
  for (const candidate of candidates) {
    if (!candidate.version_id) continue;
    const row = db
      .query<{ trigger: string }, [string]>(`SELECT trigger FROM flow_version WHERE id = ?`)
      .get(candidate.version_id);
    if (!row) continue;
    let trigger: FlowTriggerNode | null = null;
    try {
      trigger = JSON.parse(row.trigger) as FlowTriggerNode;
    } catch {
      // An unparseable trigger cannot be shown to contain a CODE step, and a
      // migration is the wrong place to fail a boot over one bad row.
      continue;
    }
    if (!hasCodeStep(trigger)) continue;
    db.run(`UPDATE flow SET code_steps_enabled = 1, code_steps_grant = 'upgrade', code_steps_granted_at = ? WHERE id = ?`, [
      at,
      candidate.id,
    ]);
  }
}
