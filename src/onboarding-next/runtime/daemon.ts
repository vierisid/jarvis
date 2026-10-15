/** Current daemon bindings. One owner/project per existing vault, shared across
 * enrolled devices. Nothing here creates a user, project, table or credential. */
import type { Database } from 'bun:sqlite';
import type { ApiContext } from '../../daemon/api-routes.ts';
import { isHostedInstall } from '../../daemon/usejarvis-ai.ts';
import { loadUserSectionStrict } from '../../daemon/user-settings.ts';
import { getDb } from '../../vault/schema.ts';
import { getUserProfile } from '../../vault/user-profile.ts';
import { hasUserProfile, USER_PROFILE_SETTING_KEY } from '../../user/profile.ts';
import { DEFAULT_IDS } from '../../workflows/db/schema.ts';
import { PANEL_SESSION_COOKIE } from '../../sidecar/panel-sessions.ts';
import { getCookie } from '../../util/cookie.ts';
import { createOnboardingRuntime, RuntimeError } from './runtime.ts';
import type { Binder, Context, ModuleEntry, Scope } from './contract.ts';

const OWNER: Scope = Object.freeze({ actorId: DEFAULT_IDS.user, projectId: DEFAULT_IDS.project });
function factory<T>(module: Record<string, unknown>, name: string): T {
  if (typeof module[name] !== 'function') throw new Error('Missing onboarding export');
  return module[name] as T;
}
/** The legacy progress route stores any string, but the journey accepts only
 * a 1..200 char identity. The step is a resume hint, so an unusable one is
 * dropped instead of leaving the journey permanently legacy_status_unknown (#1067). */
function legacyStepHint(step: unknown): string | null {
  return typeof step === 'string' && step.trim().length > 0 && step.length <= 200 ? step : null;
}
/** Strictly validate before using legacy normalizers that intentionally tolerate
 * corrupted data. Unreadable progress cannot create a synthetic new journey. */
export function readLegacyJourney(db: Database) {
  const stored = loadUserSectionStrict('onboarding');
  if (stored !== null && stored !== undefined && (typeof stored !== 'object' || Array.isArray(stored))) throw new Error('Unreadable legacy onboarding');
  const o = stored as Record<string, unknown> | null | undefined;
  for (const k of ['setup_completed_at', 'tutorial_completed_at', 'tutorial_dismissed_at'] as const) {
    if (o?.[k] != null && (typeof o[k] !== 'number' || !Number.isFinite(o[k]) || (o[k] as number) <= 0)) throw new Error('Unreadable legacy progress');
  }
  if (o?.setup_skipped_profile != null && typeof o.setup_skipped_profile !== 'boolean') throw new Error('Unreadable legacy skip');
  if (o?.tutorial_progress_step != null && typeof o.tutorial_progress_step !== 'string') throw new Error('Unreadable legacy tour');
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(USER_PROFILE_SETTING_KEY) as { value: string } | null;
  if (row) {
    const profile = JSON.parse(row.value);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.version !== 1
      || !profile.answers || typeof profile.answers !== 'object' || Array.isArray(profile.answers)
      || Object.values(profile.answers).some(v => typeof v !== 'string')
      || (profile.interview_facts !== undefined && !Array.isArray(profile.interview_facts))) throw new Error('Unreadable legacy profile');
    for (const fact of profile.interview_facts ?? []) {
      if (!fact || typeof fact !== 'object' || typeof fact.theme !== 'string' || typeof fact.summary !== 'string'
        || typeof fact.recorded_at !== 'number' || !Number.isFinite(fact.recorded_at)
        || (fact.raw_quote !== undefined && typeof fact.raw_quote !== 'string')) throw new Error('Unreadable legacy profile fact');
    }
  }
  return {
    setup_completed: o?.setup_completed_at != null, setup_skipped_profile: o?.setup_skipped_profile === true,
    profile_completed: hasUserProfile(getUserProfile()), tutorial_completed: o?.tutorial_completed_at != null,
    tutorial_dismissed: o?.tutorial_dismissed_at != null, tutorial_progress_step: legacyStepHint(o?.tutorial_progress_step),
  };
}
export function daemonBindings(ctx: ApiContext, authorize: (req: Request) => Scope | null): Partial<Record<import('./contract.ts').Capability, Binder>> {
  type JourneyResult = { availability: string; snapshot?: { journeyId: string; revision: number; setupState: string } };
  type Journey = { read(): Promise<JourneyResult>; transition(input: unknown): Promise<unknown>; acknowledge(input: unknown): Promise<JourneyResult> };
  let journeyFor: ((c: Context) => Journey) | undefined;
  let setupStart: Promise<void> | null = null;
  let setupBindingsDirty = false;
  const recheck = (c: Context) => {
    const current = authorize(c.request);
    if (c.signal.aborted || current?.actorId !== c.scope.actorId || current?.projectId !== c.scope.projectId) throw new RuntimeError('unauthorized', 401);
  };
  return {
    'journey.v1': module => {
      const create = factory<(deps: { authorize(): Promise<Scope | null>; persistence: unknown }) => Journey>(module, 'createJourneyProvider');
      const persistence = factory<(deps: { databaseForScope(scope: Scope): Database; readLegacy(scope: Scope): unknown }) => unknown>(module, 'createSettingsJourneyPersistence')({
        databaseForScope: scope => { if (scope.actorId !== OWNER.actorId || scope.projectId !== OWNER.projectId) throw new Error('Owner mismatch'); return getDb(); },
        readLegacy: () => readLegacyJourney(getDb()),
      });
      const bound = (c: Context) => create({ authorize: async () => { recheck(c); return c.scope; }, persistence });
      journeyFor = bound;
      return {
        probe: () => { readLegacyJourney(getDb()); return { ready: true, reason: 'ready' }; },
        operations: { 'journey.read': async (_input, c) => bound(c).read(), 'journey.transition': async (input, c) => bound(c).transition(input) },
      };
    },
    'setup.v1': module => {
      // The public factory/adapter are supplied only by the optional B02 entry.
      const store = factory<(options: unknown) => { read(scope: Scope): { installMode: string; configured: boolean; completedAt: number | null }; completeHosted(scope: Scope): number }>(module, 'createDaemonSetupStore')({
        owner: OWNER, config: ctx.config, isConfigLoaded: () => !!ctx.config.daemon,
        isSelfConfigured: () => ctx.agentService.getLLMManager().getProviderNames().length > 0,
      });
      const create = factory<(options: unknown) => { read(c: Context): Promise<unknown>; complete(c: Context, input: unknown): Promise<unknown> }>(module, 'createSetupProvider');
      // Each operation captures its live request for checks at the actual
      // persistence/service boundary. The store's synchronous completion is
      // idempotent, and the host startup is single-flight across requests.
      const provider = (c: Context) => create({
        authorize: () => { recheck(c); return c.scope; },
        store: {
          read: (scope: Scope) => { recheck(c); return store.read(scope); },
          completeHosted: (scope: Scope) => {
            recheck(c);
            if (store.read(scope).completedAt === null) setupBindingsDirty = true;
            return store.completeHosted(scope);
          },
        },
        services: {
          read: async () => {
            recheck(c);
            const readiness = ctx.onboardingServiceReadiness?.() ?? 'unavailable';
            return setupBindingsDirty && readiness !== 'unavailable' ? 'stopped' : readiness;
          },
          start: async () => {
            recheck(c);
            if (!ctx.startPostSetupServices || !ctx.settingsReload || !ctx.onboardingServiceReadiness) throw new Error('Setup services unavailable');
            if (!setupStart) setupStart = (async () => {
              const applied = await ctx.settingsReload!.reloadAll();
              if (applied.errors.length) throw new Error('Setup binding unavailable');
              // B02 also updates live config. Those values may compare equal
              // during reloadAll, so explicitly apply any skipped bindings.
              for (const section of ['llm', 'tts', 'awareness'] as const) {
                recheck(c);
                if (!applied.applied.includes(section) && await ctx.settingsReload!.applyNow(section)) throw new Error('Setup binding unavailable');
              }
              recheck(c);
              await ctx.startPostSetupServices!();
              recheck(c);
              if (ctx.onboardingServiceReadiness!() === 'running') setupBindingsDirty = false;
            })().finally(() => { setupStart = null; });
            await setupStart;
            recheck(c);
          },
        },
      });
      return {
        probe: () => {
          const current = store.read(OWNER);
          return { ready: current.installMode !== 'unknown' && (current.installMode !== 'hosted' || current.configured)
            && !!ctx.settingsReload && !!ctx.startPostSetupServices && !!ctx.onboardingServiceReadiness, reason: 'provider_unavailable' };
        },
        operations: {
          'setup.read': async (_input, c) => provider(c).read(c),
          'setup.complete': async (input, c) => {
            const result = await provider(c).complete(c, input) as { ready?: boolean };
            recheck(c);
            if (result.ready === true) {
              // Internal acknowledgement is based on the real setup result,
              // never on a client-supplied acknowledgement or completion flag.
              if (!journeyFor) throw new RuntimeError('dependency_unavailable', 503);
              const journey = journeyFor(c), current = await journey.read();
              if (current.availability !== 'ready' || !current.snapshot) throw new RuntimeError('provider_unavailable', 503);
              if (current.snapshot.setupState !== 'completed') {
                const ack = await journey.acknowledge({ journeyId: current.snapshot.journeyId,
                  expectedRevision: current.snapshot.revision, requestId: crypto.randomUUID(), command: { type: 'setup_completed' } });
                if (ack.availability !== 'ready') throw new RuntimeError('conflict', 409);
              }
            }
            return result;
          },
        },
      };
    },
    // B03 requires canonical owner-bound OAuth services and a trusted hosted
    // public client ID; the current daemon does not supply that full contract.
    // B04 also needs B05's effect-staging/profile port and retention integration.
    // Deliberately no fallback bindings to legacy inline writes or token booleans.
  };
}
export function createDaemonOnboardingRuntime(ctx: ApiContext, modules: readonly ModuleEntry[]) {
  const authorize = (request: Request): Scope | null => {
    const cookie = getCookie(request, PANEL_SESSION_COOKIE);
    // No new bypass for auth.insecure_open_access. That bootstrap path still
    // uses legacy onboarding; new routes always need an enrolled live session.
    return cookie && ctx.sidecarManager?.resolvePanelSession(cookie) ? OWNER : null;
  };
  return createOnboardingRuntime({
    modules, authorize, bindings: daemonBindings(ctx, authorize),
    installMode: () => !ctx.config.daemon ? 'unknown' : isHostedInstall(ctx.config) ? 'hosted' : 'self',
    // Release assembly must later supply the exact U11/B13/D/F/Q decision.
    // No request, persisted setting, URL or environment flag enables it here.
    enabled: false,
  });
}
