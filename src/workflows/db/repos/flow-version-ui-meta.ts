/**
 * Editor-only sidecar for `flow_version`: stores xyflow node positions and
 * any "orphan" step nodes (pieces the user dropped onto the canvas but
 * didn't connect into the trigger chain).
 *
 * The engine never reads this table. The runtime path serializes / executes
 * only the connected tree rooted at `flow_version.trigger`; orphans + xy
 * coordinates exist purely to make the editing experience survive a reload.
 *
 * Wire format (`data` column, JSON):
 *   {
 *     schema:    1,
 *     positions: { [stepName]: { x: number, y: number } },
 *     orphans:   FlowStepNode[]    // unconnected steps, same shape as connected nodes
 *   }
 *
 * `schema` is reserved for future shape evolution; readers ignore unknown
 * fields and writers always stamp the latest known number. Bump on breaking
 * changes only -- additive fields (e.g. a future `viewport`) don't need it.
 */

import { getWorkflowDb } from "../index";
import { FlowVersionRequestError } from "./flow-version-ownership";

export const UI_META_SCHEMA_VERSION = 1;

export interface NodePosition {
  x: number;
  y: number;
}

/**
 * Editor-side step shape. Mirrors the UI's `FlowStepNode` but kept loose at
 * the repo boundary -- this layer only writes JSON, the editor + engine
 * agree on shape. Storing as `Record<string, unknown>` avoids coupling this
 * repo to the workflow runtime types (which live in a different folder).
 */
export type OrphanNode = Record<string, unknown>;

export interface FlowVersionUiMeta {
  schema: number;
  positions: Record<string, NodePosition>;
  orphans: OrphanNode[];
}

interface UiMetaRow {
  version_id: string;
  data: string;
  updated: number;
}

const EMPTY_META: FlowVersionUiMeta = {
  schema: UI_META_SCHEMA_VERSION,
  positions: {},
  orphans: [],
};

export function getFlowVersionUiMeta(versionId: string): FlowVersionUiMeta {
  const row = getWorkflowDb()
    .query<UiMetaRow, [string]>(`SELECT * FROM flow_version_ui_meta WHERE version_id = ?`)
    .get(versionId);
  if (!row) return { ...EMPTY_META };
  try {
    const parsed = JSON.parse(row.data) as Partial<FlowVersionUiMeta>;
    return {
      schema: typeof parsed.schema === "number" ? parsed.schema : UI_META_SCHEMA_VERSION,
      positions: isPlainObject(parsed.positions) ? (parsed.positions as Record<string, NodePosition>) : {},
      orphans: Array.isArray(parsed.orphans) ? parsed.orphans : [],
    };
  } catch {
    // Corrupt JSON shouldn't break the editor; surface empty defaults and
    // let the next save overwrite with a valid blob.
    return { ...EMPTY_META };
  }
}

/**
 * The refusal for a malformed `uiMeta`, or null (#632).
 *
 * Exported so a ROUTE can ask BEFORE it writes anything else.
 * `POST /api/workflows/:id/versions` calls `createDraftVersion` and then
 * `upsertFlowVersionUiMeta`, with no transaction around the pair -- so once
 * this check started throwing, a malformed `uiMeta` would have created the
 * draft row and THEN answered 400. That is not cosmetic: a new draft becomes
 * the latest draft, which is the version an ENABLED flow with nothing
 * published actually runs, so a refused request would have promoted a live
 * draft. The PATCH sibling is inside `withOwnedFlowVersion`'s transaction and
 * rolls back, but the POST is not, and the route file holds itself to
 * "checked before the transaction" elsewhere for exactly this reason.
 *
 * `upsertFlowVersionUiMeta` still applies it as a backstop, so a caller that
 * forgets cannot store a shape the reader will refuse.
 */
export function uiMetaRefusal(meta: FlowVersionUiMeta): FlowVersionRequestError | null {
  if (meta.positions !== undefined && !isPlainObject(meta.positions)) {
    return new FlowVersionRequestError("uiMeta.positions must be an object of stepName -> {x, y}", 400);
  }
  if (meta.orphans !== undefined && !Array.isArray(meta.orphans)) {
    return new FlowVersionRequestError("uiMeta.orphans must be an array of step nodes", 400);
  }
  return null;
}

/**
 * Write a version's sidecar.
 *
 * The two shape checks are NOT cosmetic and they are not new policy: they are
 * the ones `getFlowVersionUiMeta` above already applies on the way OUT (#632).
 * Both version routes pass `body.uiMeta` through as a CAST of a request body,
 * so before this the write side took `meta.positions ?? {}` on trust and
 * `JSON.stringify`'d whatever arrived -- a string, a number, an array -- into
 * the column, and the read side then silently replaced it with `{}` forever.
 * The asymmetry was the tell: a value the reader refuses to believe has no
 * business being stored. Refusing it here instead means a caller is told,
 * rather than having its layout quietly discarded on the next load.
 */
export function upsertFlowVersionUiMeta(versionId: string, meta: FlowVersionUiMeta): void {
  const refusal = uiMetaRefusal(meta);
  if (refusal) throw refusal;
  const stamped: FlowVersionUiMeta = {
    schema: UI_META_SCHEMA_VERSION,
    positions: meta.positions ?? {},
    orphans: meta.orphans ?? [],
  };
  getWorkflowDb().run(
    `INSERT INTO flow_version_ui_meta (version_id, data, updated)
     VALUES (?, ?, ?)
     ON CONFLICT(version_id) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
    [versionId, JSON.stringify(stamped), Date.now()],
  );
}

/**
 * Copy a version's sidecar onto another version. Used when locking a draft:
 * the published version inherits the draft's layout so the live flow doesn't
 * jump back to auto-layout the first time someone opens it after publish.
 */
export function cloneFlowVersionUiMeta(srcVersionId: string, dstVersionId: string): void {
  const meta = getFlowVersionUiMeta(srcVersionId);
  // Skip the round-trip if there's nothing meaningful to copy; keeps the
  // table from filling with empty rows for flows the user never visually
  // edited.
  if (Object.keys(meta.positions).length === 0 && meta.orphans.length === 0) return;
  upsertFlowVersionUiMeta(dstVersionId, meta);
}

export function deleteFlowVersionUiMeta(versionId: string): void {
  getWorkflowDb().run(`DELETE FROM flow_version_ui_meta WHERE version_id = ?`, [versionId]);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
