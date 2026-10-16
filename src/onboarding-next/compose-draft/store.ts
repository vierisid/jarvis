import type { Database } from 'bun:sqlite';
import { getWorkflowDb } from '../../workflows/db';
import { createFlow, getFlowInProject } from '../../workflows/db/repos/flow';
import { createDraftVersion, getFlowVersion } from '../../workflows/db/repos/flow-version';
import { getWorkflowComposition } from '../../workflows/db/repos/workflow-composition';
import { versionReadiness } from '../../workflows/db/repos/flow-readiness';
import type { ComposedFlow } from '../../actions/tools/workflow-composer';
import { DraftError, type DraftResult, type Qualification, type Scope } from './types';
import { hash, scopeId } from './input';

const boundedIssue = <T extends { node: string; path: string; message: string }>(i: T): T =>
  ({ ...i, node: i.node.slice(0, 120), path: i.path.slice(0, 512), message: i.message.slice(0, 512) });

/** Explicit provisioning only; constructing a provider/store never creates a table. */
export function initializeComposeDraftStore(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS onboarding_draft_receipt (
    actor_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
    digest TEXT NOT NULL, composition_id TEXT, flow_id TEXT, version_id TEXT,
    qualifications TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL,
    PRIMARY KEY (actor_id, project_id, request_id),
    CHECK ((flow_id IS NULL AND version_id IS NULL) OR (flow_id IS NOT NULL AND version_id IS NOT NULL AND composition_id IS NOT NULL))
  )`);
}
interface Receipt {
  digest: string; composition_id: string | null; flow_id: string | null; version_id: string | null; qualifications: string;
}
export function createSqliteDraftStore(db: Database) {
  const current = () => { if (getWorkflowDb() !== db) throw new DraftError('binding_missing'); };
  const row = (scope: Scope, requestId: string, digest: string) => {
    current();
    const receipt = db.query<Receipt, [string, string, string]>(
      'SELECT * FROM onboarding_draft_receipt WHERE actor_id = ? AND project_id = ? AND request_id = ?'
    ).get(scope.actorId, scope.projectId, requestId);
    if (receipt && receipt.digest !== digest) throw new DraftError('conflict');
    return receipt;
  };
  const read = (scope: Scope, requestId: string, digest: string): DraftResult => {
    const r = row(scope, requestId, digest);
    if (!r?.flow_id) return { availability: 'ready', state: r ? 'pending' : 'absent', compositionRecordId: r?.composition_id ?? null };
    const flow = getFlowInProject(scope.projectId, r.flow_id), version = getFlowVersion(r.version_id!);
    const composition = getWorkflowComposition(r.composition_id!, scope.projectId);
    if (!flow || !version || version.flowId !== flow.id || !composition || composition.state !== 'VALIDATED'
      || JSON.parse(flow.metadata ?? '{}').compositionRecordId !== composition.id) throw new DraftError('artifact_unavailable');
    const readiness = versionReadiness(flow.id, version.id);
    return { availability: 'ready', state: 'saved', compositionValidated: true,
      artifact: { scopeId: scopeId(scope), requestId, requestDigest: digest, flowId: flow.id, versionId: version.id, compositionRecordId: composition.id },
      flowStatus: flow.status, versionState: version.state,
      readiness: { ...readiness, issues: readiness.issues.map(boundedIssue), runtimeChecks: readiness.runtimeChecks.map(boundedIssue) },
      qualifications: JSON.parse(r.qualifications) as Qualification[] };
  };
  return {
    current,
    read,
    reserve(scope: Scope, requestId: string, digest: string) {
      current();
      db.transaction(() => {
        row(scope, requestId, digest);
        db.run(`INSERT OR IGNORE INTO onboarding_draft_receipt (actor_id, project_id, request_id, digest, created) VALUES (?, ?, ?, ?, ?)`,
          [scope.actorId, scope.projectId, requestId, digest, Date.now()]);
      }).immediate();
    },
    journal(scope: Scope, requestId: string, digest: string, compositionId: string) {
      if (!row(scope, requestId, digest)) throw new DraftError('storage_unavailable');
      db.run(`UPDATE onboarding_draft_receipt SET composition_id = ? WHERE actor_id = ? AND project_id = ? AND request_id = ? AND flow_id IS NULL`,
        [compositionId, scope.actorId, scope.projectId, requestId]);
    },
    save(scope: Scope, requestId: string, digest: string, compositionId: string, graph: ComposedFlow, qualifications: Qualification[], fence: () => void): DraftResult {
      current();
      db.transaction(() => {
        const receipt = row(scope, requestId, digest);
        if (!receipt) throw new DraftError('storage_unavailable');
        if (receipt.flow_id) return; // Another worker committed. Its exact artifact wins.
        fence();
        const journal = getWorkflowComposition(compositionId, scope.projectId);
        if (!journal || journal.state !== 'VALIDATED') throw new DraftError('composition_failed');
        const flow = createFlow({ projectId: scope.projectId, status: 'DISABLED',
          externalId: `onboarding-${hash([scope.actorId, scope.projectId, requestId])}`,
          metadata: { compositionRecordId: compositionId } });
        const version = createDraftVersion({ flowId: flow.id, displayName: graph.displayName, trigger: graph.trigger });
        db.run(`UPDATE onboarding_draft_receipt SET composition_id = ?, flow_id = ?, version_id = ?, qualifications = ?
          WHERE actor_id = ? AND project_id = ? AND request_id = ?`,
          [compositionId, flow.id, version.id, JSON.stringify(qualifications), scope.actorId, scope.projectId, requestId]);
        // Synchronous cancellation/claim changes during repository hooks still roll back everything.
        fence();
      }).immediate();
      return read(scope, requestId, digest);
    },
  };
}
export type DraftStore = ReturnType<typeof createSqliteDraftStore>;
