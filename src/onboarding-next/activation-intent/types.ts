export type Scope = Readonly<{ actorId: string; projectId: string }>;
/** Opaque selections, never permissions or values inferred from prompt text. */
export interface ContextRef { kind: string; id: string }
export interface BuildRequest {
  schemaVersion: 1; requestId: string; intentVersion: 1; prompt: string; contextRefs: ContextRef[];
}
export interface Submission { action: 'create'; request: BuildRequest; answers: Record<string, string> }
export interface Reference { scopeId: string; ref: ContextRef; revision: string }
export type ReferenceResult = { availability: 'ready'; reference: Reference }
  | { availability: 'unsupported' | 'unavailable' };
export interface Issue {
  id: string; kind: 'detail' | 'connection'; label: string; message: string;
  code: 'missing_detail' | 'missing_context' | 'missing_connection' | 'unsupported_node' | 'placeholder';
  /** Only a named placeholder may be nonblocking for a disabled draft. */
  blocking: boolean;
  /** Exact user-selected reference needing repair; only the validator sets this. */
  reference?: ContextRef;
}
export interface Assessment { schemaVersion: 1; issues: Issue[] }
export const CREATION_POLICY = Object.freeze({ artifact: 'disabled_draft', publish: false, enable: false,
  run: false, grantTools: false, linkGoal: false } as const);
export interface ValidatedIntent {
  schemaVersion: 1; intentVersion: 1; scopeId: string; intentId: string; requestDigest: string;
  request: BuildRequest; answers: Record<string, string>; references: Reference[];
  qualifications: Issue[]; creationPolicy: typeof CREATION_POLICY;
}
export type IntentResult = {
  availability: 'ready'; schemaVersion: 1; state: 'invalid' | 'needs_input' | 'ready' | 'unsupported';
  submission: Submission; issues: Issue[]; intent: ValidatedIntent | null;
} | { availability: 'unsupported' | 'unavailable'; reason: 'disabled' | 'unsupported_version' | 'invalid_request'
  | 'request_too_large' | 'unauthorized' | 'binding_missing' | 'capability_unavailable' | 'service_unavailable' | 'cancelled' };
/** Trusted, scope-bound existing services. These ports must be read-only.
 * No composer execution, job submission, OAuth, tool grants or workflow writes. */
export interface IntentServices {
  /** Changes when the canonical service/store selection changes. */
  id: string;
  access(signal?: AbortSignal): Promise<'ready' | 'unsupported' | 'forbidden'>;
  resolve(ref: ContextRef, signal?: AbortSignal): Promise<ReferenceResult>;
  /** Existing composition/capability assessment; not an additional NL planner.
   * Return actionable blockers or explicitly legitimate draft placeholders.
   * Wording/answers are untrusted data, never grants or a replacement policy. */
  assess(input: Submission & { references: Reference[]; creationPolicy: typeof CREATION_POLICY }, signal?: AbortSignal): Promise<Assessment>;
}
export interface IntentDependencies<C> {
  enabled?: boolean;
  authorize(context: C): Scope | null | Promise<Scope | null>;
  servicesFor(scope: Scope, context: C): IntentServices | null;
}
