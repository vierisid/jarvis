import type { JarvisConfig } from '../../config/types.ts';
import { mergeTTSConfig } from '../../daemon/config-merge.ts';
import { saveLLMSettings } from '../../daemon/llm-settings.ts';
import { hasUsejarvisAi, isHostedInstall } from '../../daemon/usejarvis-ai.ts';
import { loadUserSectionStrict, persistUserPatch, saveUserSection } from '../../daemon/user-settings.ts';
import { readSystemPermissions, requestSystemPermission, resolvePermissionsHost, type PermissionsSidecarHost } from '../../daemon/system-permissions.ts';
import type { SetupPermissions, SetupScope, SetupStore } from './types.ts';

function boundScope(owner: SetupScope) {
  const { actorId, projectId } = owner;
  if (!actorId.trim() || !projectId.trim()) throw new Error('Setup owner required');
  return (scope: SetupScope) => {
    if (scope.actorId !== actorId || scope.projectId !== projectId) throw new Error('Setup owner mismatch');
  };
}
function storedObject(section: 'onboarding' | 'tts' | 'awareness'): Record<string, unknown> | null {
  const value = loadUserSectionStrict(section);
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Unreadable setup settings');
  return value as Record<string, unknown>;
}
function completion(row: Record<string, unknown> | null): number | null {
  const value = row?.setup_completed_at;
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Unreadable setup completion');
  return value;
}

/** Bound to one authorized existing vault/config. Multi-tenant hosts select a
 * separate adapter per server-resolved owner; client IDs never select a vault. */
export function createDaemonSetupStore(options: {
  owner: SetupScope;
  config: JarvisConfig;
  isConfigLoaded(): boolean;
  /** Reuse the current LLM readiness check, not a browser's provider selection. */
  isSelfConfigured(): boolean;
  now?: () => number;
}): SetupStore {
  const assertScope = boundScope(options.owner);
  const { config } = options;
  return {
    read(scope) {
      assertScope(scope);
      if (!options.isConfigLoaded()) return { installMode: 'unknown', configured: false, completedAt: null };
      const hosted = isHostedInstall(config);
      return {
        installMode: hosted ? 'hosted' : 'self',
        configured: hosted ? hasUsejarvisAi(config) : options.isSelfConfigured(),
        completedAt: completion(storedObject('onboarding')),
      };
    },
    completeHosted(scope) {
      assertScope(scope);
      if (!options.isConfigLoaded() || !isHostedInstall(config) || !hasUsejarvisAi(config)) {
        throw new Error('Hosted setup is not available');
      }
      const stored = storedObject('onboarding');
      const existing = completion(stored);
      if (existing !== null) return existing;
      // Fail closed on corrupt settings before any write. The general settings
      // editor can repair them; onboarding must not erase a user's choices.
      const voice = storedObject('tts');
      const awareness = storedObject('awareness');
      if (voice?.enabled !== undefined && typeof voice.enabled !== 'boolean') throw new Error('Unreadable voice choice');
      const now = options.now?.() ?? Date.now();
      if (!Number.isFinite(now) || now <= 0) throw new Error('Invalid setup time');

      // Legacy startup includes Awareness. Persist off BEFORE the setup flag,
      // so even a crash and daemon reboot cannot start observation by default.
      // This path never enables it. Later explicit settings actions own opt-in.
      const disabledAwareness = { ...config.awareness, ...awareness, enabled: false } as JarvisConfig['awareness'];
      saveUserSection('awareness', disabledAwareness);
      config.awareness = disabledAwareness;

      // Reuse canonical settings services and the legacy hosted carve-outs.
      // No provider/key/model/default/STT patch can enter this adapter.
      const draft = structuredClone(config);
      saveLLMSettings(draft, { mode: 'multi-tier' });
      // Preserve an explicit voice choice, including a decline. Silent users
      // get the same provider-free included voice choice as legacy setup.
      const ttsPatch = { enabled: voice?.enabled ?? true };
      persistUserPatch('tts', ttsPatch);
      const onboarding = {
        ...config.onboarding, ...stored, setup_completed_at: now,
        tutorial_completed_at: stored?.tutorial_completed_at ?? config.onboarding?.tutorial_completed_at ?? null,
      } as NonNullable<JarvisConfig['onboarding']>;
      saveUserSection('onboarding', onboarding);
      config.llm = draft.llm;
      config.tts = mergeTTSConfig(config.tts, ttsPatch);
      config.onboarding = onboarding;
      return now;
    },
  };
}

/** Reuses host resolution, RPC validation/timeouts and OS permission checks. */
export function createDaemonPermissions(options: {
  owner: SetupScope;
  sidecars: PermissionsSidecarHost;
  /** Derived from the authenticated request's panel session, never its body. */
  panelSessionId(): string | null;
}): SetupPermissions {
  const assertScope = boundScope(options.owner);
  return {
    read(scope) {
      assertScope(scope);
      return readSystemPermissions(options.sidecars, options.panelSessionId());
    },
    async request(scope, name, expectedHostId) {
      assertScope(scope);
      const session = options.panelSessionId();
      const target = resolvePermissionsHost(options.sidecars, session);
      if ('reason' in target) return { available: false, reason: target.reason };
      if (target.id !== expectedHostId) return { available: false, reason: 'ambiguous' };
      // Freeze the resolved target for this request. A reconnect after the
      // preceding read cannot open a permission pane on a different device.
      return requestSystemPermission({
        getConnectedSidecars: () => [target],
        resolvePanelSession: () => ({ sid: target.id }),
        dispatchRPC: (id, method, params, timeouts) => options.sidecars.dispatchRPC(id, method, params, timeouts),
      }, session, name);
    },
  };
}
