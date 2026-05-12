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

export function upsertFlowVersionUiMeta(versionId: string, meta: FlowVersionUiMeta): void {
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
