/**
 * Runtime half of the managed-connection rule: a `jarvis:` credential goes
 * only to a run whose own graph names it as the auth of a step of the
 * source's pieces, and nowhere else. Readiness refuses the same graphs; this
 * is the check for a graph that never went through readiness.
 *
 * The engine's credential fetch says neither which step asks nor for which
 * piece, so the route cannot trust a claim from it. It reads the graph the run
 * executes instead (the run's version with its frozen sample input overrides,
 * the same tree the worker sends the engine, refused when it is no longer the
 * graph the run began on) and finds every place a step
 * would make the engine fetch this connection, by the engine's own parsing of
 * `{{connections...}}`. One reference outside a matching step's `auth` refuses
 * the whole run, because the route cannot tell which step is asking.
 */

import { getWorkflowDb } from '../index';
import { applyInputOverrides, walkFlowNodes } from '../flow-graph';
import type { FlowTriggerNode } from './flow-version';
import type { RunExecutionConfig } from './flow-run';
import { managedConnectionMisuse, type JarvisConnectionSource } from '../../credentials/adapter';
import { hookTriggerDigest, parseTriggerHookRunId } from '../../runner/triggers/hook-run-id';
import { graphDigest } from '../../runtime/continuation';
import { nodeConnectionReferences } from './binding-pins';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The connection the engine would fetch for one `{{...}}` body, by the parse in
 * the vendored engine's props-resolver: a body starting with `connections`
 * names the first `['...']` when it has a bracket, else the second dot segment.
 */
function engineConnectionName(body: string): string | null {
  if (!body.startsWith('connections')) return null;
  if (body.includes('[')) return /\['([^']+)'\]/.exec(body)?.[1] ?? null;
  return body.split('.')[1] ?? null;
}

/** Every place in one step's settings that makes the engine fetch `externalId`, with whether it is exactly a whole-value binding. */
function references(node: FlowTriggerNode, externalId: string): Array<{ path: string; exact: boolean }> {
  const out: Array<{ path: string; exact: boolean }> = [];
  const pending: Array<[unknown, string]> = [[node.settings, 'settings']];
  for (let visits = 0; pending.length; visits++) {
    // A graph too large to read fully is not one this route can vouch for.
    if (visits >= 20_000) { out.push({ path: 'settings', exact: false }); break; }
    const [value, path] = pending.pop()!;
    if (typeof value === 'string') {
      for (const [whole, body] of value.matchAll(/\{\{(.*?)\}\}/g)) {
        // Any other body is evaluated as an expression over step outputs,
        // which never fetches a connection.
        if (engineConnectionName(body!) === externalId) out.push({ path, exact: whole === value && (body === `connections.${externalId}` || body === `connections['${externalId}']`) });
      }
    } else if (Array.isArray(value) || object(value)) {
      for (const [key, child] of Object.entries(value)) pending.push([child, `${path}.${key}`]);
    }
  }
  return out;
}

/** Why these steps may not be handed `externalId`, or null when at least one names it and every one is a matching step's auth. */
function graphRefusal(nodes: FlowTriggerNode[], externalId: string, source: JarvisConnectionSource): string | null {
  let named = 0;
  for (const node of nodes) {
    const piece = node.type === 'PIECE' || node.type === 'PIECE_TRIGGER' ? String(node.settings?.pieceName ?? '') : '';
    for (const reference of references(node, externalId)) {
      named++;
      const misuse = managedConnectionMisuse(source, piece, reference.path, node.settings)
        ?? (reference.exact ? null : `Managed connection jarvis:${source.id} must be the whole auth value`);
      if (misuse) return `${misuse}; step ${String(node.name)} names it at ${reference.path}`;
    }
  }
  return named ? null : `No step of this run names ${externalId} as its auth`;
}

function parse(json: string | null): unknown {
  if (json === null) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * The graph the engine of `runId` executes, or why there is none it may be
 * handed a connection for. A run is checked on the graph it began on: the
 * RUN_FLOW handler records that graph's digest before the engine starts, and
 * a draft edited since (or a run with no digest) is refused; its frozen sample
 * input overrides are applied, as the worker applies them. A trigger hook
 * (enable, disable, poll) has no run row and runs only the trigger of the one
 * version its run id names, so that trigger, unchanged since the hook was
 * handed it, is the whole graph. Anything else that is not a run of this
 * project has none.
 */
function engineGraph(runId: string, projectId: string, opts: { undigested?: 'refuse' | 'current' } = {}): { nodes: FlowTriggerNode[] } | { refusal: string } {
  const db = getWorkflowDb();
  const run = db.query<{ project_id: string; trigger: string | null; execution_config: string | null; graph_digest: string | null }, [string]>(
    `SELECT r.project_id, v.trigger, r.execution_config, r.graph_digest FROM flow_run r
      LEFT JOIN flow_version v ON v.id = r.flow_version_id WHERE r.id = ?`,
  ).get(runId);
  if (run) {
    if (run.project_id !== projectId) return { refusal: 'This run belongs to another project' };
    const trigger = parse(run.trigger);
    if (!object(trigger)) return { refusal: 'This run has no readable workflow graph' };
    // The engine was handed the graph as it was when the run began; a draft
    // can be edited while a test run of it is going.
    // A run created before the digest was recorded (#806) resumes on its
    // version as it is (runner/handler.ts); `current` judges it on that.
    const undigested = !run.graph_digest && opts.undigested === 'current';
    if (!undigested && (!run.graph_digest || run.graph_digest !== graphDigest(trigger))) return { refusal: 'This run\'s workflow graph changed after it began' };
    const overrides = (parse(run.execution_config) as RunExecutionConfig | null)?.sampleInputOverride;
    const effective = overrides && Object.keys(overrides).length
      ? applyInputOverrides(trigger as unknown as FlowTriggerNode, overrides)
      : trigger as unknown as FlowTriggerNode;
    return { nodes: walkFlowNodes(effective) };
  }
  const hook = parseTriggerHookRunId(runId);
  if (hook) {
    const version = db.query<{ trigger: string | null }, [string, string, string]>(
      'SELECT v.trigger FROM flow_version v JOIN flow f ON f.id = v.flow_id WHERE v.id = ? AND f.id = ? AND f.project_id = ?',
    ).get(hook.versionId, hook.flowId, projectId);
    if (!version) return { refusal: 'This trigger hook does not run a workflow of this project' };
    const trigger = parse(version.trigger);
    if (!object(trigger)) return { refusal: 'This trigger hook has no readable trigger' };
    if (hookTriggerDigest(trigger) !== hook.triggerDigest) return { refusal: 'This workflow\'s trigger changed after the trigger hook began' };
    return { nodes: [trigger as unknown as FlowTriggerNode] };
  }
  return { refusal: 'This engine is not running a workflow of this project' };
}

/**
 * Why the engine of `runId` may not be handed managed connection
 * `externalId`, or null when it may: the graph it executes (`engineGraph`)
 * must name it, as the auth of a matching step only.
 */
export function managedConnectionScopeRefusal(runId: string, projectId: string, externalId: string, source: JarvisConnectionSource): string | null {
  const graph = engineGraph(runId, projectId);
  return 'refusal' in graph ? graph.refusal : graphRefusal(graph.nodes, externalId, source);
}

/**
 * #1153: why the engine of `runId` may not be handed STORED connection
 * `externalId`, or null when it may. The engine's connection route hands a
 * credential to whatever asks with the run's token, piece code included, so
 * without this a step (or a trigger hook, or a piece loaded for its metadata)
 * could fetch any account in the project by id. The graph it executes must
 * name the connection: a `{{connections...}}` anywhere in a step's settings,
 * as the engine parses it, or a Jarvis step's account field
 * (`nodeConnectionReferences`).
 */
export function storedConnectionScopeRefusal(runId: string, projectId: string, externalId: string): string | null {
  const graph = engineGraph(runId, projectId, { undigested: 'current' });
  const why = 'refusal' in graph ? graph.refusal
    : graph.nodes.some((node) => references(node, externalId).length > 0 || nodeConnectionReferences(node).some(([id]) => id === externalId))
      ? null : 'no step of the workflow it runs names it';
  return why === null ? null : `Connection ${externalId} was not handed out: ${why}. Choose it as the account of a step in the workflow, then start a new run.`;
}
