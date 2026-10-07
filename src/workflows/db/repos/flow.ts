/**
 * `flow` repository: top-level workflow definitions. A flow's executable shape
 * lives in its `flow_version` rows (see `flow-version.ts`); the `flow` row
 * tracks identity, status, and which version is published.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb, DEFAULT_IDS } from "../index";
import { apId } from "../ids";
import { withOwnedFlowVersion } from "./flow-version-ownership";
import { assertFlowCodeStepsAllowed } from "./flow-code-steps";
import { assertFlowReady, assertVersionReady } from './flow-readiness';
import { pinFlowBindings } from './binding-pins';

export type FlowStatus = "ENABLED" | "DISABLED";

export interface FlowRow {
  id: string;
  external_id: string;
  project_id: string;
  owner_id: string | null;
  folder_id: string | null;
  status: FlowStatus;
  operation_status: string;
  published_version_id: string | null;
  schema_version: string | null;
  template_id: string | null;
  time_saved_per_run: number | null;
  metadata: string | null;
  /** 1 when CODE steps are permitted for this flow. See `flow-code-steps.ts`. */
  code_steps_enabled: number;
  /** Who granted it: `user` (explicit opt-in) or `upgrade` (grandfathered). */
  code_steps_grant: CodeStepsGrant | null;
  code_steps_granted_at: number | null;
  created: number;
  updated: number;
}

/**
 * Provenance of a flow's CODE-step permission.
 *
 * `user` -- somebody turned it on for this flow through
 * `POST /api/workflows/:id/code-steps`.
 *
 * `upgrade` -- the flow was already running a CODE step before the gate
 * existed and the permission was grandfathered on so the automation kept
 * working. Surfaced so the dashboard can say the grant was inherited rather
 * than chosen, and so the user can take it back.
 */
export type CodeStepsGrant = "user" | "upgrade";

export interface CreateFlowInput {
  projectId?: string;
  ownerId?: string | null;
  externalId?: string;
  status?: FlowStatus;
  metadata?: Record<string, unknown> | null;
}

export interface ListFlowsOptions {
  status?: FlowStatus;
  limit?: number;
  offset?: number;
}

function db(): Database {
  return getWorkflowDb();
}

function now(): number {
  return Date.now();
}

export function createFlow(input: CreateFlowInput = {}): FlowRow {
  assertFlowMetadata(input.metadata);
  const id = apId();
  const externalId = input.externalId ?? id;
  const projectId = input.projectId ?? DEFAULT_IDS.project;
  const status: FlowStatus = input.status ?? "DISABLED";
  const ts = now();
  db().run(
    `INSERT INTO flow (id, external_id, project_id, owner_id, status, operation_status, metadata, created, updated)
     VALUES (?, ?, ?, ?, ?, 'NONE', ?, ?, ?)`,
    [
      id,
      externalId,
      projectId,
      input.ownerId ?? null,
      status,
      input.metadata ? JSON.stringify(input.metadata) : null,
      ts,
      ts,
    ],
  );
  const row = getFlow(id);
  if (!row) throw new Error(`createFlow: row missing immediately after insert (id=${id})`);
  // A flow created ENABLED skipped `updateFlowStatus`, so it skipped the CODE
  // gate. It has no versions yet, so there is nothing for the gate to refuse
  // today -- asserting anyway keeps "every path to ENABLED passes the gate"
  // true by construction rather than by the caller happening to be harmless.
  if (status === "ENABLED") assertFlowCodeStepsAllowed(id, "enable");
  return row;
}

export function getFlow(id: string): FlowRow | null {
  return db()
    .query<FlowRow, [string]>(`SELECT * FROM flow WHERE id = ?`)
    .get(id);
}

export function listFlows(
  projectId: string = DEFAULT_IDS.project,
  opts: ListFlowsOptions = {},
): FlowRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  if (opts.status) {
    return db()
      .query<FlowRow, [string, FlowStatus, number, number]>(
        `SELECT * FROM flow WHERE project_id = ? AND status = ? ORDER BY updated DESC LIMIT ? OFFSET ?`,
      )
      .all(projectId, opts.status, limit, offset);
  }
  return db()
    .query<FlowRow, [string, number, number]>(
      `SELECT * FROM flow WHERE project_id = ? ORDER BY updated DESC LIMIT ? OFFSET ?`,
    )
    .all(projectId, limit, offset);
}

export function updateFlowStatus(id: string, status: FlowStatus): void {
  // Enabling is the OTHER way a flow becomes runnable: the trigger manager
  // registers an ENABLED flow's cron / webhook against `published ?? latest
  // draft`, so a flow can start firing on a schedule without ever being
  // published. The CODE gate has to sit here too or it would be one tool call
  // wide. Refusing before the UPDATE keeps the row untouched, and this runs
  // inside `publishFlowVersion`'s transaction when publish is the caller --
  // by which point the same version has already cleared the same check.
  if (status === "ENABLED") assertFlowCodeStepsAllowed(id, "enable");
  // Enabling is a person accepting the flow's current bindings (Q-05), so it
  // pins them instead of comparing against pins taken earlier.
  if (status === 'ENABLED') assertFlowReady(id, { acceptBindings: true });
  const res = db().run(
    `UPDATE flow SET status = ?, updated = ? WHERE id = ?`,
    [status, now(), id],
  );
  if (res.changes === 0) throw new Error(`updateFlowStatus: flow not found (id=${id})`);
  if (status === 'ENABLED') pinFlowBindings(id);
}

/**
 * Set or clear this flow's CODE-step permission. The only writer: the flag is
 * never derived from a request body that also carries other fields, so a
 * generic flow update cannot grant or drop it as a side effect.
 */
export function setFlowCodeStepsEnabled(
  id: string,
  enabled: boolean,
  grant: CodeStepsGrant = "user",
): FlowRow {
  const res = db().run(
    `UPDATE flow SET code_steps_enabled = ?, code_steps_grant = ?, code_steps_granted_at = ?, updated = ?
      WHERE id = ?`,
    [enabled ? 1 : 0, enabled ? grant : null, enabled ? now() : null, now(), id],
  );
  if (res.changes === 0) throw new Error(`setFlowCodeStepsEnabled: flow not found (id=${id})`);
  return getFlow(id)!;
}

/** True when this flow may run CODE steps. */
export function flowCodeStepsEnabled(row: FlowRow): boolean {
  return row.code_steps_enabled === 1;
}

/**
 * Bump a flow row's `updated` timestamp without touching its other columns.
 * Called from `flow-version` mutations so version edits propagate as flow
 * staleness signals -- the workflows list orders by `flow.updated DESC`
 * and the editor's name cache (`useWorkflowsData`) re-fetches displayName
 * only when `flow.updated` advances past the cache entry. Without this,
 * renaming a workflow in the editor leaves the list stale until reload.
 */
export function touchFlow(id: string): void {
  db().run(`UPDATE flow SET updated = ? WHERE id = ?`, [now(), id]);
}

export function setPublishedVersion(id: string, versionId: string | null): void {
  const attach = () => {
    const res = db().run(
      `UPDATE flow SET published_version_id = ?, updated = ? WHERE id = ?`,
      [versionId, now(), id],
    );
    if (res.changes === 0) throw new Error(`setPublishedVersion: flow not found (id=${id})`);
  };
  // Attaching a version to an enabled flow changes what it runs, so it is a
  // person accepting that version's bindings (Q-05): pin them.
  if (versionId === null) db().transaction(() => {
    attach();
    // Clearing a publication on an enabled flow selects its latest draft.
    // Roll back the pointer change if that fallback is not executable.
    if (getFlow(id)?.status === 'ENABLED') { assertFlowReady(id, { acceptBindings: true }); pinFlowBindings(id); }
  })();
  else withOwnedFlowVersion(id, versionId, () => {
    assertVersionReady(id, versionId, undefined, { acceptBindings: true });
    attach();
    if (getFlow(id)?.status === 'ENABLED') pinFlowBindings(id);
  });
}

export function updateFlowMetadata(id: string, metadata: Record<string, unknown> | null): void {
  assertFlowMetadata(metadata);
  const res = db().run(
    `UPDATE flow SET metadata = ?, updated = ? WHERE id = ?`,
    [metadata ? JSON.stringify(metadata) : null, now(), id],
  );
  if (res.changes === 0) throw new Error(`updateFlowMetadata: flow not found (id=${id})`);
}

export function deleteFlow(id: string): void {
  db().run(`DELETE FROM flow WHERE id = ?`, [id]);
}

/**
 * The column's invariant, enforced at the sink rather than trusted (#598).
 *
 * `metadata` reaches a chat prompt through `manage_workflow`'s `summarizeFlow`,
 * the dashboard through the API's `serializeFlow`, and the vendored engine
 * through the sandbox API's flow listing -- and every one of those treats it as
 * an object. #598 refuses a non-object at the two HTTP routes, which is where a
 * caller gets a useful 400; this is the backstop, so a future writer (a restore
 * path, a new route, an eval harness) cannot quietly reintroduce the problem
 * one layer below the validation.
 */
function assertFlowMetadata(metadata: unknown): void {
  if (metadata === null || metadata === undefined) return;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("flow metadata must be a JSON object or null");
  }
}

/**
 * Read `metadata` back, defensively.
 *
 * This used to be a bare `JSON.parse(row.metadata) as Record<string, unknown>`
 * -- an assertion with nothing behind it. Both halves now hold:
 *
 *   - the `try` covers a column that is not valid JSON. Only `JSON.stringify`
 *     has ever written it, so that should be impossible; "should be impossible"
 *     was also the argument for the cast below, and a throw here would take out
 *     every `list` for one bad row.
 *   - a value that parses to something that is NOT a plain object returns null.
 *     #598 caps and type-checks the write path, but rows written before it
 *     exists are deliberately not migrated, so a legacy row can still hold
 *     `"just text"`, `7`, `true` or an array. Returning null turns an
 *     open-ended type confusion into one known-safe value for all three readers
 *     at once, and costs nothing for a correct row.
 */
export function parseFlowMetadata(row: FlowRow): Record<string, unknown> | null {
  if (!row.metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
