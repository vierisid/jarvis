import { PROVIDERS, VIEWS, validManifest, type Configuration, type Journey, type LoadedViews, type Status, type ViewId } from './contract.ts';
import { Unavailable } from './transport.ts';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const member = (v: unknown, values: readonly unknown[]) => values.includes(v);
export function parseStatus(v: unknown): Status {
  if (!object(v) || v.schemaVersion !== 1 || !member(v.installMode, ['hosted', 'self', 'unknown'])
    || !['supported', 'ready', 'enabled', 'released'].every(k => typeof v[k] === 'boolean') || typeof v.reason !== 'string' || !object(v.capabilities)) throw new Unavailable();
  for (const capability of PROVIDERS) {
    const c = v.capabilities[capability];
    if (!object(c) || !['present', 'registered', 'supported', 'ready'].every(k => typeof c[k] === 'boolean') || typeof c.reason !== 'string') throw new Unavailable();
  }
  return v as unknown as Status;
}
export function parseJourney(v: unknown): Journey {
  if (!object(v) || v.availability !== 'ready' || !object(v.snapshot)) throw new Unavailable();
  const s = v.snapshot;
  if (s.schemaVersion !== 1 || !id(s.scopeId) || !id(s.journeyId) || !Number.isSafeInteger(s.revision) || (s.revision as number) < 0
    || !member(s.stepId, ['welcome', 'explain', 'legacy-provider-setup', 'google', 'interview', 'tour', 'activation', 'build', 'result', 'exited'])
    || !member(s.setupState, ['pending', 'completed']) || !member(s.interviewState, ['connecting', 'ready', 'thinking', 'error', 'done', 'skipped'])
    || !member(s.tourState, ['pending', 'in_progress', 'done', 'skipped']) || !(s.tourStepId === null || id(s.tourStepId))
    || !member(s.activationState, ['pending', 'building', 'draft_saved', 'explored', 'legacy_completed'])
    || !member(s.completion, ['active', 'completed', 'explored', 'legacy_completed'])
    || !(s.jobId === null || id(s.jobId)) || !(s.buildRequestId === undefined || s.buildRequestId === null || id(s.buildRequestId))
    || !(s.draft === null || (object(s.draft) && id(s.draft.flowId) && id(s.draft.versionId)))) throw new Unavailable();
  if (s.stepId === 'result' && (!s.draft || !id(s.jobId) || s.activationState !== 'draft_saved')) throw new Unavailable();
  if (s.completion === 'active' && s.stepId === 'exited') throw new Unavailable();
  return structuredClone(s) as unknown as Journey;
}
export function released(config: Configuration): boolean {
  try {
    const c = config.candidate;
    return config.enabled === true && !!c && [c.backend, c.frontend, c.sidecar].every(id)
      && config.authorizeRelease?.(Object.freeze({ ...c })) === true;
  } catch { return false; }
}
export function closure(config: Configuration, status: Status): boolean {
  if (!released(config) || !status.enabled || !status.released || !status.supported || !status.ready || status.installMode === 'unknown' || status.reason !== 'ready') return false;
  if (!PROVIDERS.every(key => { const c = status.capabilities[key]; return c?.present && c.registered && c.supported && c.ready && c.reason === 'ready'; })) return false;
  if (config.modules.length !== VIEWS.length || !VIEWS.every(spec => config.modules.filter(m => validManifest(m.manifest, spec)).length === 1)) return false;
  try {
    return VIEWS.filter(v => !['welcome', 'explainer'].includes(v.directory)).every(v => config.adapters[v.directory as keyof Configuration['adapters']]?.available() === true)
      && (status.installMode !== 'self' || config.adapters['legacy-provider-setup']?.available() === true);
  } catch { return false; }
}
export function viewFor(journey: Journey): ViewId | 'legacy-provider-setup' {
  if (journey.stepId === 'explain') return 'explainer';
  if (journey.stepId === 'tour' && journey.tourStepId === 'pebble') return 'pebble-tour';
  if (journey.stepId === 'exited') throw new Unavailable();
  return journey.stepId;
}
export async function loadViews(config: Configuration): Promise<LoadedViews> {
  const result: Partial<LoadedViews> = {};
  await Promise.all(VIEWS.map(async spec => {
    const entry = config.modules.find(m => validManifest(m.manifest, spec));
    if (!entry) throw new Unavailable();
    const module = await entry.load(), View = module[spec.exportName];
    if (typeof View !== 'function') throw new Unavailable();
    result[spec.directory] = View as LoadedViews[ViewId];
  }));
  return result as LoadedViews;
}
export async function bounded<T>(work: Promise<T>, signal: AbortSignal, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const stop = new Promise<never>((_, reject) => {
    abort = () => reject(new Unavailable());
    timer = setTimeout(abort, ms); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, stop]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
