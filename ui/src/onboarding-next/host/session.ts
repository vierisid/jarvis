import { uuid } from '../../lib/uuid.ts';
import type { Configuration, Context, FeatureAdapter, Journey, LoadedViews, Status, ViewId } from './contract.ts';
import { bounded, closure, loadViews, parseJourney, parseStatus, configured, viewFor } from './policy.ts';
import { Unavailable } from './transport.ts';

type Presentation = Awaited<ReturnType<FeatureAdapter['read']>>;
export interface HostState {
  mode: 'checking' | 'legacy' | 'journey' | 'complete';
  journey: Journey | null; view: ViewId | 'legacy-provider-setup' | null;
  presentation: Presentation | null; busy: boolean; blocked: boolean;
}
/** One gate selection per mount. Once entered, no failure can mount legacy.
 * Provider adapters retain scoped drafts; this controller never writes progress. */
export function createSession(config: Configuration) {
  let state: HostState = { mode: 'checking', journey: null, view: null, presentation: null, busy: false, blocked: false };
  let status: Status | null = null, views: LoadedViews | null = null;
  let disposed = false, started = false, inFlight = false, refreshQueued = false;
  const adapters: Partial<Record<keyof Configuration['adapters'], FeatureAdapter>> = {};
  let editing = false;
  const abort = new AbortController(), listeners = new Set<() => void>(), unsubscribes: Array<() => void> = [];
  const update = (patch: Partial<HostState>) => {
    if (disposed) return;
    state = { ...state, ...patch }; for (const notify of listeners) notify();
  };
  const context = (): Context => {
    if (!state.journey || !status || status.installMode === 'unknown' || disposed) throw new Unavailable();
    return { journey: Object.freeze(structuredClone(state.journey)), installMode: status.installMode, signal: abort.signal };
  };
  async function check() {
    if (disposed) throw new Unavailable();
    const next = parseStatus(await bounded(config.transport.status(abort.signal), abort.signal));
    if (!closure(config, next) || (status && next.installMode !== status.installMode)) throw new Unavailable();
    status = next;
  }
  async function read() {
    if (disposed) throw new Unavailable();
    let next = parseJourney(await bounded(config.transport.call('journey.read', {}, abort.signal), abort.signal));
    const previous = state.journey;
    if (previous && (next.scopeId !== previous.scopeId || next.journeyId !== previous.journeyId || next.revision < previous.revision)) throw new Unavailable();
    if (next.completion !== 'active' && !(next.stepId === 'tour' && next.replayReturnStepId)) {
      update({ mode: 'complete', journey: next, view: null, presentation: null, blocked: false }); return;
    }
    // A migrated completed/skipped tour must not replay just because setup or
    // the interview finished later. Advancing to Activation does not finish it.
    if (next.stepId === 'tour' && !next.replayReturnStepId && ['done', 'skipped'].includes(next.tourState)) {
      const before = next;
      next = parseJourney(await bounded(config.transport.call('journey.transition', {
        journeyId: before.journeyId, expectedRevision: before.revision, requestId: uuid(),
        command: { type: 'navigate', stepId: 'activation' },
      }, abort.signal), abort.signal));
      if (next.scopeId !== before.scopeId || next.journeyId !== before.journeyId || next.revision <= before.revision || next.stepId !== 'activation') throw new Unavailable();
    }
    let view = viewFor(next);
    if (view === 'legacy-provider-setup' && status?.installMode !== 'self') throw new Unavailable();
    const adapter = adapters[view as keyof Configuration['adapters']];
    let presentation = adapter ? await bounded(adapter.read({ ...contextFor(next), signal: abort.signal }), abort.signal) : null;
    // B06 maps legacy hints without mutating on read. Its acknowledged model
    // selects the tour presentation even before the first canonical step write.
    if (next.stepId === 'tour' && typeof presentation?.model?.stepId === 'string') {
      const target = presentation.model.stepId === 'pebble' ? 'pebble-tour' : 'tour';
      if (view !== target) {
        view = target;
        const alternate = adapters[target];
        if (!alternate) throw new Unavailable();
        presentation = await bounded(alternate.read(contextFor(next)), abort.signal);
        if ((presentation.model.stepId === 'pebble') !== (target === 'pebble-tour')) throw new Unavailable();
      }
    }
    if (view !== 'welcome' && view !== 'explainer' && (!presentation || !presentation.model || typeof presentation.model !== 'object')) throw new Unavailable();
    // Scope/revision are committed together with the model, never a half-screen.
    update({ mode: 'journey', journey: next, view, presentation, blocked: false });
  }
  function contextFor(journey: Journey): Context {
    if (!status || status.installMode === 'unknown') throw new Unavailable();
    return { journey: Object.freeze(structuredClone(journey)), installMode: status.installMode, signal: abort.signal };
  }
  async function navigate(command: Record<string, unknown>) {
    const j = context().journey;
    const result = await bounded(config.transport.call('journey.transition', {
      journeyId: j.journeyId, expectedRevision: j.revision, requestId: uuid(), command,
    }, abort.signal), abort.signal, ['finish', 'explore'].includes(String(command.type)) ? 120000 : 5000);
    // A successful HTTP envelope may still contain a revision conflict.
    parseJourney(result);
  }
  const key = () => state.journey ? `${state.journey.journeyId}:${state.journey.revision}:${state.view}` : '';
  function finishFlight() {
    inFlight = false;
    // An invalidation during a command/start still needs a fresh authoritative
    // read. Keep the view locked until it settles; never replay the mutation.
    if (refreshQueued && !disposed && !state.blocked && state.mode === 'journey') void refresh();
    else { refreshQueued = false; update({ busy: false }); }
  }
  async function refresh() {
    if (disposed || !started || state.mode === 'legacy') return;
    if (inFlight) { refreshQueued = true; return; }
    inFlight = true; update({ busy: true });
    try {
      do {
        refreshQueued = false;
        await check(); await read();
      } while (refreshQueued && !disposed && state.mode === 'journey');
    }
    catch { update({ blocked: true }); }
    finally { finishFlight(); }
  }
  async function act(expected: string, action: string, input?: unknown) {
    if (disposed || inFlight || state.mode !== 'journey' || state.blocked || expected !== key()) return;
    inFlight = true; update({ busy: true });
    try {
      await check();
      const view = state.view!;
      if (view === 'welcome') {
        if (action === 'explore') { update({ mode: 'complete' }); return; }
        if (action === 'continue') await navigate({ type: 'navigate', stepId: 'explain' });
        else throw new Unavailable();
      } else if (view === 'explainer') {
        if (action === 'back') await navigate({ type: 'navigate', stepId: 'welcome' });
        else if (action === 'continue') {
          if (status!.installMode === 'self' && state.journey!.setupState !== 'completed') await navigate({ type: 'navigate', stepId: 'legacy-provider-setup' });
          else {
            const result = await bounded(config.transport.call('setup.complete', { action: 'complete_setup' }, abort.signal), abort.signal);
            if (!result || typeof result !== 'object' || (result as { ready?: unknown }).ready !== true) throw new Unavailable();
            await read(); // B02 acknowledges setup and advances the journey revision.
            await navigate({ type: 'navigate', stepId: 'google' });
          }
        } else throw new Unavailable();
      } else if (view === 'google' && ['back', 'skip', 'continue'].includes(action)) {
        // The Google owner cancels any pending attempt before leaving; opening
        // a window or navigating is never connection acknowledgement.
        await bounded(adapters.google!.command(context(), action === 'continue' ? 'continue' : 'skip'), abort.signal);
        await navigate({ type: 'navigate', stepId: action === 'back' ? 'explain' : 'interview' });
      } else if (view === 'interview' && action === 'continue') {
        await navigate({ type: 'navigate', stepId: 'tour' });
      } else if (view === 'activation' && (action === 'back' || action === 'explore')) {
        // The view supplied its current draft; save it before leaving the screen.
        adapters.activation!.setDraft?.(context(), (input as { draft?: unknown })?.draft);
        await navigate(action === 'back' ? { type: 'replay_tutorial' } : { type: 'explore' });
      } else {
        const adapter = adapters[view as keyof Configuration['adapters']];
        if (!adapter) throw new Unavailable();
        await bounded(adapter.command(context(), action, input), abort.signal, ['finish', 'open_workflow', 'explore'].includes(action) ? 120000 : 5000);
      }
      await read();
    } catch { update({ blocked: true }); }
    finally { finishFlight(); }
  }
  return {
    state: () => state,
    views: () => views,
    installMode: () => status?.installMode ?? 'unknown',
    key,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start() {
      if (started || disposed) return;
      started = true;
      if (!configured(config)) { update({ mode: 'legacy' }); return; }
      inFlight = true;
      try {
        await check();
        views = await bounded(loadViews(config), abort.signal);
        for (const [name, binding] of Object.entries(config.adapters)) {
          if (binding) {
            const adapter = binding.create();
            if (!adapter.available() || typeof adapter.read !== 'function' || typeof adapter.command !== 'function'
              || (['interview', 'activation'].includes(name) && typeof adapter.setDraft !== 'function')) throw new Unavailable();
            adapters[name as keyof typeof adapters] = adapter;
          }
        }
        // Select once before the first journey read (which may initialize B01).
        // Failures after this point must not silently start the old journey.
        update({ mode: 'journey', busy: true });
        // Subscribe before reading so a transient first read cannot leave a
        // recovered session permanently disconnected from provider events.
        for (const adapter of Object.values(adapters)) {
          if (adapter?.subscribe) unsubscribes.push(adapter.subscribe(() => { if (!editing) void refresh(); }));
        }
        await read();
      } catch (error) { if (config.integration) console.warn('Local onboarding startup failed', error); if (state.mode === 'checking') update({ mode: 'legacy' }); else update({ blocked: true }); }
      finally { finishFlight(); }
    },
    refresh, act,
    draft(expected: string, value: unknown) {
      if (disposed || inFlight || state.blocked || expected !== key()) return;
      const adapter = adapters[state.view as keyof Configuration['adapters']];
      try {
        if (!adapter?.setDraft) throw new Unavailable();
        editing = true;
        const presentation = adapter.setDraft(context(), value);
        update({ presentation });
      } catch { update({ blocked: true }); }
      finally { editing = false; }
    },
    dispose() {
      disposed = true; refreshQueued = false; abort.abort(); listeners.clear(); unsubscribes.forEach(fn => fn());
      for (const adapter of Object.values(adapters)) adapter?.dispose?.();
    },
  };
}
export type Session = ReturnType<typeof createSession>;
