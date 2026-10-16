/** ON-B-11's v1 assembly contract. Module owners keep structural projections. */
export const PROVIDERS = [
  { id: 'ON-B-01', directory: 'journey', capability: 'journey.v1', requires: [], companions: ['settings.ts'] },
  { id: 'ON-B-02', directory: 'setup', capability: 'setup.v1', requires: [] },
  { id: 'ON-B-03', directory: 'google', capability: 'google-state.v1', requires: [] },
  { id: 'ON-B-04', directory: 'interview-session', capability: 'interview-session.v1', requires: ['interview-profile.v1'] },
  { id: 'ON-B-05', directory: 'interview-profile', capability: 'interview-profile.v1', requires: [] },
  { id: 'ON-B-06', directory: 'tour', capability: 'tour.v1', requires: ['journey.v1'] },
  { id: 'ON-B-07', directory: 'activation-intent', capability: 'activation-intent.v1', requires: [] },
  { id: 'ON-B-08', directory: 'build-jobs', capability: 'build-job.v1', requires: ['activation-intent.v1', 'compose-draft.v1'] },
  { id: 'ON-B-09', directory: 'compose-draft', capability: 'compose-draft.v1', requires: [] },
  { id: 'ON-B-10', directory: 'result', capability: 'draft-result.v1', requires: ['build-job.v1'] },
  { id: 'ON-B-12', directory: 'diagnostics', capability: 'diagnostics.v1', requires: [] },
] as const;
export type Capability = typeof PROVIDERS[number]['capability'];
export const REQUIRED = PROVIDERS.filter(p => p.capability !== 'diagnostics.v1').map(p => p.capability);
export type Scope = Readonly<{ actorId: string; projectId: string }>;
export type InstallMode = 'unknown' | 'hosted' | 'self';
export interface ModuleManifest {
  schemaVersion: 1; id: string; kind: 'provider'; entry: './index.ts';
  provides: Capability[]; requires: Capability[];
}
export interface ModuleEntry { manifest: ModuleManifest; load(): Promise<Record<string, unknown>> }
export interface Context { request: Request; scope: Scope; signal: AbortSignal }
export interface Probe { ready: boolean; reason: Reason }
export type Reason = 'ready' | 'module_absent' | 'binding_missing' | 'dependency_unavailable'
  | 'provider_unavailable' | 'install_mode_unknown' | 'disabled' | 'release_blocked'
  | 'unauthorized' | 'invalid_request' | 'unsupported_version' | 'operation_unsupported'
  | 'request_too_large' | 'conflict' | 'storage_unavailable';
export interface Provider {
  /** Observational only: no initialization, model call, OAuth or writes. */
  probe(context: Context): Promise<Probe> | Probe;
  operations: Partial<Record<Operation, (input: unknown, context: Context) => Promise<unknown>>>;
}
/** Only these operations can be reached from HTTP. Internal acknowledgements
 * and composition commits are never dispatched from a client command. */
export const OPERATIONS = {
  'journey.read': 'journey.v1', 'journey.transition': 'journey.v1',
  'setup.read': 'setup.v1', 'setup.complete': 'setup.v1',
  'google.read': 'google-state.v1', 'google.begin': 'google-state.v1',
  'google.cancel': 'google-state.v1', 'google.callback': 'google-state.v1',
  'interview.command': 'interview-session.v1', 'tour.command': 'tour.v1',
  'intent.validate': 'activation-intent.v1', 'build.submit': 'build-job.v1',
  'build.read': 'build-job.v1', 'build.cancel': 'build-job.v1',
  'result.read': 'draft-result.v1',
} as const;
export type Operation = keyof typeof OPERATIONS;
export type Binder = (module: Record<string, unknown>, dependencies: Readonly<Partial<Record<Capability, Provider>>>) => Provider | null | Promise<Provider | null>;
export interface Candidate { backend: string; frontend: string; sidecar: string }
export interface RuntimeOptions {
  modules: readonly ModuleEntry[];
  bindings?: Partial<Record<Capability, Binder>>;
  /** Must resolve live credentials and server-selected vault/project, every time. */
  authorize(request: Request): Scope | null | Promise<Scope | null>;
  installMode(context: Context): InstallMode | Promise<InstallMode>;
  enabled?: boolean;
  /** Server-owned exact runtime tuple, never taken from a request body. */
  candidate?: Candidate;
  /** Inject the release owner's candidate-bound U11/B13/D/F/Q decision.
   * No endpoint, env toggle or provider manifest may set this decision. */
  authorizeRelease?: (candidate: Readonly<Candidate>, context: Context) => Promise<boolean>;
  /** Bounded observational checks. Does not imply cancellation of effects. */
  probeTimeoutMs?: number;
}
export interface CapabilityState {
  present: boolean; registered: boolean; supported: boolean; ready: boolean; reason: Reason;
}
export interface RuntimeStatus {
  schemaVersion: 1; installMode: InstallMode; supported: boolean; ready: boolean;
  enabled: boolean; released: boolean; reason: Reason;
  capabilities: Record<Capability, CapabilityState>;
}
