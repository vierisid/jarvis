import { readIngredients, readSelected, sameIngredients, type SelectedIngredient } from "../ingredient-picker/model";
import { pendingJob, readJob, validPrompt, type CompositionJob, type CompositionPort, type CompositionRequest } from "./model";

export interface CreationSaved {
  ingredients?: SelectedIngredient[];
  draft: string; request: CompositionRequest | null; job: CompositionJob | null; openedJobId: string | null;
  selectedRunId: string | null; scrollTop: number;
}
export interface CreationStorage { read(): string | null; write(value: string): void }
export interface CreationSnapshot extends CreationSaved { busy: boolean; error: string | null; storageFailed: boolean }
const empty = (): CreationSaved => ({ draft: "", ingredients: [], request: null, job: null, openedJobId: null, selectedRunId: null, scrollTop: 0 });

/** One instance per authenticated account/vault scope, kept above room navigation.
 * A persisted request key precedes every POST. Unknown outcomes retain that key. */
export class WorkflowCreationController {
  readonly source: "live" | "fixture";
  readonly scopeId: string;
  private value: CreationSnapshot;
  private listeners = new Set<() => void>();
  private retired = false;
  private storageRestored = false;
  constructor(readonly port: CompositionPort, private storage: CreationStorage, options: {
    source: "live" | "fixture"; scopeId: string; requestId?: () => string;
  }) {
    this.source = options.source; this.scopeId = options.scopeId; this.requestId = options.requestId ?? (() => crypto.randomUUID());
    this.value = { ...empty(), busy: false, error: null, storageFailed: false };
    try {
      if (!this.scopeId) throw Error("Missing scope");
      const raw = storage.read();
      if (raw !== null) {
        const saved = JSON.parse(raw) as CreationSaved;
        if (!saved || typeof saved.draft !== "string" || !Number.isFinite(saved.scrollTop) || saved.scrollTop < 0
          || !(saved.selectedRunId === null || typeof saved.selectedRunId === "string")
          || !(saved.openedJobId === null || typeof saved.openedJobId === "string")
          || (saved.request !== null && (!saved.request || !/^[\w-]{1,128}$/.test(saved.request.requestId) || !validPrompt(saved.request.prompt)))) throw Error("Invalid saved request");
        saved.ingredients = readSelected(saved.ingredients);
        if (saved.request) readIngredients(saved.request.ingredients);
        if (saved.job !== null) { if (!saved.request) throw Error("Missing request"); readJob(saved.job, saved.request); }
        this.value = { ...saved, busy: false, error: null, storageFailed: false };
      }
      this.storageRestored = true;
    } catch { this.value.storageFailed = true; this.value.error = "Saved creation state is unavailable. New edits stay in this page only. Restore session storage and reload."; }
  }
  private requestId: () => string;
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CreationSnapshot>, persist = true): boolean {
    if (this.retired) return false;
    const next = { ...this.value, ...patch };
    // An unreadable record may own an uncertain POST. Local edits and scroll
    // must not replace it with empty defaults, even if writing still works.
    if (persist && this.storageRestored) {
      try { const { busy: _busy, error: _error, storageFailed: _storage, ...saved } = next; this.storage.write(JSON.stringify(saved)); }
      catch { next.storageFailed = true; next.error = "Your prompt could not be saved. Restore session storage and retry."; }
    }
    this.value = next; this.listeners.forEach(fn => fn()); return !next.storageFailed;
  }
  setDraft = (draft: string) => { this.update({ draft }); };
  setIngredients = (ingredients: SelectedIngredient[]) => { this.update({ ingredients: readSelected(ingredients) }); };
  savePosition = (scrollTop: number, selectedRunId = this.value.selectedRunId) => {
    this.update({ scrollTop: Math.max(0, scrollTop), selectedRunId });
  };
  /** Never forget an uncertain request to create a new key. Explicit recovery first. */
  submit = async (prompt: string) => {
    if (this.retired || this.value.busy || this.value.storageFailed || !validPrompt(prompt)
      || (this.value.request && pendingJob(this.value.job))) return;
    const ingredients = readIngredients(this.value.ingredients?.map(i => i.selection));
    const request: CompositionRequest = { requestId: this.requestId(), prompt, ...(ingredients.length ? { ingredients } : {}) };
    if (!/^[\w-]{1,128}$/.test(request.requestId)) return;
    if (!this.update({ request, job: null, openedJobId: null, busy: true, error: null })) { this.update({ busy: false }, false); return; }
    await this.operation(async () => this.port.submit(request), request);
  };
  recover = async () => {
    const { request, job } = this.value;
    if (this.retired || !request || this.value.busy || this.value.storageFailed || !pendingJob(job)) return;
    this.update({ busy: true, error: null }, false);
    await this.operation(async () => {
      if (job) return this.port.read(job.jobId);
      // POST may have succeeded before its response was lost. If not found,
      // retry the SAME admitted specification/key, never the newly edited text.
      const recovered = await this.port.recover(request);
      // Scope ownership may end during the lookup. Fence the next effect,
      // not only the eventual receipt, before retrying the original request.
      if (this.retired) throw Error("Composition scope retired");
      return recovered ?? await this.port.submit(request);
    }, request);
  };
  private async operation(read: () => Promise<CompositionJob>, request: CompositionRequest) {
    try {
      const job = readJob(await read(), request);
      if (this.retired) return;
      if (this.value.job && job.jobId !== this.value.job.jobId) throw Error("Changed job identity");
      const unchanged = job.state === "draft_ready" && this.value.draft === request.prompt
        && sameIngredients(this.value.ingredients?.map(i => i.selection), request.ingredients);
      this.update({ job, busy: false, error: null,
        draft: unchanged ? "" : this.value.draft, ingredients: unchanged ? [] : this.value.ingredients });
    } catch {
      this.update({ busy: false, error: "Could not confirm the result. Your prompt is kept. Check this request before starting another." }, false);
    }
  }
  acknowledgeOpened = (jobId: string) => { if (this.value.job?.jobId === jobId) return this.update({ openedJobId: jobId }); return false; };
  /** Call when account/vault ownership ends, not when leaving the creation room. */
  dispose = () => { this.retired = true; this.listeners.clear(); };
}

export function sessionCreationStorage(scopeId: string, storage: Pick<Storage, "getItem" | "setItem">): CreationStorage {
  const key = `jarvis:brief:workflow-creation:v1:${encodeURIComponent(scopeId)}`;
  return { read: () => storage.getItem(key), write: value => storage.setItem(key, value) };
}
