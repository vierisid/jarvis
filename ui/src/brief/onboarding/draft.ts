import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';
import type { BriefComposeRequest, BriefCompositionJob } from '../../../../src/brief/composition-contracts';
import type { BriefRoute } from '../contracts';

export interface OnboardingStorage { read(): string | null; write(value: string): void }
export interface OnboardingHost {
  capabilities(): unknown;
  roomAvailable(room: BriefRoute['room']): boolean;
  /** Shared dirty-draft guard; must not navigate itself. */
  canLeave(signal: AbortSignal): Promise<boolean>;
  /** Synchronous commit after F-26's final capability/room/ownership check. */
  commit(route: BriefRoute): void;
}
export interface OnboardingComposition {
  submit(request: BriefComposeRequest): Promise<BriefCompositionJob>;
  read(id: string): Promise<BriefCompositionJob>;
}
interface SavedDraft { routine: string; request: BriefComposeRequest | null }
export interface OnboardingDraftState extends SavedDraft {
  job: BriefCompositionJob | null; busy: boolean; error: string | null; storageFailed: boolean;
}
const initial = (): OnboardingDraftState => ({ routine: '', request: null, job: null, busy: false, error: null, storageFailed: false });
const requestValid = (request: BriefComposeRequest) => /^[\w-]{1,128}$/.test(request.requestId)
  && typeof request.prompt === 'string' && !!request.prompt.trim() && new TextEncoder().encode(request.prompt).length <= 16_384;
export const pendingDraft = (job: BriefCompositionJob | null) => !job || job.state === 'queued' || job.state === 'running';

/** Only the existing F-07 wire API. No empty-flow, publish, enable, run or chat API. */
export function onboardingComposition(fetcher: typeof fetch = fetch): OnboardingComposition {
  const read = async (url: string, init?: RequestInit) => {
    const response = await fetcher(url, init);
    if (!response.ok) throw Error('Composition unavailable');
    return response.json();
  };
  return {
    submit: async request => (await read('/api/brief/workflow-compositions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    })).job,
    read: id => read(`/api/brief/workflow-compositions/${encodeURIComponent(id)}`),
  };
}

function validateJob(job: BriefCompositionJob, request: BriefComposeRequest, prior: BriefCompositionJob | null) {
  if (!job || typeof job.jobId !== 'string' || !job.jobId || job.requestId !== request.requestId
    || job.specification?.prompt !== request.prompt || (prior && prior.jobId !== job.jobId)
    || !['queued', 'running', 'draft_ready', 'blocked', 'failed', 'cancelled'].includes(job.state)
    || (job.state === 'draft_ready' && (!job.workflow || typeof job.workflow.flowId !== 'string' || !job.workflow.flowId
      || typeof job.workflow.versionId !== 'string' || !job.workflow.versionId))) throw Error('Invalid draft receipt');
  return job;
}

/** One authenticated account/vault lifetime, kept above onboarding and room navigation.
 * Persist the exact request BEFORE POST; uncertain responses/reloads reuse its key. */
export class OnboardingDraft {
  private state = initial();
  private listeners = new Set<() => void>();
  private retired = false;
  private restored = false;
  private navigation = new AbortController();
  constructor(readonly scope: string, private readonly storage: OnboardingStorage,
    private readonly host: OnboardingHost, private readonly api: OnboardingComposition = onboardingComposition(),
    private readonly newId: () => string = () => crypto.randomUUID()) {
    try {
      if (!scope) throw Error('Missing account scope');
      const raw = storage.read();
      if (raw !== null) {
        const saved = JSON.parse(raw) as SavedDraft;
        if (!saved || typeof saved.routine !== 'string' || saved.routine.length > 2000
          || !(saved.request === null || (saved.request && requestValid(saved.request)))) throw Error('Invalid saved prompt');
        this.state = { ...initial(), routine: saved.routine, request: saved.request };
      }
      this.restored = true;
    } catch { this.state.storageFailed = true; this.state.error = 'Saved onboarding work is unavailable. Restore session storage and reload.'; }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  available = () => {
    try {
      const snapshot = this.host.capabilities();
      return !this.retired && isBriefCapabilityEnabled(snapshot, 'onboarding')
        && isBriefCapabilityEnabled(snapshot, 'workflowComposition');
    } catch { return false; }
  };
  private update(patch: Partial<OnboardingDraftState>, persist = false) {
    if (this.retired) return false;
    const next = { ...this.state, ...patch };
    if (persist && this.restored) {
      try {
        this.storage.write(JSON.stringify({ routine: next.routine, request: next.request } satisfies SavedDraft));
        next.storageFailed = false;
      } catch { next.storageFailed = true; next.error = 'Your task is still here, but could not be saved. Restore session storage and retry.'; }
    }
    this.state = next; this.listeners.forEach(listener => listener());
    return !next.storageFailed;
  }
  setRoutine = (routine: string) => {
    // An uncertain request must be resolved before replacing its specification.
    if (this.state.busy || (this.state.request && pendingDraft(this.state.job))) return;
    this.update({ routine: routine.slice(0, 2000), request: null, job: null, error: null }, true);
  };
  prepare = async () => {
    if (this.retired || this.state.busy) return;
    if (!this.available()) { this.update({ error: 'Workflow preparation is unavailable. Your task is kept; try again after setup.' }); return; }
    if (this.state.job?.state === 'draft_ready') return;
    const existing = this.state.request && pendingDraft(this.state.job) ? this.state.request : null;
    const request = existing ?? { requestId: this.newId(), prompt: this.state.routine.trim() };
    if (!requestValid(request)) return;
    if (!this.update({ request, job: existing ? this.state.job : null, busy: true, error: null }, true)) {
      this.update({ busy: false }); return;
    }
    await this.readResult(() => this.state.job ? this.api.read(this.state.job.jobId) : this.api.submit(request), request);
  };
  check = async () => {
    const { request, job, busy } = this.state;
    if (this.retired || busy || !request || !job || !pendingDraft(job) || !this.available()) return;
    this.update({ busy: true, error: null });
    await this.readResult(() => this.api.read(job.jobId), request);
  };
  private async readResult(operation: () => Promise<BriefCompositionJob>, request: BriefComposeRequest) {
    const ownsRequest = () => !this.retired && this.state.request === request;
    try {
      const result = await operation();
      if (!ownsRequest()) return;
      const job = validateJob(result, request, this.state.job);
      this.update({ job, busy: false });
    } catch {
      if (ownsRequest()) this.update({ busy: false, error: 'Could not confirm the draft. Your task is kept. Check this request before starting another.' });
    }
  }
  openDraft = async () => {
    const job = this.state.job;
    if (!this.available() || job?.state !== 'draft_ready' || !job.workflow || !this.host.roomAvailable('workflow-draft')) throw Error('Draft room unavailable');
    if (!await this.host.canLeave(this.navigation.signal)) throw Error('Draft handoff cancelled');
    if (!this.available() || this.navigation.signal.aborted || !this.host.roomAvailable('workflow-draft')
      || this.state.job !== job) throw Error('Draft was not opened');
    this.host.commit({ room: 'workflow-draft', selection: { ...job.workflow } });
  };
  /** Only call after the user's successful review handoff or explicit Explore choice. */
  clear = () => {
    if (this.retired || !this.restored) throw Error('Saved handoff unavailable');
    try { this.storage.write(JSON.stringify({ routine: '', request: null } satisfies SavedDraft)); }
    catch {
      // Do not discard the in-memory prompt or receipt when the final save failed.
      this.update({ storageFailed: true, error: 'Your task is kept. Restore session storage and try again.' });
      throw Error('Could not clear the saved handoff');
    }
    // Dropping the request invalidates pending reads only after storage clearing succeeds.
    this.update(initial());
  };
  dispose = () => { this.retired = true; this.navigation.abort(); this.listeners.clear(); };
}

export function sessionOnboardingStorage(scope: string, storage: Pick<Storage, 'getItem' | 'setItem'>): OnboardingStorage {
  const key = `jarvis:brief:onboarding:v1:${encodeURIComponent(scope)}`;
  return { read: () => storage.getItem(key), write: value => storage.setItem(key, value) };
}
