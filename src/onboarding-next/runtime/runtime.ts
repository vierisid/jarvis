import { OPERATIONS, PROVIDERS, REQUIRED, type Capability, type CapabilityState, type Context, type ModuleEntry,
  type Operation, type Provider, type Reason, type RuntimeOptions, type RuntimeStatus, type Scope } from './contract.ts';

export class RuntimeError extends Error {
  constructor(readonly reason: Reason, readonly status: number) { super(reason); }
}
const sameScope = (a: Scope | null, b: Scope) => a?.actorId === b.actorId && a?.projectId === b.projectId;
const validScope = (s: Scope | null): s is Scope => !!s && [s.actorId, s.projectId].every(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 256);
const state = (present: boolean, reason: Reason): CapabilityState => ({ present, registered: false, supported: false, ready: false, reason });

/** A bounded wait for read-only readiness. An expired probe never authorizes a
 * write. Mutations are not raced against a timer or relabeled cancelled. */
async function probeWithin<T>(task: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(AbortSignal.any([parent, controller.signal])),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new RuntimeError('provider_unavailable', 503));
      }, ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
export function createOnboardingRuntime(options: RuntimeOptions) {
  const entries = new Map<Capability, ModuleEntry>();
  // Do not trust a manually substituted registry either. The build script does
  // filesystem checks; this repeats the wire/graph identity checks without IO.
  for (const e of options.modules) {
    const spec = PROVIDERS.find(p => p.id === e.manifest.id);
    if (!spec || e.manifest.schemaVersion !== 1 || e.manifest.kind !== 'provider' || e.manifest.entry !== './index.ts'
      || JSON.stringify(e.manifest.provides) !== JSON.stringify([spec.capability])
      || JSON.stringify(e.manifest.requires) !== JSON.stringify(spec.requires) || entries.has(spec.capability)) {
      throw new Error('Invalid onboarding registry');
    }
    entries.set(spec.capability, e);
  }
  const providers = new Map<Capability, Promise<Provider | null>>();
  const timeout = Math.max(1, Math.min(options.probeTimeoutMs ?? 5000, 10000));
  async function authorize(request: Request): Promise<Context> {
    const scope = await options.authorize(request);
    if (!validScope(scope) || request.signal.aborted) throw new RuntimeError('unauthorized', 401);
    return { request, scope: Object.freeze({ ...scope }), signal: request.signal };
  }
  async function recheck(c: Context) {
    if (c.signal.aborted || !sameScope(await options.authorize(c.request), c.scope)) throw new RuntimeError('unauthorized', 401);
  }
  async function provider(cap: Capability): Promise<Provider | null> {
    const existing = providers.get(cap);
    if (existing) return existing;
    const entry = entries.get(cap), binder = options.bindings?.[cap];
    if (!entry || !binder) return null;
    const pending = (async () => {
      const dependencies: Partial<Record<Capability, Provider>> = {};
      for (const dep of entry.manifest.requires) {
        const bound = await provider(dep);
        if (!bound) return null;
        dependencies[dep] = bound;
      }
      const bound = await binder(await entry.load(), Object.freeze(dependencies));
      if (bound && (typeof bound.probe !== 'function' || !bound.operations || typeof bound.operations !== 'object')) throw new Error('Invalid onboarding binding');
      return bound;
    })();
    providers.set(cap, pending);
    pending.then(value => { if (!value) providers.delete(cap); }, () => { providers.delete(cap); });
    return pending;
  }
  async function inspect(context: Context): Promise<RuntimeStatus> {
    let installMode: RuntimeStatus['installMode'] = 'unknown';
    try {
      const mode = await probeWithin(signal => Promise.resolve(options.installMode({ ...context, signal })), timeout, context.signal);
      if (mode === 'hosted' || mode === 'self') installMode = mode;
    } catch { /* unreadable config is unknown, never self-hosted */ }
    const capabilities = {} as Record<Capability, CapabilityState>;
    const probes = new Map<Capability, Promise<CapabilityState>>();
    const inspectCapability = async (cap: Capability): Promise<CapabilityState> => {
      if (capabilities[cap]) return capabilities[cap];
      const entry = entries.get(cap);
      if (!entry) return capabilities[cap] = state(false, 'module_absent');
      if (!options.bindings?.[cap]) return capabilities[cap] = state(true, 'binding_missing');
      for (const dep of entry.manifest.requires) {
        if (!(await visit(dep)).ready) return capabilities[cap] = state(true, 'dependency_unavailable');
      }
      if (installMode === 'unknown') return capabilities[cap] = state(true, 'install_mode_unknown');
      try {
        const result = await probeWithin(async signal => {
          const bound = await provider(cap);
          if (!bound) return state(true, 'binding_missing');
          if (Object.entries(OPERATIONS).some(([op, owner]) => owner === cap && typeof bound.operations[op as Operation] !== 'function')) return state(true, 'binding_missing');
          await recheck(context);
          const ready = await bound.probe({ ...context, signal });
          return { present: true, registered: true, supported: true, ready: ready.ready === true,
            reason: ready.ready === true ? 'ready' as const : 'provider_unavailable' as const };
        }, timeout, context.signal);
        return capabilities[cap] = result;
      } catch { return capabilities[cap] = state(true, 'provider_unavailable'); }
    };
    const visit = (cap: Capability): Promise<CapabilityState> => {
      const existing = probes.get(cap);
      if (existing) return existing;
      const pending = inspectCapability(cap);
      probes.set(cap, pending);
      return pending;
    };
    await Promise.all(PROVIDERS.map(p => visit(p.capability)));
    await recheck(context);
    const supported = REQUIRED.every(c => capabilities[c].supported);
    const closureReady = REQUIRED.every(c => capabilities[c].ready);
    const candidate = options.candidate;
    let released = false;
    if (closureReady && options.enabled === true && candidate && options.authorizeRelease
      && Object.values(candidate).length === 3 && [candidate.backend, candidate.frontend, candidate.sidecar].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) {
      try {
        released = await probeWithin(signal => options.authorizeRelease!(Object.freeze({ ...candidate }), { ...context, signal }), timeout, context.signal) === true;
      } catch { /* stale/missing evidence never enables a route */ }
    }
    await recheck(context);
    const integration = closureReady && options.enabled === true && options.authorizeIntegration?.(context) === true;
    await recheck(context);
    const ready = closureReady && options.enabled === true && (released || integration);
    return { schemaVersion: 1, installMode, supported, ready, enabled: options.enabled === true, released, ...(integration ? { integration: true as const } : {}),
      reason: installMode === 'unknown' ? 'install_mode_unknown' : !closureReady ? 'dependency_unavailable'
        : !options.enabled ? 'disabled' : !released && !integration ? 'release_blocked' : 'ready', capabilities };
  }
  return {
    async status(request: Request) { return inspect(await authorize(request)); },
    async execute(request: Request, operation: Operation, input: unknown) {
      if (!Object.hasOwn(OPERATIONS, operation)) throw new RuntimeError('operation_unsupported', 404);
      const context = await authorize(request);
      const status = await inspect(context);
      if (!status.ready) throw new RuntimeError(status.reason, 503);
      const bound = await provider(OPERATIONS[operation]);
      const handler = bound?.operations[operation];
      if (!handler) throw new RuntimeError('operation_unsupported', 503);
      await recheck(context);
      const result = await handler(input, context);
      // A disconnected/revoked caller must recover via a fresh authenticated
      // status read; this does not claim any already-committed effect was undone.
      await recheck(context);
      return result;
    },
  };
}
export type OnboardingRuntime = ReturnType<typeof createOnboardingRuntime>;
