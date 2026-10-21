/** Canonical daemon services for the optional onboarding host. Provision once
 * per vault; no credentials, model configuration or scope come from the client. */
import { createHash } from 'node:crypto';
import type { ApiContext } from '../../daemon/api-routes';
import type { ComposeDeps } from '../../actions/tools/workflow-composer';
import { getWorkflowDb, DEFAULT_IDS } from '../../workflows/db';
import { CompositionIngredients } from '../../workflows/db/repos/composition-ingredients';
import type { CompositionIngredient } from '../../workflows/runtime/composition-ingredients';
import { PANEL_SESSION_COOKIE } from '../../sidecar/panel-sessions';
import { getCookie } from '../../util/cookie';
import { isHostedInstall } from '../../daemon/usejarvis-ai';
import { classifyGoogle, googleIdentity, makeGoogleAuth } from '../../integrations/google-managed-refresh';
import { GoogleAuth } from '../../integrations/google-auth';
import { GoogleOAuthFlowStore } from '../../integrations/google-oauth-flow';
import { createDaemonSetupStore } from '../setup';
import { createStagedInterviewer } from '../interview-profile';
import { createGoogleGrantReader } from '../google/verify-grant';
import type { GoogleBinding } from '../google/types';
import type { ContextRef, Reference, IntentServices } from '../activation-intent/types';
import { scopeId } from '../build-jobs/input';
import { readLegacyJourney } from './daemon';
import { createOnboardingAssembly } from './assembly';
import { createOnboardingRuntime } from './runtime';
import type { ModuleEntry, RuntimeOptions, Scope } from './contract';

export interface DaemonAssemblyOptions {
  composer(): ComposeDeps | null;
  /** Trusted canonical origin configured by the host, never Host/request headers. */
  origin: string;
  /** Explicit isolated local daemon acceptance, validated before services start. */
  localIntegration?: boolean;
  roomStatus: Parameters<typeof createOnboardingAssembly>[0]['roomStatus'];
  /** The release owner supplies these only after verifying the exact candidate. */
  release?: Pick<RuntimeOptions, 'enabled' | 'candidate' | 'authorizeRelease'>;
  /** Hosted Google needs the control plane's public OAuth client ID. */
  hostedGoogleClientId?: string;
}
export function createDaemonOnboardingAssembly(ctx: ApiContext, modules: readonly ModuleEntry[], options: DaemonAssemblyOptions) {
  const owner = Object.freeze({ actorId: DEFAULT_IDS.user, projectId: DEFAULT_IDS.project });
  const db = getWorkflowDb(), generation = crypto.randomUUID();
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid onboarding origin');
  const authorize = (request: Request): Scope | null => {
    const cookie = getCookie(request, PANEL_SESSION_COOKIE);
    return cookie && ctx.sidecarManager?.resolvePanelSession(cookie) ? owner : null;
  };
  const valid = (scope: Scope) => { if (scope.actorId !== owner.actorId || scope.projectId !== owner.projectId || getWorkflowDb() !== db) throw new Error('Owner unavailable'); };
  let setupStart: Promise<void> | null = null, bindingsDirty = false;
  const setupStore = createDaemonSetupStore({ owner, config: ctx.config, isConfigLoaded: () => !!ctx.config.daemon,
    isSelfConfigured: () => ctx.agentService.getLLMManager().getProviderNames().length > 0 });
  let googleKey: string | null | undefined, google: GoogleBinding | null = null;
  function googleFor(scope: Scope) {
    valid(scope);
    const key = googleIdentity(ctx.config);
    if (key === googleKey) return google;
    googleKey = key;
    const shape = classifyGoogle(ctx.config), mode = isHostedInstall(ctx.config) ? 'hosted' : 'self';
    const auth = makeGoogleAuth(ctx.config, undefined, ctx.googleTokensPath);
    const clientId = shape.mode === 'self' ? shape.clientId : options.hostedGoogleClientId ?? '';
    google = { id: crypto.randomUUID(), owner, installMode: mode,
      readGrant: auth ? createGoogleGrantReader({ auth: () => googleIdentity(ctx.config) === key ? auth : null, clientId }) : async () => ({ state: 'absent' }) };
    if (mode === 'hosted') google.hostedConnectUrl = ctx.config.google?.connect_url;
    else if (shape.mode === 'self') {
      const redirectUri = new URL('/api/onboarding-next/v1/google/return', origin).href;
      google.self = { redirectUri, flows: new GoogleOAuthFlowStore(),
        auth: new GoogleAuth(shape.clientId, shape.clientSecret, { tokensPath: ctx.googleTokensPath, redirectUri }),
        onTokensSaved: () => ctx.settingsReload?.sectionChanged('google') };
    }
    return google;
  }
  function catalog() {
    const dependencies = options.composer(); if (!dependencies) throw new Error('Composer unavailable');
    return new CompositionIngredients(db, dependencies.pieceRegistry, owner.projectId, owner.actorId);
  }
  // Opaque references select only entries in the canonical, scoped catalog.
  // Library action identity includes the operation, not just its piece package.
  const referenceId = (s: CompositionIngredient) => s.kind === 'connection' ? s.id : JSON.stringify([s.id, s.actionName]);
  function selection(ref: ContextRef): CompositionIngredient | null {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = catalog().list(offset);
      const found = page.ingredients.find(item => item.selection.kind === ref.kind && referenceId(item.selection) === ref.id);
      if (found) return found.selection;
      offset = page.nextOffset;
    }
    return null;
  }
  const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const intent: IntentServices = {
    id: generation,
    access: async () => options.composer() ? 'ready' : 'unsupported',
    resolve: async ref => {
      const chosen = selection(ref); if (!chosen) return { availability: 'unavailable' };
      const resolved = catalog().resolve([chosen]);
      if (resolved.issues.length) return { availability: 'unavailable' };
      const reference: Reference = { scopeId: scopeId(owner), ref, revision: revision(resolved.ingredients) };
      return { availability: 'ready', reference };
    },
    assess: async input => {
      const selected = input.references.map(reference => selection(reference.ref));
      const resolved = catalog().resolve(selected.filter((v): v is CompositionIngredient => !!v));
      return { schemaVersion: 1, issues: resolved.issues.map((message, i) => ({ id: `ingredient-${i}`, kind: 'connection',
        label: 'Selected context', message, code: 'missing_connection', blocking: true })) };
    },
  };
  const assembly = createOnboardingAssembly({ owner, database: db, authorize, readLegacy: () => readLegacyJourney(db),
    setup: context => {
      const valid = (scope: Scope) => {
        const current = authorize(context.request);
        if (context.signal.aborted || current?.actorId !== scope.actorId || current.projectId !== scope.projectId || getWorkflowDb() !== db) throw new Error('Owner unavailable');
      };
      return { store: { read: scope => { valid(scope); return setupStore.read(scope); }, completeHosted: async scope => {
      valid(scope); if ((await setupStore.read(scope)).completedAt === null) bindingsDirty = true;
      return setupStore.completeHosted(scope);
    } }, services: {
      read: async scope => { valid(scope); const state = ctx.onboardingServiceReadiness?.() ?? 'unavailable'; return bindingsDirty && state !== 'unavailable' ? 'stopped' : state; },
      start: async scope => {
        valid(scope);
        if (!ctx.settingsReload || !ctx.startPostSetupServices || !ctx.onboardingServiceReadiness) throw new Error('Setup unavailable');
        setupStart ??= (async () => {
          const applied = await ctx.settingsReload!.reloadAll(); valid(scope);
          if (applied.errors.length) throw new Error('Setup reload failed');
          for (const section of ['llm', 'tts', 'awareness'] as const) {
            if (!applied.applied.includes(section) && await ctx.settingsReload!.applyNow(section)) throw new Error('Setup binding unavailable'); valid(scope);
          }
          await ctx.startPostSetupServices!(); valid(scope);
          if (ctx.onboardingServiceReadiness!() === 'running') bindingsDirty = false;
        })().finally(() => { setupStart = null; });
        await setupStart;
      },
    } }; },
    google: googleFor, interviewer: createStagedInterviewer({ llmForScope: scope => { valid(scope); return ctx.agentService.getLLMManager(); } }),
    intent: scope => { valid(scope); return intent; }, composer: () => { const deps = options.composer(); if (!deps) throw new Error('Composer unavailable'); return deps; },
    resolveContext: async input => {
      const selected = input.references.map(reference => {
        const chosen = selection(reference.ref); if (!chosen) throw new Error('Context changed'); return chosen;
      });
      const resolved = catalog().resolve(selected); if (resolved.issues.length) throw new Error('Context changed');
      return { ingredients: resolved.ingredients };
    },
    roomStatus: options.roomStatus,
    ready: () => !!ctx.settingsReload && !!ctx.startPostSetupServices && !!ctx.onboardingServiceReadiness && !!options.composer(),
  });
  // Production remains inactive until the release owner supplies a decision.
  const runtime = createOnboardingRuntime({ modules, bindings: assembly.bindings, authorize,
    installMode: () => isHostedInstall(ctx.config) ? 'hosted' : 'self', ...options.release,
    ...(options.localIntegration ? { enabled: true, authorizeIntegration: () => !isHostedInstall(ctx.config) } : {}) });
  return { runtime: { ...runtime, async execute(request: Request, operation: Parameters<typeof runtime.execute>[1], input: unknown) {
    // A rollout flag alone must never dispatch durable model jobs.
    const status = await runtime.status(request);
    if (status.ready) assembly.start();
    return runtime.execute(request, operation, input);
  } }, stop: assembly.stop, idle: assembly.idle };
}
