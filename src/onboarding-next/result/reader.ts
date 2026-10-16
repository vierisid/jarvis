import type { Database } from 'bun:sqlite';
import { getWorkflowDb } from '../../workflows/db';
import { getFlowInProject } from '../../workflows/db/repos/flow';
import { getFlowVersion, getLatestDraft } from '../../workflows/db/repos/flow-version';
import { versionReadiness } from '../../workflows/db/repos/flow-readiness';
import { hash, id, nodeId, object, scopeId } from './input';
import { ResultError, type Issue, type Reader } from './types';

const bounded = <T extends Issue>(i: T): T => ({ ...i, node: i.node.slice(0, 120), path: i.path.slice(0, 512), message: i.message.slice(0, 512) });
function nodes(graph: unknown): string[] {
  const names = new Set<string>(), stack = [graph];
  while (stack.length) {
    const node = stack.pop();
    if (!object(node) || !nodeId(node.name) || typeof node.type !== 'string' || names.has(node.name) || names.size >= 100) throw new ResultError('invalid_graph');
    names.add(node.name);
    for (const k of ['nextAction', 'firstLoopAction']) if (node[k] != null) stack.push(node[k]);
    if (node.children != null) {
      if (!Array.isArray(node.children) || node.children.length > 100) throw new ResultError('invalid_graph');
      stack.push(...node.children.filter((x: unknown) => x != null));
    }
  }
  return [...names];
}
/** No migrations or writes. The host must provision B09's durable receipt store. */
export function createSqliteResultReader(db: Database): Reader {
  const current = () => { if (getWorkflowDb() !== db) throw new ResultError('binding_missing'); };
  return { current, read(owner, job) {
    current();
    try {
      return db.transaction(() => {
        const r = db.query<{ digest: string; composition_id: string | null; flow_id: string | null; version_id: string | null }, [string, string, string]>(
          'SELECT digest, composition_id, flow_id, version_id FROM onboarding_draft_receipt WHERE actor_id = ? AND project_id = ? AND request_id = ?'
        ).get(owner.actorId, owner.projectId, job.requestId);
        if (!r) return { state: 'absent' as const };
        if (r.digest !== job.requestDigest) throw new ResultError('identity_mismatch');
        if (!r.flow_id && !r.version_id) return { state: 'pending' as const };
        if (![r.flow_id, r.version_id, r.composition_id].every(id)) throw new ResultError('incomplete_result');
        const flow = getFlowInProject(owner.projectId, r.flow_id!);
        const version = getFlowVersion(r.version_id!);
        const composition = db.query<{ state: string }, [string, string]>(
          'SELECT state FROM workflow_composition WHERE id = ? AND project_id = ?').get(r.composition_id!, owner.projectId);
        if (!flow || !version || version.flowId !== flow.id || composition?.state !== 'VALIDATED'
          || JSON.parse(flow.metadata ?? '{}').compositionRecordId !== r.composition_id) throw new ResultError('artifact_unavailable');
        if (flow.status !== 'DISABLED' || flow.published_version_id !== null) throw new ResultError('activation_changed');
        if (version.state !== 'DRAFT' || getLatestDraft(flow.id)?.id !== version.id) throw new ResultError('version_changed');
        const nodeIds = nodes(version.trigger);
        const readiness = versionReadiness(flow.id, version.id);
        const issues = readiness.issues.map(bounded);
        return { state: 'saved' as const,
          artifact: { scopeId: scopeId(owner), requestId: job.requestId, requestDigest: r.digest,
            compositionRecordId: r.composition_id!, flowId: flow.id, versionId: version.id },
          contentRevision: hash([version.id, version.displayName, version.trigger, version.state]),
          title: version.displayName, graph: structuredClone(version.trigger) as unknown as Record<string, unknown>, nodeIds,
          activation: 'disabled' as const, versionState: 'DRAFT' as const,
          readiness: { ready: readiness.ready, issues, runtimeChecks: readiness.runtimeChecks.map(bounded) },
          missingBindings: issues.filter(i => /CONNECTION|BINDING|INPUT|REQUIRED/.test(i.code)),
        };
      })();
    } catch (e) { throw e instanceof ResultError ? e : new ResultError('storage_unavailable'); }
  } };
}
