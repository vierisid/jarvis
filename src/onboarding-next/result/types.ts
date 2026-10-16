// Structural v1 ports: no optional provider or UI assembly imports.
export type Scope = Readonly<{ actorId: string; projectId: string }>;
export type Outcome = 'queued' | 'working' | 'needs_input' | 'succeeded' | 'failed' | 'cancelled';
export interface Identity {
  scopeId: string; requestId: string; requestDigest: string;
  compositionRecordId: string; flowId: string; versionId: string;
}
export interface Job {
  schemaVersion: 1; scopeId: string; journeyId: string; jobId: string; requestId: string; requestDigest: string;
  revision: number; outcome: Outcome; resolution: 'pending' | 'unknown' | 'none' | 'saved';
  cancellation: 'not_requested' | 'requested' | 'acknowledged'; artifact: Identity | null;
}
export interface Issue { node: string; path: string; code: string; message: string }
export interface Readiness { ready: boolean; issues: Issue[]; runtimeChecks: (Issue & { guard: string })[] }
export interface SavedDraft {
  state: 'saved'; artifact: Identity; contentRevision: string;
  title: string; graph: Record<string, unknown>; nodeIds: string[];
  readiness: Readiness; missingBindings: Issue[];
  activation: 'disabled'; versionState: 'DRAFT';
}
export type ReadInput = { schemaVersion: 1; jobId?: string; requestId?: string; selectedNodeId?: string;
  expected?: { compositionRecordId: string; flowId: string; versionId: string; contentRevision?: string } };
export interface Reader {
  current(): void;
  /** True only inside the journey's transaction on this exact database handle. */
  inTransaction(resource: unknown): boolean;
  /** One consistent, read-only snapshot of the durable receipt AND exact current artifact. */
  read(scope: Scope, job: Job): SavedDraft | { state: 'absent' | 'pending' };
}
export interface Journey {
  schemaVersion: 1; scopeId: string; journeyId: string; revision: number; stepId: string;
  completion: string; jobId: string | null; buildRequestId?: string | null;
  draft: { flowId: string; versionId: string } | null;
}
export interface JourneyPort {
  /** The journey rejects new finish commands unless its transaction guard is bound. */
  canFinishDraft?: boolean;
  read(): Promise<{ availability: string; snapshot?: Journey }>;
  acknowledge(input: { journeyId: string; expectedRevision: number; requestId: string;
    command: { type: 'draft_saved'; jobId: string; flowId: string; versionId: string } }): Promise<unknown>;
}
export interface Services {
  /** Replace this generation when account, vault, authorization or bindings change. */
  id: string; access(): Promise<boolean>; reader: Reader;
  build?: { read(input: { schemaVersion: 1; jobId?: string; requestId?: string }): Promise<unknown> };
  journey?: JourneyPort;
}
export interface Dependencies<C> {
  enabled?: boolean;
  authorize(context: C): Scope | null | Promise<Scope | null>;
  servicesFor(scope: Scope, context: C): Services | null;
  readTimeoutMs?: number;
}
export type Reason = 'disabled' | 'invalid_request' | 'unsupported_version' | 'unauthorized' | 'binding_missing'
  | 'provider_unavailable' | 'storage_unavailable' | 'not_found' | 'identity_mismatch' | 'artifact_unavailable'
  | 'version_changed' | 'activation_changed' | 'result_changed' | 'incomplete_result' | 'invalid_graph';
export class ResultError extends Error { constructor(readonly reason: Reason) { super(reason); } }
export interface Transition {
  operation: 'journey.transition';
  input: { journeyId: string; expectedRevision: number; requestId: string; command: { type: 'finish' } };
}
export type Result = { availability: 'unsupported' | 'unavailable'; reason: Reason }
  | { availability: 'ready'; state: 'pending' | 'no_draft'; jobId: string | null; requestId: string;
      outcome: Outcome | null; cancellation: Job['cancellation']; revision: number }
  | { availability: 'ready'; state: 'saved'; schemaVersion: 1; scopeId: string; journeyId: string; jobId: string; requestId: string;
      compositionRecordId: string; flowId: string; versionId: string; contentRevision: string;
      jobRevision: number; outcome: Outcome; cancellation: Job['cancellation']; title: string;
      graph: Record<string, unknown>; selectedNodeId: string | null; readiness: Readiness; missingBindings: Issue[];
      activation: 'disabled'; versionState: 'DRAFT';
      reference: { jobId: string; requestId: string; compositionRecordId: string; flowId: string; versionId: string;
        readiness: 'ready' | 'needs_input'; activation: 'disabled' };
      recovery: { operation: 'result.read'; input: ReadInput };
      workflow: { room: 'workflow'; selection: { flowId: string; versionId: string } };
      journey: { sync: 'settled' | 'pending' | 'unavailable'; completion: string | null };
      continuation: Transition | null };
