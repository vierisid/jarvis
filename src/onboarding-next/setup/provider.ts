import { checkNativeAccess, requestNativeAccess } from './permissions.ts';
import type { SetupPorts, SetupResult, SetupScope, SetupState } from './types.ts';

function result(reason: SetupResult['reason'], state?: SetupState, services: SetupResult['services'] = 'not_checked'): SetupResult {
  return {
    schemaVersion: 1, installMode: state?.installMode ?? 'unknown',
    supported: !['provider_unavailable', 'unauthorized'].includes(reason),
    ready: reason === 'ready', reason, completedAt: state?.completedAt ?? null, services,
    next: reason === 'ready' ? 'continue' : reason === 'legacy_setup_required' ? 'legacy_setup' : 'retry',
  };
}

export function createSetupProvider<Context>(ports: SetupPorts<Context>) {
  // Per owner single-flight. There is no completed-result cache: restart/lost
  // response retries re-read durable setup and current runtime readiness.
  const commits = new Map<string, Promise<SetupResult>>();
  async function authorize(context: Context): Promise<SetupScope | null> {
    try {
      const scope = await ports.authorize(context);
      return scope && typeof scope.actorId === 'string' && scope.actorId.trim()
        && typeof scope.projectId === 'string' && scope.projectId.trim()
        ? { actorId: scope.actorId, projectId: scope.projectId } : null;
    } catch { return null; }
  }
  async function evaluate(scope: SetupScope, commit: boolean): Promise<SetupResult> {
    if (!ports.store) return result('provider_unavailable');
    let state: SetupState;
    try { state = await ports.store.read(scope); }
    catch { return result('setup_unavailable'); }
    if (state.installMode === 'unknown') return result('install_mode_unknown', state);
    if (!state.configured) return result(state.installMode === 'hosted'
      ? 'hosted_configuration_unavailable' : 'legacy_setup_required', state);
    if (state.completedAt === null) {
      if (state.installMode === 'self') return result('legacy_setup_required', state);
      if (!commit) return result('setup_required', state);
      try {
        await ports.store.completeHosted(scope);
        state = await ports.store.read(scope);
        if (state.installMode !== 'hosted' || !state.configured || state.completedAt === null) {
          return result('setup_save_failed', state);
        }
      } catch { return result('setup_save_failed', state); }
    }
    if (!ports.services) return result('services_unavailable', state, 'unavailable');
    try {
      let services = await ports.services.read(scope);
      if (services === 'stopped' && commit) {
        try { await ports.services.start(scope); }
        catch { return result('services_start_failed', state, 'stopped'); }
        services = await ports.services.read(scope);
      }
      return result(services === 'running' ? 'ready' : services === 'unavailable'
        ? 'services_unavailable' : 'services_not_running', state, services);
    } catch { return result('services_unavailable', state, 'unavailable'); }
  }
  return {
    /** Reading the explainer only reads state. No persistence, prompt or startup. */
    async read(context: Context): Promise<SetupResult> {
      const scope = await authorize(context);
      return scope ? evaluate(scope, false) : result('unauthorized');
    },
    async complete(context: Context, input: unknown): Promise<SetupResult> {
      const scope = await authorize(context);
      if (!scope) return result('unauthorized');
      // No client mode, actor, provider configuration or API key is accepted.
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || (input as { action?: unknown }).action !== 'complete_setup') {
        return result('invalid_request');
      }
      const key = JSON.stringify([scope.actorId, scope.projectId]);
      const current = commits.get(key);
      if (current) return current;
      const pending = evaluate(scope, true);
      commits.set(key, pending);
      try { return await pending; } finally { commits.delete(key); }
    },
    async checkAction(context: Context, input: unknown) {
      return checkNativeAccess(await authorize(context), ports.permissions, input);
    },
    async requestAction(context: Context, input: unknown) {
      return requestNativeAccess(await authorize(context), ports.permissions, input);
    },
  };
}
