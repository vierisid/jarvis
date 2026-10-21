import type { ComponentType } from 'react';

/** UI-owned structural projection. No import from an optional view/provider. */
export const VIEWS = [
  { id: 'ON-U-01', directory: 'welcome', capability: 'welcome-view.v1', exportName: 'WelcomeView', requires: ['journey.v1', 'setup.v1'] },
  { id: 'ON-U-02', directory: 'explainer', capability: 'explainer-view.v1', exportName: 'ExplainerView', requires: ['journey.v1', 'setup.v1'] },
  { id: 'ON-U-03', directory: 'google', capability: 'google-view.v1', exportName: 'GoogleView', requires: ['google-state.v1'] },
  { id: 'ON-U-04', directory: 'interview', capability: 'interview-view.v1', exportName: 'InterviewView', requires: ['interview-session.v1', 'interview-profile.v1'] },
  { id: 'ON-U-05', directory: 'tour', capability: 'tour-view.v1', exportName: 'TourView', requires: ['tour.v1'] },
  { id: 'ON-U-06', directory: 'pebble-tour', capability: 'pebble-tour-view.v1', exportName: 'PebbleTourView', requires: ['tour.v1'] },
  { id: 'ON-U-07', directory: 'activation', capability: 'activation-view.v1', exportName: 'ActivationView', requires: ['activation-intent.v1', 'build-job.v1'] },
  { id: 'ON-U-08', directory: 'build', capability: 'build-view.v1', exportName: 'BuildView', requires: ['build-job.v1', 'draft-result.v1'] },
  { id: 'ON-U-09', directory: 'result', capability: 'result-view.v1', exportName: 'ResultView', requires: ['draft-result.v1'] },
] as const;
export type ViewId = typeof VIEWS[number]['directory'];
export type FeatureId = Exclude<ViewId, 'welcome' | 'explainer'>;
export const PROVIDERS = ['journey.v1', 'setup.v1', 'google-state.v1', 'interview-session.v1', 'interview-profile.v1', 'tour.v1', 'activation-intent.v1', 'build-job.v1', 'compose-draft.v1', 'draft-result.v1'] as const;
export interface Manifest { schemaVersion: 1; id: string; kind: 'view'; entry: './index.tsx'; provides: string[]; requires: string[] }
export interface ViewModule { manifest: Manifest; load(): Promise<Record<string, unknown>> }
export type LoadedViews = Record<ViewId, ComponentType<Record<string, unknown>>>;
export type InstallMode = 'hosted' | 'self' | 'unknown';
export type Theme = 'light' | 'dark';
export type Step = 'welcome' | 'explain' | 'legacy-provider-setup' | 'google' | 'interview' | 'tour' | 'activation' | 'build' | 'result' | 'exited';
export interface Journey {
  schemaVersion: 1; scopeId: string; journeyId: string; revision: number; stepId: Step;
  setupState: 'pending' | 'completed';
  interviewState: 'connecting' | 'ready' | 'thinking' | 'error' | 'done' | 'skipped';
  tourState: 'pending' | 'in_progress' | 'done' | 'skipped'; tourStepId: string | null;
  replayReturnStepId?: Step | null;
  activationState: 'pending' | 'building' | 'draft_saved' | 'explored' | 'legacy_completed';
  completion: 'active' | 'completed' | 'explored' | 'legacy_completed';
  jobId: string | null; buildRequestId?: string | null;
  draft: { flowId: string; versionId: string } | null;
}
export interface CapabilityState { present: boolean; registered: boolean; supported: boolean; ready: boolean; reason: string }
export interface Status {
  schemaVersion: 1; installMode: InstallMode; supported: boolean; ready: boolean; enabled: boolean; released: boolean; reason: string;
  integration?: true;
  capabilities: Record<string, CapabilityState>;
}
export type Operation = 'journey.read' | 'journey.transition' | 'setup.read' | 'setup.complete'
  | 'google.read' | 'google.begin' | 'google.cancel' | 'google.callback' | 'interview.command' | 'tour.command'
  | 'intent.validate' | 'build.submit' | 'build.read' | 'build.cancel' | 'result.read';
export interface Transport {
  status(signal: AbortSignal): Promise<unknown>;
  call(operation: Operation, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface Context { journey: Readonly<Journey>; installMode: 'hosted' | 'self'; signal: AbortSignal }
/** Trusted adapters validate provider responses and own scoped drafts, idempotency,
 * reconciliation, and render ports. Models are serializable; ports are local code.
 * available() must include all required renderers/services, not just source presence.
 * No adapter may manufacture provider completion or release permission. */
export interface FeatureAdapter {
  available(): boolean;
  read(context: Context): Promise<{ model: Record<string, unknown>; ports?: Record<string, unknown> }>;
  command(context: Context, action: string, input?: unknown): Promise<void>;
  setDraft?(context: Context, draft: unknown): { model: Record<string, unknown>; ports?: Record<string, unknown> };
  subscribe?(changed: () => void): () => void;
  dispose?(): void;
}
export interface Configuration {
  enabled: boolean;
  /** Only the separate isolated integration entry supplies this trusted prop. */
  integration?: true;
  modules: readonly ViewModule[];
  transport: Transport;
  /** Exact compiled candidate selected by the release owner, never URL/storage. */
  candidate?: Readonly<{ backend: string; frontend: string; sidecar: string }>;
  authorizeRelease?: (candidate: Readonly<{ backend: string; frontend: string; sidecar: string }>) => boolean;
  /** Factories are called only after all capability and release checks pass. */
  adapters: Partial<Record<FeatureId | 'legacy-provider-setup', { available(): boolean; create(): FeatureAdapter }>>;
}
export function validManifest(value: unknown, spec: typeof VIEWS[number]): value is Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Manifest;
  return Object.keys(m).sort().join(',') === 'entry,id,kind,provides,requires,schemaVersion'
    && m.schemaVersion === 1 && m.id === spec.id && m.kind === 'view' && m.entry === './index.tsx'
    && JSON.stringify(m.provides) === JSON.stringify([spec.capability]) && JSON.stringify(m.requires) === JSON.stringify(spec.requires);
}
