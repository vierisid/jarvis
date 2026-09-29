import type { Database } from 'bun:sqlite';
import { getWorkflowDb } from '../index';
import { compileWorkflow, type ReadinessContext, type WorkflowReadiness } from '../../runtime/workflow-readiness';
import type { PieceLookup } from '../../runtime/piece-catalog';
import type { CredentialResolver } from '../../credentials/adapter';
import { assertFlowVersionOwnership } from './flow-version-ownership';

interface ReadinessServices { pieces?: PieceLookup; credentials?: CredentialResolver; tool?: ReadinessContext['tool']; roles?: ReadinessContext['roles'] }
// Scoped to the live database, not a process-wide test flag. A missing catalog
// fails closed for piece nodes; primitive/manual graphs need no catalog.
const services = new WeakMap<Database, ReadinessServices>();
export function configureWorkflowReadiness(context: ReadinessServices): void {
  services.set(getWorkflowDb(), context);
}

export class WorkflowReadinessError extends Error {
  readonly code = 'WORKFLOW_NOT_READY';
  readonly status = 422;
  constructor(readonly readiness: WorkflowReadiness) {
    super(readiness.issues.map(i => `${i.node} (${i.path}): ${i.message}`).join('; '));
    this.name = 'WorkflowReadinessError';
  }
}

function contextFor(flowId: string, ancestors: string[] = [], cache = new Map<string, WorkflowReadiness>(), budget = { remaining: 100 }): ReadinessContext {
  const db = getWorkflowDb();
  const configured = services.get(db);
  const flow = db.query<{ project_id: string }, [string]>('SELECT project_id FROM flow WHERE id = ?').get(flowId);
  if (!flow) throw new Error('flow not found');
  return {
    pieces: configured?.pieces,
    tool: configured?.tool,
    roles: configured?.roles,
    connection(externalId, pieceName) {
      if (externalId.startsWith('jarvis:')) {
        return configured?.credentials?.list().some(source => source.canResolve(externalId))
          ? null : 'Managed connection source is unavailable';
      }
      // Metadata only. Preflight never decrypts credentials or refreshes a
      // token inside publication's transaction. Match the engine's piece-less
      // request, then check the chosen piece, rather than selecting a first row.
      const matches = db.query<{ piece_name: string; status: string }, [string, string]>(
        'SELECT piece_name, status FROM app_connection WHERE project_id = ? AND external_id = ? LIMIT 2',
      ).all(flow.project_id, externalId);
      if (matches.length !== 1) return matches.length ? 'Connection external ID is ambiguous in this project' : 'Connection is missing in this project';
      if (matches[0]!.piece_name !== pieceName) return 'Connection belongs to a different piece';
      return matches[0]!.status === 'ACTIVE' ? null : 'Connection is not active';
    },
    workflow(id) {
      if (id === flowId || ancestors.includes(id)) return 'Workflow binding would form a recursive cycle';
      if (ancestors.length >= 16) return 'Nested workflow validation exceeds 16 levels';
      const cached = cache.get(id);
      if (cached) return cached.ready ? null : 'Target workflow is not ready';
      if (--budget.remaining < 0) return 'Nested workflow validation exceeds 100 targets';
      const target = db.query<{ id: string }, [string, string]>(
        'SELECT id FROM flow WHERE id = ? AND project_id = ?',
      ).get(id, flow.project_id);
      if (!target) return 'Select an existing workflow ID in this project';
      const version = db.query<{ trigger: string }, [string]>(
        `SELECT v.trigger FROM flow f JOIN flow_version v ON v.flow_id = f.id AND v.id =
          COALESCE(f.published_version_id, (SELECT id FROM flow_version WHERE flow_id = f.id AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1))
          WHERE f.id = ?`,
      ).get(id);
      if (!version) return 'Target workflow has no executable version';
      let trigger: unknown;
      try { trigger = JSON.parse(version.trigger); } catch { return 'Target workflow graph is unreadable'; }
      const readiness = compileWorkflow(trigger, contextFor(id, [...ancestors, flowId], cache, budget));
      cache.set(id, readiness);
      const first = readiness.issues[0];
      return first ? `Target workflow is not ready: ${first.node} (${first.path}): ${first.message}` : null;
    },
  };
}

export function graphReadiness(flowId: string, trigger: unknown): WorkflowReadiness {
  return compileWorkflow(trigger, contextFor(flowId));
}
export function versionReadiness(flowId: string, versionId: string, preview?: ReadinessContext['preview']): WorkflowReadiness {
  assertFlowVersionOwnership(flowId, versionId);
  const row = getWorkflowDb().query<{ trigger: string }, [string]>('SELECT trigger FROM flow_version WHERE id = ?').get(versionId)!;
  let trigger: unknown;
  try { trigger = JSON.parse(row.trigger); } catch { trigger = null; }
  return compileWorkflow(trigger, { ...contextFor(flowId), preview });
}
export function assertVersionReady(flowId: string, versionId: string, preview?: ReadinessContext['preview']): void {
  const result = versionReadiness(flowId, versionId, preview);
  if (!result.ready) throw new WorkflowReadinessError(result);
}
export function assertFlowReady(flowId: string): void {
  const row = getWorkflowDb().query<{ version_id: string | null }, [string]>(
    `SELECT COALESCE(f.published_version_id, (SELECT id FROM flow_version WHERE flow_id = f.id AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1)) AS version_id FROM flow f WHERE id = ?`,
  ).get(flowId);
  if (!row) throw new Error('flow not found');
  if (!row.version_id) throw new WorkflowReadinessError({ ready: false, runtimeChecks: [], issues: [{ node: 'trigger', path: 'graph', code: 'VERSION', message: 'Create a workflow version before enabling it' }] });
  assertVersionReady(flowId, row.version_id);
}
export function assertLiveDraftReady(flowId: string, trigger: unknown): void {
  const row = getWorkflowDb().query<{ status: string; published_version_id: string | null }, [string]>(
    'SELECT status, published_version_id FROM flow WHERE id = ?',
  ).get(flowId);
  if (row?.status !== 'ENABLED' || row.published_version_id) return;
  const result = graphReadiness(flowId, trigger);
  if (!result.ready) throw new WorkflowReadinessError(result);
}
