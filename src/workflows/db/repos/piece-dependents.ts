import { getWorkflowDb } from "../index";
import { walkFlowNodes } from "../flow-graph";
import { forCard } from "../../../util/card-text";
import { plainPieceName } from "../../pieces-library/plain-piece-name";
import type { FlowTriggerNode } from "./flow-version";

/**
 * The enabled workflows that use an installed piece, so uninstalling it can
 * say what it will break, and the workflows that already lost one can say so.
 * Published graphs only (a draft nobody runs is not a dependent); only an
 * enabled workflow counts, since a turned-off one is not running anything.
 */
export interface PieceDependent { id: string; name: string }

const NAMED_MAX = 5;
const NAME_MAX_CHARS = 80;

function parse(trigger: string): FlowTriggerNode | null {
  try { return JSON.parse(trigger) as FlowTriggerNode; } catch { return null; }
}

/** The piece a step needs installed: PIECE and PIECE_TRIGGER steps, but not the engine's built-in manual, schedule and webhook triggers. */
const pieceOf = (node: FlowTriggerNode): string | null => {
  if (node.type !== "PIECE" && node.type !== "PIECE_TRIGGER") return null;
  const name = (node.settings as { pieceName?: unknown } | undefined)?.pieceName;
  return typeof name === "string" && name && name !== "schedule" && name !== "webhook" ? name : null;
};

/** Enabled workflows of this project with a published step from this piece. */
export function enabledWorkflowsUsingPiece(projectId: string, pieceName: string): PieceDependent[] {
  const rows = getWorkflowDb().query<{ id: string; name: string | null; trigger: string }, [string, string]>(
    `SELECT f.id AS id, v.display_name AS name, v.trigger AS trigger FROM flow f
       JOIN flow_version v ON v.id = f.published_version_id
      WHERE f.project_id = ? AND f.status = 'ENABLED' AND instr(v.trigger, ?) > 0 ORDER BY f.created, f.id`,
  ).all(projectId, pieceName);
  const out: PieceDependent[] = [];
  for (const row of rows) {
    const root = parse(row.trigger);
    if (root && [...walkFlowNodes(root)].some((node) => pieceOf(node) === pieceName)) {
      out.push({ id: row.id, name: row.name?.trim() || "Untitled workflow" });
    }
  }
  return out;
}

/** What uninstalling the piece will do, as one plain sentence, or null when no enabled workflow uses it. */
export function uninstallSentence(pieceLabel: string, dependents: readonly PieceDependent[]): string | null {
  if (!dependents.length) return null;
  const shown = dependents.slice(0, NAMED_MAX).map((d) => `"${forCard(d.name, NAME_MAX_CHARS).replace(/"/g, "'")}"`);
  const more = dependents.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  return dependents.length === 1
    ? `${list} uses ${pieceLabel} and stops working until you reinstall it from the Library.`
    : `${list} use ${pieceLabel} and stop working until you reinstall it from the Library.`;
}

/** Published graphs are read only once: a locked version does not change. */
const piecesByVersion = new Map<string, Array<{ pieceName: string; step: string }>>();
const PIECES_CACHE_MAX = 2000;

function stepLabel(node: FlowTriggerNode): string {
  return forCard((typeof node.displayName === "string" && node.displayName.trim()) || String(node.name), NAME_MAX_CHARS);
}

/**
 * Why an enabled workflow cannot run because a piece it uses is not installed
 * any more, or null: the first such step in its published graph. `installed`
 * is the live piece catalog; without one nothing can be said.
 */
export function removedPieceReason(
  flow: { id: string },
  installed: { get(name: string): unknown } | undefined,
): string | null {
  if (!installed) return null;
  const row = getWorkflowDb().query<{ version_id: string; trigger: string }, [string]>(
    `SELECT v.id AS version_id, v.trigger AS trigger FROM flow f JOIN flow_version v ON v.id = f.published_version_id WHERE f.id = ?`,
  ).get(flow.id);
  if (!row) return null;
  let pieces = piecesByVersion.get(row.version_id);
  if (!pieces) {
    const root = parse(row.trigger);
    pieces = root ? [...walkFlowNodes(root)].flatMap((node) => { const name = pieceOf(node); return name ? [{ pieceName: name, step: stepLabel(node) }] : []; }) : [];
    if (piecesByVersion.size >= PIECES_CACHE_MAX) piecesByVersion.clear();
    piecesByVersion.set(row.version_id, pieces);
  }
  for (const { pieceName, step } of pieces) {
    if (!installed.get(pieceName)) return `The step "${step}" uses the ${plainPieceName(pieceName)} piece, which was removed. Reinstall it from the Library.`;
  }
  return null;
}
