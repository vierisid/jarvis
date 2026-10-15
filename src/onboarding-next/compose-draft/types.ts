import type { ComposeDeps } from '../../actions/tools/workflow-composer';
import type { WorkflowReadiness } from '../../workflows/runtime/workflow-readiness';
import type { DraftStore } from './store';

// Structural handoff projections: no import from an optional onboarding sibling.
export type Scope = Readonly<{ actorId: string; projectId: string }>;
export interface ContextRef { kind: string; id: string }
export interface Submission {
  action: 'create';
  request: { schemaVersion: 1; requestId: string; intentVersion: 1; prompt: string; contextRefs: ContextRef[] };
  answers: Record<string, string>;
}
export interface Qualification {
  id: string; kind: 'detail' | 'connection'; label: string; message: string;
  code: 'missing_detail' | 'missing_context' | 'missing_connection' | 'unsupported_node' | 'placeholder'; blocking: boolean;
}
export interface Intent {
  schemaVersion: 1; intentVersion: 1; scopeId: string; intentId: string; requestDigest: string;
  request: Submission['request']; answers: Submission['answers'];
  references: { scopeId: string; ref: ContextRef; revision: string }[];
  qualifications: Qualification[];
  creationPolicy: { artifact: 'disabled_draft'; publish: false; enable: false; run: false; grantTools: false; linkGoal: false };
}
export interface DraftInput { schemaVersion: 1; intentId: string; submission: Submission }
export interface Artifact {
  scopeId: string; requestId: string; requestDigest: string;
  flowId: string; versionId: string; compositionRecordId: string;
}
export type DraftResult = {
  /** Historical journal validation, not a claim about subsequent editor changes. Readiness is current. */
  availability: 'ready'; state: 'saved'; artifact: Artifact; compositionValidated: true;
  flowStatus: 'ENABLED' | 'DISABLED'; versionState: 'DRAFT' | 'LOCKED';
  readiness: WorkflowReadiness; qualifications: Qualification[];
} | { availability: 'ready'; state: 'absent' | 'pending'; compositionRecordId: string | null }
  | { availability: 'unsupported' | 'unavailable'; reason: Reason };
export type Reason = 'disabled' | 'invalid_request' | 'unauthorized' | 'binding_missing' | 'conflict'
  | 'intent_changed' | 'needs_input' | 'composition_failed' | 'storage_unavailable' | 'service_unavailable'
  | 'cancelled' | 'claim_lost' | 'artifact_unavailable';
export interface DraftServices {
  /** Immutable binding generation, changes with backing vault/account/services. */
  id: string;
  store: DraftStore;
  access(signal?: AbortSignal): Promise<boolean>;
  /** Re-run B07 (or the same verified service contract) under current scope. No serialized intent is a grant. */
  validate(submission: Submission, signal?: AbortSignal): Promise<{
    availability: string; state?: string; intent?: Intent | null;
  }>;
  /** Authorized canonical readers, metadata/content only. Never fetch caller URLs or execute tools. */
  resolveContext(intent: Intent, signal?: AbortSignal): Promise<Record<string, unknown>>;
  /** Existing configured model, catalog, tool schemas, roles and Q policy. No production defaults. */
  composer(): ComposeDeps;
}
export interface DraftDependencies<C> {
  enabled?: boolean;
  authorize(context: C): Scope | null | Promise<Scope | null>;
  servicesFor(scope: Scope, context: C): DraftServices | null;
}
export interface CommitControl {
  signal?: AbortSignal;
  /** B08's synchronous durable worker-claim/cancel fence, checked inside the save transaction.
   * It must read the same SQLite database; no awaits or side effects. */
  mayCommit(): boolean;
}
export class DraftError extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
