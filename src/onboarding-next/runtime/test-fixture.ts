/** Synthetic assembly only. No daemon, account, model or workflow services. */
import { OPERATIONS, PROVIDERS, type Capability, type ModuleEntry, type Provider, type RuntimeOptions } from './contract.ts';
export function fixtureOptions(): RuntimeOptions & { calls: string[] } {
  const calls: string[] = [];
  const modules: ModuleEntry[] = PROVIDERS.map(p => ({
    manifest: { schemaVersion: 1, id: p.id, kind: 'provider', entry: './index.ts', provides: [p.capability], requires: [...p.requires] },
    load: async () => { calls.push(`load:${p.capability}`); return {}; },
  }));
  const bindings: NonNullable<RuntimeOptions['bindings']> = {};
  for (const p of PROVIDERS) bindings[p.capability] = () => {
    const operations: Provider['operations'] = {};
    for (const [operation, cap] of Object.entries(OPERATIONS)) if (cap === p.capability) {
      operations[operation as keyof typeof OPERATIONS] = async (_input, c) => { calls.push(`execute:${operation}`); return { actor: c.scope.actorId }; };
    }
    return { probe: () => ({ ready: true, reason: 'ready' }), operations };
  };
  return { calls, modules, bindings, authorize: () => ({ actorId: 'owner', projectId: 'project' }), installMode: () => 'self',
    enabled: true, candidate: { backend: 'backend-sha', frontend: 'frontend-sha', sidecar: 'sidecar-sha' }, authorizeRelease: async () => true };
}
export const request = () => new Request('http://localhost/api/onboarding-next/v1/status');
export const omit = (o: RuntimeOptions, capability: Capability) => ({ ...o, modules: o.modules.filter(e => e.manifest.provides[0] !== capability) });
