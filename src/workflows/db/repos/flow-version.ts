/**
 * `flow_version` repository. A version is a snapshot of a flow's executable
 * shape: the trigger node and its action subtree, stored as a JSON blob in
 * `trigger`. Versions in `DRAFT` state can be edited; once `LOCKED` they are
 * immutable and become eligible to be set as a flow's `published_version_id`.
 *
 * Lifecycle: createDraftVersion -> updateDraft (n times) -> lockVersion ->
 * (the caller wires it as the flow's published_version_id).
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb } from "../index";
import { FlowVersionRequestError } from "./flow-version-ownership";
import { apId } from "../ids";
import { touchFlow } from "./flow";
import { assertLiveDraftReady, graphReadiness } from './flow-readiness';
import { assertCodeStepsAllowedForLiveDraft } from "./flow-code-steps";

export type FlowVersionState = "DRAFT" | "LOCKED";

export interface FlowVersionRow {
  id: string;
  flow_id: string;
  display_name: string;
  trigger: string;
  state: FlowVersionState;
  valid: number;
  schema_version: string | null;
  updated_by: string | null;
  agent_ids: string;
  connection_ids: string;
  notes: string;
  backup_files: string | null;
  engine_listeners: string | null;
  engine_schedule: string | null;
  sample_data: string | null;
  sample_input: string | null;
  created: number;
  updated: number;
}

/** Webhook listener registered by a piece's `app.createListeners`. */
export interface AppEventListener {
  events: string[];
  identifierValue: string;
}

/** Polling-trigger schedule set by a piece's `setSchedule`. */
export interface EngineScheduleOptions {
  cronExpression: string;
  timezone?: string;
}

export interface FlowVersion {
  id: string;
  flowId: string;
  displayName: string;
  trigger: FlowTriggerNode;
  state: FlowVersionState;
  valid: boolean;
  schemaVersion: string | null;
  updatedBy: string | null;
  agentIds: string[];
  connectionIds: string[];
  notes: unknown[];
  backupFiles: Record<string, string> | null;
  /**
   * Webhook listeners returned by EXECUTE_TRIGGER_HOOK(ON_ENABLE) for
   * webhook-strategy triggers. Empty / null when the trigger is polling-only
   * or hasn't been enabled yet.
   */
  engineListeners: AppEventListener[] | null;
  /**
   * Polling-trigger schedule set by upstream's `setSchedule(...)` during
   * EXECUTE_TRIGGER_HOOK(ON_ENABLE). Null when the trigger is webhook-only or
   * hasn't been enabled yet.
   */
  engineSchedule: EngineScheduleOptions | null;
  /**
   * Per-step sample data fed to the engine when running with
   * `stepNameToTest`. Map `stepName -> output` so preceding steps' outputs
   * are populated for template resolution (`{{ stepName.output.x }}`).
   * Null when never set; the engine falls back to each step's intrinsic
   * `sampleData` from the piece definition.
   *
   * Editable per-step in the visual editor's properties panel.
   */
  sampleData: Record<string, unknown> | null;
  /**
   * Per-step sample INPUT override used ONLY during test-from-here runs.
   * Map `stepName -> input` (an object passed as that step's
   * `settings.input` for the test run). Production runs ignore this
   * field; they use the step's persisted input verbatim.
   *
   * Useful when the user wants to exercise a step manually with
   * curated parameters without rewriting the production-bound input
   * each time -- e.g. testing a "send Telegram" step with a known
   * chat id without breaking the live binding to a trigger field.
   *
   * Editable per-step in the visual editor's properties panel under
   * Advanced settings.
   */
  sampleInput: Record<string, unknown> | null;
  created: number;
  updated: number;
}

/**
 * Structural shape of a trigger node persisted on a flow_version. The
 * `trigger` column stores this as JSON; readers narrow further when they
 * dispatch on `type`. Kept loose intentionally so callers (composer, editor,
 * worker handler) share one nominal type without wrapping every value in
 * `Record<string, unknown>` casts.
 *
 * Includes the executor's control-flow shapes (LOOP_ON_ITEMS subgraph head,
 * ROUTER branch children) so the version repo, composer, editor, and
 * executor all agree on one node type.
 */
export interface FlowTriggerNode {
  name: string;
  type: string;
  displayName?: string;
  settings?: {
    pieceName?: string;
    pieceVersion?: string;
    triggerName?: string;
    actionName?: string;
    input?: Record<string, unknown>;
    /** LOOP_ON_ITEMS: template that resolves to an array. */
    items?: string;
    /** ROUTER: branch definitions; one per index in `children`. */
    branches?: Array<FlowRouterBranch>;
    /** ROUTER: which matched branches to run. */
    executionType?: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH";
    /** CODE: source bundle stored verbatim; engine materializes to disk. */
    sourceCode?: { packageJson: string; code: string };
    /** CODE / PIECE: per-step propertySettings (mostly empty for our pieces). */
    propertySettings?: Record<string, unknown>;
  };
  nextAction?: FlowTriggerNode;
  /** LOOP_ON_ITEMS: head of the inner subgraph executed once per iteration. */
  firstLoopAction?: FlowTriggerNode;
  /** ROUTER: per-branch subgraph head. May contain null for empty branches. */
  children?: Array<FlowTriggerNode | null>;
}

export type FlowRouterBranch =
  | {
      branchType: "CONDITION";
      branchName: string;
      conditions: ReadonlyArray<ReadonlyArray<{
        firstValue: string;
        operator: string;
        secondValue?: string;
        caseSensitive?: boolean;
      }>>;
    }
  | { branchType: "FALLBACK"; branchName: string };

export interface CreateDraftVersionInput {
  flowId: string;
  displayName: string;
  trigger?: FlowTriggerNode | Record<string, unknown>;
  schemaVersion?: string;
  updatedBy?: string | null;
}

/**
 * What a draft patch may change. The set is deliberately smaller than the
 * row (#632).
 *
 * `notes`, `backupFiles` and `updatedBy` were here, and the one caller --
 * `PATCH /api/workflows/:id/versions/:versionId` -- reached them by SPREADING
 * a cast request body, so an API caller could write all three. They are gone
 * from this interface AND from the UPDATE below, so the capability no longer
 * exists at this layer rather than merely being unused by the route. The
 * route's own allowlist is then belt-and-braces instead of the only control.
 *
 *   - `updatedBy` is an attribution column. The route has no caller identity
 *     to put in it, so a caller-supplied value was simply a claim about who
 *     edited someone else's draft. Nothing is substituted: `createDraftVersion`
 *     is also never called with `updatedBy` by any non-test caller, so
 *     `flow_version.updated_by` is already permanently NULL in this product and
 *     this change does not make it so. A server-side constant like "api" would
 *     look like attribution while identifying no principal, which reads as
 *     evidence and is worse than NULL. Real attribution needs the authn the
 *     route module's header says does not exist yet.
 *   - `backupFiles` is a filename -> file-CONTENT map. No in-repo caller writes
 *     it; `runner/engine-runtime/flow-version-adapter.ts` READS it into the
 *     engine operation payload, so a writable one let an API caller stash
 *     arbitrary content under arbitrary filenames in the row that feeds the
 *     engine, bounded only by the request-body cap.
 *   - `notes` is the vendored activepieces canvas-note array, typed
 *     `unknown[]` with no validation, `JSON.parse`d on every
 *     `rowToFlowVersion` and therefore up to 50 times per `listVersions` call.
 *     Our editor keeps its layout in `uiMeta` / `flow_version_ui_meta`
 *     instead. If canvas notes are ever wanted they want their own route with
 *     their own schema, the way `uiMeta` got one.
 *
 * `valid` stays, and stays IGNORED: the UPDATE always recomputes it from
 * `graphReadiness`. It is kept because many callers pass it and dropping it
 * would be churn, not because it does anything -- see the comment at the
 * recomputation. The route does not forward it, for that reason.
 */
export interface UpdateDraftVersionInput {
  displayName?: string;
  trigger?: FlowTriggerNode | Record<string, unknown>;
  /** Accepted and discarded; activation recomputes readiness. */
  valid?: boolean;
  agentIds?: string[];
  connectionIds?: string[];
}

const LATEST_SCHEMA_VERSION = "20"; // matches packages/shared/src/lib/automation/flows/flow-version.ts

function db(): Database {
  return getWorkflowDb();
}

function now(): number {
  return Date.now();
}

function rowToFlowVersion(row: FlowVersionRow): FlowVersion {
  return {
    id: row.id,
    flowId: row.flow_id,
    displayName: row.display_name,
    trigger: JSON.parse(row.trigger) as FlowTriggerNode,
    state: row.state,
    valid: row.valid !== 0,
    schemaVersion: row.schema_version,
    updatedBy: row.updated_by,
    agentIds: JSON.parse(row.agent_ids) as string[],
    connectionIds: JSON.parse(row.connection_ids) as string[],
    notes: JSON.parse(row.notes) as unknown[],
    backupFiles: row.backup_files
      ? (JSON.parse(row.backup_files) as Record<string, string>)
      : null,
    engineListeners: row.engine_listeners
      ? (JSON.parse(row.engine_listeners) as AppEventListener[])
      : null,
    engineSchedule: row.engine_schedule
      ? (JSON.parse(row.engine_schedule) as EngineScheduleOptions)
      : null,
    sampleData: row.sample_data
      ? (JSON.parse(row.sample_data) as Record<string, unknown>)
      : null,
    sampleInput: row.sample_input
      ? (JSON.parse(row.sample_input) as Record<string, unknown>)
      : null,
    created: row.created,
    updated: row.updated,
  };
}

export function createDraftVersion(input: CreateDraftVersionInput): FlowVersion {
  const id = apId();
  const ts = now();
  const trigger = input.trigger ?? {};
  // A new draft becomes the LATEST draft, which is the version an ENABLED
  // flow with nothing published actually runs. See the gate's own comment.
  assertCodeStepsAllowedForLiveDraft(input.flowId, trigger);
  assertLiveDraftReady(input.flowId, trigger);
  db().run(
    `INSERT INTO flow_version (
      id, flow_id, display_name, trigger, state, valid, schema_version, updated_by,
      agent_ids, connection_ids, notes, backup_files, created, updated
    ) VALUES (?, ?, ?, ?, 'DRAFT', 0, ?, ?, '[]', '[]', '[]', NULL, ?, ?)`,
    [
      id,
      input.flowId,
      input.displayName,
      JSON.stringify(trigger),
      input.schemaVersion ?? LATEST_SCHEMA_VERSION,
      input.updatedBy ?? null,
      ts,
      ts,
    ],
  );
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`createDraftVersion: row missing after insert (id=${id})`);
  // Propagate as a flow-level change so the listings page sees the new
  // version (and any displayName attached to it).
  touchFlow(input.flowId);
  return rowToFlowVersion(row);
}

function getFlowVersionRow(id: string): FlowVersionRow | null {
  return db()
    .query<FlowVersionRow, [string]>(`SELECT * FROM flow_version WHERE id = ?`)
    .get(id);
}

export function getFlowVersion(id: string): FlowVersion | null {
  const row = getFlowVersionRow(id);
  return row ? rowToFlowVersion(row) : null;
}

export function getLatestDraft(flowId: string): FlowVersion | null {
  const row = db()
    .query<FlowVersionRow, [string]>(
      `SELECT * FROM flow_version WHERE flow_id = ? AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1`,
    )
    .get(flowId);
  return row ? rowToFlowVersion(row) : null;
}

export function listVersions(flowId: string, limit = 50): FlowVersion[] {
  return db()
    .query<FlowVersionRow, [string, number]>(
      `SELECT * FROM flow_version WHERE flow_id = ? ORDER BY updated DESC LIMIT ?`,
    )
    .all(flowId, limit)
    .map(rowToFlowVersion);
}

export function updateDraftVersion(id: string, patch: UpdateDraftVersionInput): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`updateDraftVersion: not found (id=${id})`);
  if (existing.state === "LOCKED") throw new Error(`updateDraftVersion: cannot modify LOCKED version (id=${id})`);
  // A draft is mutated in place, so writing a CODE step into the draft an
  // ENABLED flow is already running would deploy it without passing publish.
  if (patch.trigger !== undefined) assertCodeStepsAllowedForLiveDraft(existing.flow_id, patch.trigger);
  // Even a rename can make an older draft the latest live version.
  assertLiveDraftReady(existing.flow_id, patch.trigger ?? JSON.parse(existing.trigger));

  const next: FlowVersionRow = {
    ...existing,
    display_name: patch.displayName ?? existing.display_name,
    trigger: patch.trigger ? JSON.stringify(patch.trigger) : existing.trigger,
    // A client-supplied valid=true is not evidence. This is a cached authoring
    // result only; activation always recompiles against current bindings.
    valid: graphReadiness(existing.flow_id, patch.trigger ?? JSON.parse(existing.trigger)).ready ? 1 : 0,
    agent_ids: patch.agentIds ? JSON.stringify(patch.agentIds) : existing.agent_ids,
    connection_ids: patch.connectionIds
      ? JSON.stringify(patch.connectionIds)
      : existing.connection_ids,
    updated: now(),
  };

  // `notes`, `backup_files` and `updated_by` are NOT in this SET list (#632).
  // Leaving them out is the enforcement: a patch cannot write them even if a
  // future caller finds a way to put them on the input object, because no
  // statement here assigns them.
  db().run(
    `UPDATE flow_version SET
      display_name = ?, trigger = ?, valid = ?,
      agent_ids = ?, connection_ids = ?, updated = ?
     WHERE id = ?`,
    [
      next.display_name,
      next.trigger,
      next.valid,
      next.agent_ids,
      next.connection_ids,
      next.updated,
      id,
    ],
  );
  // Bump the parent flow's `updated` timestamp so the workflows-list cache
  // notices the change. Without this, renames + trigger edits made in the
  // editor don't surface in the list until a full reload.
  touchFlow(next.flow_id);
  return rowToFlowVersion(next);
}

/**
 * Persist the engine-managed trigger state returned by EXECUTE_TRIGGER_HOOK
 * (ON_ENABLE / ON_DISABLE). Bypasses the LOCKED-version check because this
 * is daemon-side bookkeeping, not user-edited content -- a published flow
 * has its trigger state populated on enable and cleared on disable. Both
 * fields can be null to clear.
 */
export function setEngineTriggerState(
  id: string,
  patch: { engineListeners?: AppEventListener[] | null; engineSchedule?: EngineScheduleOptions | null },
): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`setEngineTriggerState: not found (id=${id})`);
  const listenersJson =
    patch.engineListeners === undefined
      ? existing.engine_listeners
      : patch.engineListeners
        ? JSON.stringify(patch.engineListeners)
        : null;
  const scheduleJson =
    patch.engineSchedule === undefined
      ? existing.engine_schedule
      : patch.engineSchedule
        ? JSON.stringify(patch.engineSchedule)
        : null;
  const updated = now();
  db().run(
    `UPDATE flow_version SET engine_listeners = ?, engine_schedule = ?, updated = ? WHERE id = ?`,
    [listenersJson, scheduleJson, updated, id],
  );
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`setEngineTriggerState: row missing after update (id=${id})`);
  return rowToFlowVersion(row);
}

/**
 * Ceiling on the WHOLE `sample_data` / `sample_input` map (#635).
 *
 * `SAMPLE_DATA_ENTRY_MAX_BYTES` in `api/routes.ts` has always bounded one
 * fixture and nothing bounded the map, which made the per-entry cap close to
 * useless: 100 entries at the per-entry ceiling is 26,214,400 characters, or
 * about 25 MiB, in a column `rowToFlowVersion` `JSON.parse`s on EVERY version
 * read -- and `listVersions` does up to 50 rows per call. `JSON.parse` measured
 * ~1 ms per MB on this runtime (17.5 ms at 16.5 MB), so that is a ~25 ms parse
 * per row and over a second for one listing.
 *
 * 4,194,304 is 16x the per-entry cap, and it is stated as that relationship on
 * purpose so it cannot be mistaken for a coincidence with
 * `VERSION_WRITE_MAX_BODY_BYTES`'s 4,000,000, which answers a different
 * question. It admits 100 entries of 40 KB each -- 5x the 8.1 KB a realistic
 * Gmail fixture measured -- or 15 entries at the full per-entry ceiling (16
 * would be 4,194,304 characters of VALUES alone, before the keys and
 * punctuation), and costs ~4 ms to parse. The refusal is also ACTIONABLE in a way the version
 * cap's is not: "clear the sample data for steps you are not testing" is
 * something an author can do, where "shrink your step graph" is not. That is
 * what makes a tighter number acceptable here.
 *
 * MEASURED ON THE SERIALIZED MAP, keys included -- `JSON.stringify(map).length`
 * and not the sum of the entries. Only that bounds the key text, and the keys
 * are caller-controlled: `stepName` arrives in a URL path and is never checked
 * against the graph.
 */
export const SAMPLE_DATA_MAP_MAX_BYTES = 4_194_304;

/**
 * Ceiling on the NUMBER of entries in either map (#635).
 *
 * Not "the number of entries that can ever be read" -- that would be a wrong
 * derivation, because nothing ties a key to a node, so a map of 100 junk keys
 * reads none of them. It is the ceiling on the LEGITIMATE population: an entry
 * is keyed by a step name, a graph above 100 nodes can be saved but can never
 * run (`runtime/workflow-readiness.ts` raises a `LIMIT` issue past it and
 * `assertVersionReady` gates publish, enable and run on readiness), so no
 * runnable flow has more than 100 steps to hold fixtures for.
 *
 * It is the count half of a pair. The byte cap above bounds total size; this
 * bounds unbounded ACCUMULATION of entries, which a byte cap alone permits for
 * small values, and the route's own `stepName` length cap bounds each key. All
 * three are needed because `stepName` is unvalidated caller input.
 */
export const SAMPLE_DATA_MAP_MAX_ENTRIES = 100;

/**
 * The map caps, applied to a proposed next map (#635).
 *
 * SHRINKING IS NEVER REFUSED, and the rule is deliberately not "the new total
 * is under the cap". A row written before these caps existed is left alone --
 * no migration, the same rule #609 set for oversized version rows -- so its
 * author must be able to get out from under it, and that means a write that
 * REDUCES the total is allowed even while the total is still over. A rule of
 * "under the cap" would have permitted only deletion, so replacing a 10 MB
 * entry with a 1 KB one would have been refused for making the row smaller.
 */
function sampleMapRefusal(
  column: "sampleData" | "sampleInput",
  next: Record<string, unknown>,
  current: { entries: number; length: number },
): FlowVersionRequestError | null {
  // BOTH dimensions carry the exemption, and the count one is not decoration.
  // Nothing bounded the count before this, and `stepName` is unvalidated caller
  // input, so a row holding 150 entries is reachable. With an unconditional
  // count check, DELETING one of them yields 149, which is still over 100, so
  // every single-entry write to that row -- including a clear -- answered 413
  // and the row could never be shrunk one key at a time. `sampleInput` would
  // have been strictly unrecoverable, because its route family has only a
  // PATCH: there is no `replaceSampleInput` and no DELETE to clear it whole.
  //
  // `>` and not `>=` on the current value, on both dimensions, so that
  // OVERWRITING a key in an over-cap row is allowed too. An overwrite changes
  // neither the count nor necessarily the size, and refusing it would be the
  // same trap one step removed.
  const entries = Object.keys(next).length;
  if (entries > SAMPLE_DATA_MAP_MAX_ENTRIES && entries > current.entries) {
    return new FlowVersionRequestError(
      `${column} would hold ${entries} entries; the limit is ${SAMPLE_DATA_MAP_MAX_ENTRIES}`,
      413,
    );
  }
  const length = entries === 0 ? 0 : JSON.stringify(next).length;
  if (length > SAMPLE_DATA_MAP_MAX_BYTES && length > current.length) {
    return new FlowVersionRequestError(
      `${column} would total ${length} bytes; the limit is ${SAMPLE_DATA_MAP_MAX_BYTES}. `
      + `Clear the sample data for steps you are not testing`,
      413,
    );
  }
  return null;
}

/** What a stored map column currently costs, for the exemption above. */
function sampleMapCurrent(stored: string | null): { entries: number; length: number } {
  if (!stored) return { entries: 0, length: 0 };
  try {
    return { entries: Object.keys(JSON.parse(stored) as Record<string, unknown>).length, length: stored.length };
  } catch {
    // An unreadable column cannot be measured, so it cannot grant an
    // exemption. The caller's own parse would have thrown first anyway.
    return { entries: 0, length: stored.length };
  }
}

/**
 * Update one entry in the per-version `sampleData` map. Editable on
 * DRAFT versions only (locked versions are immutable to user edits).
 * Pass `null` for `output` to remove the step's entry. Returns the updated
 * version.
 *
 * The full-map setter (`replaceSampleData`) below is clear-only in practice;
 * this one is the editor's per-step save path.
 */
export function setSampleDataEntry(
  id: string,
  stepName: string,
  output: unknown | null,
): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`setSampleDataEntry: not found (id=${id})`);
  if (existing.state === "LOCKED") {
    throw new Error(`setSampleDataEntry: version ${id} is LOCKED`);
  }
  const current = existing.sample_data
    ? (JSON.parse(existing.sample_data) as Record<string, unknown>)
    : {};
  if (output === null) {
    delete current[stepName];
  } else {
    current[stepName] = output;
  }
  // The map caps (#635). Checked here and not at the route because
  // `withOwnedFlowVersion` wraps this in one transaction, so the check is
  // atomic with the read-modify-write it guards; a route-level pre-read of the
  // current map would be TOCTOU.
  const refusal = sampleMapRefusal("sampleData", current, sampleMapCurrent(existing.sample_data));
  if (refusal) throw refusal;
  const json = Object.keys(current).length === 0 ? null : JSON.stringify(current);
  const updated = now();
  db().run(`UPDATE flow_version SET sample_data = ?, updated = ? WHERE id = ?`, [
    json,
    updated,
    id,
  ]);
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`setSampleDataEntry: row missing after update (id=${id})`);
  return rowToFlowVersion(row);
}

/**
 * Set / clear one step's entry in the per-version `sampleInput` map.
 * Mirrors `setSampleDataEntry` but writes to the `sample_input` column.
 * Pass `null` to remove the entry. DRAFT-only.
 *
 * The entry is consumed by the engine ONLY during test-from-here runs
 * (`stepNameToTest === stepName`): it replaces that step's
 * `settings.input` for that run. Production runs ignore the map.
 */
export function setSampleInputEntry(
  id: string,
  stepName: string,
  input: Record<string, unknown> | null,
): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`setSampleInputEntry: not found (id=${id})`);
  if (existing.state === "LOCKED") {
    throw new Error(`setSampleInputEntry: version ${id} is LOCKED`);
  }
  const current = existing.sample_input
    ? (JSON.parse(existing.sample_input) as Record<string, unknown>)
    : {};
  if (input === null) {
    delete current[stepName];
  } else {
    current[stepName] = input;
  }
  // Same caps, same reason, same column family as `setSampleDataEntry` (#635).
  const refusal = sampleMapRefusal("sampleInput", current, sampleMapCurrent(existing.sample_input));
  if (refusal) throw refusal;
  const json = Object.keys(current).length === 0 ? null : JSON.stringify(current);
  const updated = now();
  db().run(`UPDATE flow_version SET sample_input = ?, updated = ? WHERE id = ?`, [
    json,
    updated,
    id,
  ]);
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`setSampleInputEntry: row missing after update (id=${id})`);
  return rowToFlowVersion(row);
}

/**
 * Maximum serialized size for a single entry written via
 * `mergeRunOutputsIntoSampleData`. Matches the soft cap used by the
 * per-step PATCH endpoint (`SAMPLE_DATA_ENTRY_MAX_BYTES` in routes.ts) so
 * auto-capture can never produce a sampleData entry the user couldn't
 * have saved by hand. Anything larger is dropped with a warn.
 *
 * KEEP IN SYNC with `SAMPLE_DATA_ENTRY_MAX_BYTES` in `api/routes.ts`. They are
 * independent copies of one number, nothing enforces the equality, and
 * `SAMPLE_DATA_MAP_MAX_BYTES` below states a hard 16x relationship to it -- so
 * if one moves and the other does not, that relationship silently becomes a
 * coincidence.
 */
export const SAMPLE_DATA_AUTO_CAPTURE_MAX_BYTES = 256 * 1024;

/**
 * Merge step outputs from a successful run into the version's sampleData
 * map, but only for cells that are currently empty. Designed to be called
 * after a run finishes SUCCEEDED so the variable picker can offer real
 * field names without the user manually pinning sample data.
 *
 * Skips:
 *   - LOCKED versions (no edits allowed)
 *   - Cells already populated (user-pinned fixtures take precedence)
 *   - Outputs that aren't plain objects (primitives / arrays don't give
 *     the picker top-level keys to surface)
 *   - Outputs whose serialized form exceeds the per-entry cap
 *
 * `runSteps` is `Record<stepName, StepOutput-like>` where each value may
 * be a `{ output: ... }` envelope (the wrapped engine shape) or the bare
 * output (already-unwrapped or user-supplied). We accept either.
 *
 * Returns the names that were actually written so callers can log.
 */
export function mergeRunOutputsIntoSampleData(
  id: string,
  runSteps: Record<string, unknown>,
): { written: string[]; skipped: Array<{ stepName: string; reason: string }> } {
  const existing = getFlowVersionRow(id);
  const written: string[] = [];
  const skipped: Array<{ stepName: string; reason: string }> = [];
  if (!existing) return { written, skipped };
  if (existing.state === "LOCKED") return { written, skipped };

  const current = existing.sample_data
    ? (JSON.parse(existing.sample_data) as Record<string, unknown>)
    : {};
  let mutated = false;
  // What the stored map already costs, plus what each accepted entry adds.
  // No shrink exemption here, unlike `sampleMapRefusal`: auto-capture only ever
  // ADDS entries, so a row already over the cap simply stops growing.
  let total = existing.sample_data?.length ?? 0;

  for (const [stepName, raw] of Object.entries(runSteps)) {
    if (stepName in current) {
      skipped.push({ stepName, reason: "already populated" });
      continue;
    }
    // Pull the inner `output` field if this is a wrapped StepOutput,
    // otherwise treat the value itself as the output (defensive against
    // schema variants).
    const output =
      raw && typeof raw === "object" && !Array.isArray(raw) && "output" in (raw as Record<string, unknown>)
        ? (raw as { output: unknown }).output
        : raw;
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      skipped.push({ stepName, reason: "output not a plain object" });
      continue;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(output);
    } catch (e) {
      skipped.push({ stepName, reason: `serialize failed: ${(e as Error).message}` });
      continue;
    }
    if (serialized.length > SAMPLE_DATA_AUTO_CAPTURE_MAX_BYTES) {
      skipped.push({
        stepName,
        reason: `serialized ${serialized.length}B exceeds ${SAMPLE_DATA_AUTO_CAPTURE_MAX_BYTES}B cap`,
      });
      continue;
    }
    // The MAP caps apply to auto-capture too (#635), and this is the writer
    // that makes them matter: it writes one entry per step of the run in a
    // single call, so a wide flow with large step outputs is how the ~25 MiB
    // map actually gets built. Capping only the hand-edit path would also have
    // falsified this function's own promise above -- that auto-capture can
    // never produce a sampleData entry the user could not have saved by hand.
    //
    // A SKIP rather than a throw, because that is this function's existing
    // contract: the run already SUCCEEDED, capture is best effort, and the
    // caller logs `skipped`. Checked per entry so a full map stops growing
    // instead of discarding the whole capture.
    //
    // The running total is accumulated rather than re-serialized per step: a
    // `JSON.stringify` of the whole candidate map inside the loop would be
    // quadratic, and this path runs after every successful run.
    //
    // The key is measured with `JSON.stringify` and not `stepName.length`, so a
    // key needing escapes is counted at what it actually costs. An appended
    // entry adds the quoted key, a colon, the value and a comma, which is
    // exactly this; the FIRST entry has no comma, so this over-counts by one
    // character there. Over-counting is the safe direction for a cap.
    const entryCost = JSON.stringify(stepName).length + serialized.length + 2;
    if (
      Object.keys(current).length >= SAMPLE_DATA_MAP_MAX_ENTRIES
      || total + entryCost > SAMPLE_DATA_MAP_MAX_BYTES
    ) {
      skipped.push({ stepName, reason: `sampleData map is at its ${SAMPLE_DATA_MAP_MAX_BYTES}-byte / ${SAMPLE_DATA_MAP_MAX_ENTRIES}-entry limit` });
      continue;
    }
    total += entryCost;
    current[stepName] = output;
    written.push(stepName);
    mutated = true;
  }

  if (mutated) {
    const json = Object.keys(current).length === 0 ? null : JSON.stringify(current);
    db().run(`UPDATE flow_version SET sample_data = ?, updated = ? WHERE id = ?`, [
      json,
      now(),
      id,
    ]);
  }
  return { written, skipped };
}

/**
 * Replace the entire sample-data map. Pass `null` to clear. DRAFT-only.
 *
 * CLEAR-ONLY in practice: the single caller is the sample-data DELETE route,
 * which always passes `null`. It still carries the map caps (#635) so that the
 * next caller to pass DATA cannot reopen what the other two writers close --
 * the signature permits a full map and nothing but this check would bound it.
 */
export function replaceSampleData(
  id: string,
  data: Record<string, unknown> | null,
): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`replaceSampleData: not found (id=${id})`);
  if (existing.state === "LOCKED") {
    throw new Error(`replaceSampleData: version ${id} is LOCKED`);
  }
  if (data) {
    const refusal = sampleMapRefusal("sampleData", data, sampleMapCurrent(existing.sample_data));
    if (refusal) throw refusal;
  }
  const json = data && Object.keys(data).length > 0 ? JSON.stringify(data) : null;
  const updated = now();
  db().run(`UPDATE flow_version SET sample_data = ?, updated = ? WHERE id = ?`, [
    json,
    updated,
    id,
  ]);
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`replaceSampleData: row missing after update (id=${id})`);
  return rowToFlowVersion(row);
}

export function lockVersion(id: string): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`lockVersion: not found (id=${id})`);
  if (existing.state === "LOCKED") return rowToFlowVersion(existing);
  db().run(
    `UPDATE flow_version SET state = 'LOCKED', updated = ? WHERE id = ?`,
    [now(), id],
  );
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`lockVersion: row missing after update (id=${id})`);
  return rowToFlowVersion(row);
}
