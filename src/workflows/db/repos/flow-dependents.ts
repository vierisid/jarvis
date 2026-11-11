import { getWorkflowDb } from "../index";
import { walkFlowNodes } from "../flow-graph";
import { forCard } from "../../../util/card-text";
import { nodeConnectionReferences } from "./binding-pins";
import type { FlowTriggerNode } from "./flow-version";

/**
 * What published workflows lean on, so deleting a workflow or a connection can
 * say who is affected, and so a workflow whose dependency is gone can say what
 * is missing. Read from the published graph only: a draft nobody runs is not
 * a dependent. Nothing here blocks a delete. Every lookup is held to the
 * caller's project, so another project's workflows are never named.
 */
export interface FlowDependent { id: string; name: string }

/** The pieces whose `flow` input names another workflow to call. */
const CALLER_PIECES: ReadonlySet<string> = new Set([
  "@jarvispieces/piece-jarvis-subflow",
  "@jarvispieces/piece-jarvis-trigger",
]);
/** At most this many dependents are named; the rest are only counted. */
export const MAX_NAMED_DEPENDENTS = 20;
/**
 * Names in the sentences below are text people and the model wrote, shown in
 * a confirmation and a chip: `forCard` drops invisible and control characters
 * and collapses line breaks, so a name cannot add a line to the confirmation
 * or reorder what it reads, and this caps each one.
 */
const NAME_MAX = 80;

interface PublishedRow { id: string; name: string | null; trigger: string }

const stepName = (node: FlowTriggerNode): string =>
  forCard((typeof node.displayName === "string" && node.displayName.trim()) || String(node.name), NAME_MAX);

function parse(trigger: string): FlowTriggerNode | null {
  try { return JSON.parse(trigger) as FlowTriggerNode; } catch { return null; }
}

/**
 * Workflow ids called by a step, with the step's shown name. Only a fixed id:
 * a `{{...}}` value is resolved when the step runs, so it names no workflow
 * here (readiness refuses one at activation; an older graph may still hold it).
 */
function calledWorkflows(root: FlowTriggerNode): Array<{ flowId: string; step: string }> {
  const out: Array<{ flowId: string; step: string }> = [];
  for (const node of walkFlowNodes(root)) {
    const settings = node.settings as { pieceName?: unknown; input?: { flow?: unknown } } | undefined;
    if (node.type !== "PIECE" || typeof settings?.pieceName !== "string" || !CALLER_PIECES.has(settings.pieceName)) continue;
    const flow = settings.input?.flow;
    if (typeof flow === "string" && flow.trim() && !flow.includes("{{")) out.push({ flowId: flow.trim(), step: stepName(node) });
  }
  return out;
}

/**
 * Connection external ids bound by a step, with the step's shown name, by the
 * rule readiness, the binding pins and the run's connection scope (#1153)
 * share (`nodeConnectionReferences`): a `{{connections...}}` binding in an
 * input, or a Jarvis step's account field.
 */
function boundConnections(root: FlowTriggerNode): Array<{ externalId: string; step: string }> {
  const out: Array<{ externalId: string; step: string }> = [];
  for (const node of walkFlowNodes(root)) {
    for (const [externalId] of nodeConnectionReferences(node)) out.push({ externalId, step: stepName(node) });
  }
  return out;
}

/** The published graphs of a project's other workflows that could mention `needle`. */
function publishedMentioning(projectId: string, exceptFlowId: string | null, needle: string): PublishedRow[] {
  return getWorkflowDb().query<PublishedRow, [string, string, string]>(
    `SELECT f.id AS id, v.display_name AS name, v.trigger AS trigger FROM flow f
       JOIN flow_version v ON v.id = f.published_version_id
      WHERE f.project_id = ? AND f.id <> ? AND instr(v.trigger, ?) > 0 ORDER BY f.created, f.id`,
  ).all(projectId, exceptFlowId ?? "", needle);
}

function named(rows: PublishedRow[]): FlowDependent[] {
  return rows.map(r => ({ id: r.id, name: r.name?.trim() || "Untitled workflow" }));
}

/** Published workflows with a step that calls this workflow. */
export function workflowsCalling(projectId: string, flowId: string): FlowDependent[] {
  return named(publishedMentioning(projectId, flowId, flowId).filter(row => {
    const root = parse(row.trigger);
    return !!root && calledWorkflows(root).some(c => c.flowId === flowId);
  }));
}

/** Published workflows with a step bound to the connection with this external id. */
export function workflowsUsingConnection(projectId: string, externalId: string): FlowDependent[] {
  return named(publishedMentioning(projectId, null, externalId).filter(row => {
    const root = parse(row.trigger);
    return !!root && boundConnections(root).some(c => c.externalId === externalId);
  }));
}

/**
 * The published workflows that would lose connection `connectionId` of this
 * project, or null when the project has no such connection. Metadata only:
 * the credential is never decrypted, so a connection whose value cannot be
 * read any more can still be previewed and deleted. A workflow binds an
 * external id, not a row, so when another connection of the project keeps
 * that external id the workflows still resolve it and none is named.
 */
export function connectionDependents(projectId: string, connectionId: string): FlowDependent[] | null {
  const db = getWorkflowDb();
  const row = db.query<{ external_id: string }, [string, string]>(
    "SELECT external_id FROM app_connection WHERE id = ? AND project_id = ?",
  ).get(connectionId, projectId);
  if (!row) return null;
  const kept = db.query("SELECT 1 FROM app_connection WHERE project_id = ? AND external_id = ? AND id <> ? LIMIT 1")
    .get(projectId, row.external_id, connectionId);
  return kept ? [] : workflowsUsingConnection(projectId, row.external_id);
}

/**
 * One plain sentence for a founder about the workflows that lean on something
 * they are deleting, or null when none do.
 */
export function dependentsSentence(subject: "workflow" | "connection", dependents: readonly FlowDependent[]): string | null {
  if (!dependents.length) return null;
  const shown = dependents.slice(0, MAX_NAMED_DEPENDENTS).map(d => `"${forCard(d.name, NAME_MAX).replace(/"/g, "'")}"`);
  const more = dependents.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  const one = dependents.length === 1;
  const verb = subject === "workflow" ? (one ? "calls" : "call") : (one ? "uses" : "use");
  return `${list} ${verb} this ${subject} and will need setup.`;
}

/**
 * Why an enabled workflow cannot run because something it uses is gone, or
 * null: a called workflow that no longer exists, a bound connection that no
 * longer exists. Names the step; a deleted workflow's own name is not known.
 * Read for every enabled workflow the list shows, so the graph is parsed only
 * when its text could name a Jarvis step or a connection.
 */
export function missingDependency(flow: { id: string; project_id: string; status: string; published_version_id: string | null }): string | null {
  if (flow.status !== "ENABLED" || !flow.published_version_id) return null;
  const db = getWorkflowDb();
  const row = db.query<{ trigger: string }, [string, string]>(
    `SELECT trigger FROM flow_version WHERE id = ? AND flow_id = ?
       AND (instr(trigger, 'jarvis-') > 0 OR instr(trigger, '{{connections') > 0)`,
  ).get(flow.published_version_id, flow.id);
  const root = row && parse(row.trigger);
  if (!root) return null;
  for (const call of calledWorkflows(root)) {
    if (db.query("SELECT 1 FROM flow WHERE id = ? AND project_id = ?").get(call.flowId, flow.project_id)) continue;
    return `The step "${call.step}" calls a workflow that was deleted. Choose another workflow for it.`;
  }
  for (const bound of boundConnections(root)) {
    if (bound.externalId.startsWith("jarvis:")) continue;
    if (db.query("SELECT 1 FROM app_connection WHERE project_id = ? AND external_id = ? LIMIT 1").get(flow.project_id, bound.externalId)) continue;
    return `The step "${bound.step}" uses the connection "${forCard(bound.externalId, NAME_MAX)}", which was deleted. Connect it again.`;
  }
  return null;
}
