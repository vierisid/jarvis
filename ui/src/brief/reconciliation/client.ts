import { isBriefCapabilityEnabled, type BriefCapabilityId, type BriefCapabilitySnapshot } from '../../../../src/brief/capabilities';
import { bounded, Projection, type Source } from './resource';
import { EventHints, type Frame } from './events';
import { getJson } from './sources';

/** One instance per authenticated account/vault. The host must stop it on identity changes. */
export class BriefReconciliationClient {
  private active = false;
  private resources = new Set<Projection<unknown>>();
  private hints = new EventHints();
  private capabilities: unknown;
  private accessRead?: AbortController;
  private interval?: ReturnType<typeof setInterval>;
  private cleanup?: () => void;
  readonly observer = {
    onOpen: () => { this.hints.reset(); void this.refresh(); },
    onClose: () => { this.hints.reset(); void this.refresh(); },
    onMessage: (frame: Frame) => {
      if (!this.active) return;
      if (frame?.type === 'settings_applied') { void this.refresh(); return; }
      const domains = this.hints.accept(frame);
      for (const resource of this.resources) if (resource.source.domains.some(domain => domains.includes(domain))) resource.refresh();
    },
  };
  constructor(private options: {
    capabilities?: (signal: AbortSignal) => Promise<unknown>;
    pollMs?: number; timeoutMs?: number;
  } = {}) {}
  private get timeout() { return this.options.timeoutMs ?? 10_000; }
  projection<T>(source: Source<T>): Projection<T> {
    const resource = new Projection(source, () => {
      this.resources.add(resource as Projection<unknown>);
      this.applyAccess(resource);
      return () => { this.resources.delete(resource as Projection<unknown>); resource.access('unavailable'); };
    }, this.timeout, () => this.revoke());
    return resource;
  }
  private applyAccess<T>(resource: Projection<T>) {
    if (!this.active) { resource.access('unavailable'); return; }
    if (this.accessRead) { resource.access('checking'); return; }
    const gate = (id: BriefCapabilityId) => {
      if (isBriefCapabilityEnabled(this.capabilities, id)) return 'ready';
      const snapshot = this.capabilities as Partial<BriefCapabilitySnapshot> | null | undefined;
      const value = snapshot?.contractVersion === 1 ? snapshot.capabilities?.[id] : undefined;
      return value?.supported === true && value.reason !== 'disabled' ? 'unavailable' : 'unsupported';
    };
    const reconciliation = gate('reconciliation');
    resource.access(reconciliation !== 'ready' ? reconciliation : resource.source.capability ? gate(resource.source.capability) : 'ready');
  }
  private revoke() {
    this.accessRead?.abort(); this.accessRead = undefined; this.capabilities = undefined;
    for (const resource of this.resources) resource.access('unavailable');
  }
  start() {
    if (this.active) return;
    this.active = true; void this.refresh();
    // Also recovers a final lost frame and domains whose writers have no event producer yet.
    this.interval = setInterval(() => void this.refresh(), this.options.pollMs ?? 30_000);
    if (typeof window !== 'undefined') {
      const refresh = () => void this.refresh();
      const visible = () => { if (document.visibilityState === 'visible') refresh(); };
      window.addEventListener('online', refresh); window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', visible);
      this.cleanup = () => {
        window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh);
        document.removeEventListener('visibilitychange', visible);
      };
    }
  }
  stop() {
    this.active = false; clearInterval(this.interval); this.cleanup?.(); this.cleanup = undefined;
    this.hints.reset(); this.revoke();
  }
  /** Explicit mutation completion may call this; it never replays a mutation. */
  refresh = async () => {
    if (!this.active) return;
    this.accessRead?.abort();
    const owner = new AbortController(); this.accessRead = owner;
    for (const resource of this.resources) resource.access('checking');
    try {
      const caps = await bounded(this.options.capabilities ?? (signal => getJson('/api/brief/capabilities', signal)), owner, this.timeout);
      if (this.accessRead !== owner || !this.active) return;
      this.capabilities = caps; this.accessRead = undefined;
      for (const resource of this.resources) this.applyAccess(resource);
    } catch {
      if (this.accessRead === owner) this.revoke();
    }
  };
}
