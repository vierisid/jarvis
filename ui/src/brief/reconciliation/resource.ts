export type Availability = 'loading' | 'ready' | 'empty' | 'stale' | 'unavailable' | 'unsupported';
export interface Snapshot<T> {
  state: Availability; data: T | null; asOf: number | null; refreshing: boolean; reason: string | null;
}
export interface Read<T> { data: T | null; empty: boolean; asOf: number }
export type Domain = 'goals' | 'today' | 'decisions' | 'opportunities' | 'workflows' | 'runs' | 'memory';
export interface Source<T> {
  domains: readonly Domain[];
  capability?: import('../../../../src/brief/capabilities').BriefCapabilityId;
  read(signal: AbortSignal): Promise<Read<T>>;
  /** Memory and inspection context may contain facts forgotten since the last read. */
  retainStale?: boolean;
}
export class ReadFailure extends Error {
  constructor(readonly reason: string, readonly clear = false, readonly unsupported = false, readonly status?: number) {
    super(reason);
  }
}

/** Bounds even a reader that ignores AbortSignal. Late settlements have no owner. */
export async function bounded<T>(read: (signal: AbortSignal) => Promise<T>, controller: AbortController, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted(); return read(controller.signal);
    }), new Promise<never>((_, reject) => {
      cancel = () => reject(new ReadFailure('read_interrupted'));
      controller.signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { reject(new ReadFailure('read_timeout')); controller.abort(); }, timeout);
    })]);
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener('abort', cancel);
  }
}

/** One stable external store per query/selection. It never owns view state or writes domain data. */
export class Projection<T> {
  private value: Snapshot<T> = { state: 'loading', data: null, asOf: null, refreshing: false, reason: null };
  private listeners = new Set<() => void>();
  private release?: () => void;
  private allowed = false;
  private generation = 0;
  private job?: AbortController;
  private queued = false;
  private dirty = false;
  constructor(readonly source: Source<T>, private attach: () => () => void, private timeout: number,
    private onUnauthorized: () => void) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.release = this.attach();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { this.release?.(); this.release = undefined; }
    };
  };
  private publish(value: Snapshot<T>) { this.value = value; for (const listener of this.listeners) listener(); }
  private stale() {
    const data = this.source.retainStale === false ? null : this.value.data;
    this.publish({ ...this.value, data, state: this.value.asOf === null ? 'loading' : 'stale', refreshing: true, reason: null });
  }
  /** Gate changes retire in-flight reads, including during stop/restart and account changes. */
  access(state: 'ready' | 'checking' | 'unavailable' | 'unsupported') {
    this.allowed = state === 'ready'; this.generation++; this.dirty = false;
    this.job?.abort(); this.job = undefined;
    if (state === 'ready') this.refresh();
    else if (state === 'checking') this.stale();
    else this.publish({ state, data: null, asOf: null, refreshing: false, reason: state === 'unsupported' ? 'capability_disabled' : 'access_unavailable' });
  }
  refresh = () => {
    if (!this.allowed) return;
    this.generation++; this.dirty = true; this.stale();
    if (this.queued || this.job) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (this.allowed && this.dirty && !this.job) void this.read(); });
  };
  private async read() {
    const owner = new AbortController(), generation = this.generation;
    this.job = owner; this.dirty = false;
    try {
      const result = await bounded(signal => this.source.read(signal), owner, this.timeout);
      if (this.job !== owner || generation !== this.generation) return;
      this.publish({ state: result.empty ? 'empty' : 'ready', data: result.data, asOf: result.asOf, refreshing: false, reason: null });
    } catch (error) {
      if (this.job !== owner || generation !== this.generation) return;
      const failure = error instanceof ReadFailure ? error : new ReadFailure('read_failed');
      if (failure.status === 401 || failure.status === 403) { this.onUnauthorized(); return; }
      const cleared = failure.clear || this.source.retainStale === false;
      const data = cleared || failure.unsupported ? null : this.value.data;
      // A source that drops its cache on failure has nothing stale left to show: say unavailable, never stale or empty.
      this.publish({ ...this.value, data, state: failure.unsupported ? 'unsupported' : this.value.asOf === null || cleared ? 'unavailable' : 'stale',
        refreshing: false, reason: failure.reason });
    } finally {
      if (this.job === owner) { this.job = undefined; if (this.dirty) this.refresh(); }
    }
  }
}
