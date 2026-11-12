import { getWorkflowDb } from "../index";
import { forCard } from "../../../util/card-text";
import { connectionBindings } from "./binding-pins";

/**
 * The enabled workflows that run on a saved connection, so rotating its key
 * can say what it will stop. Only a published graph counts (a draft nobody
 * runs is not a dependent), only an enabled workflow is affected (a turned-off
 * one accepts the new key when it is turned on), and only the caller's project
 * is read. Metadata and graphs only: the credential is never opened.
 */
export interface ConnectionDependent { id: string; name: string }

/** At most this many names are said in a sentence; the rest are counted. */
const NAMED_MAX = 5;
const NAME_MAX_CHARS = 80;

export function enabledWorkflowsUsingConnection(projectId: string, externalId: string): ConnectionDependent[] {
  const rows = getWorkflowDb().query<{ id: string; name: string | null; trigger: string }, [string, string]>(
    `SELECT f.id AS id, v.display_name AS name, v.trigger AS trigger FROM flow f
       JOIN flow_version v ON v.id = f.published_version_id
      WHERE f.project_id = ? AND f.status = 'ENABLED' AND instr(v.trigger, ?) > 0 ORDER BY f.created, f.id`,
  ).all(projectId, externalId);
  const out: ConnectionDependent[] = [];
  for (const row of rows) {
    let graph: unknown;
    try { graph = JSON.parse(row.trigger); } catch { continue; }
    if (connectionBindings(graph).has(externalId)) out.push({ id: row.id, name: row.name?.trim() || "Untitled workflow" });
  }
  return out;
}

/**
 * What a new key does to these workflows, as one plain sentence, or null when
 * none run on the connection: `before` says what saving will do (the Rotate
 * form), `after` says what it did (the answer to the save and the notice).
 */
export function rotationSentence(dependents: readonly ConnectionDependent[], when: "before" | "after" = "before"): string | null {
  if (!dependents.length) return null;
  const shown = dependents.slice(0, NAMED_MAX).map((d) => `"${forCard(d.name, NAME_MAX_CHARS).replace(/"/g, "'")}"`);
  const more = dependents.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  const one = dependents.length === 1;
  if (when === "after") {
    return one
      ? `${list} uses this connection and is paused until you publish it again to accept the new key.`
      : `${list} use this connection and are paused until you publish each one again to accept the new key.`;
  }
  return one
    ? `${list} uses this connection. If you save a new key, it stops running until you publish it again to accept the new key.`
    : `${list} use this connection. If you save a new key, they stop running until you publish each one again to accept the new key.`;
}
