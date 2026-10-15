import { createTourSandbox, type WorkspaceState } from './sandbox.ts';
import { isTourStep } from './steps.ts';
import type { TourCommand, TourResult, TourSnapshot } from './types.ts';

type Context = { journey: { scopeId: string; journeyId: string; revision: number }; signal: AbortSignal };
/** Structural U10 adapter. Render ports are trusted local D implementations,
 * never values read from transport. No registration or sibling imports. */
export function createTourViewAdapter(deps: {
  scopeId: string; workspace: WorkspaceState;
  call(command: TourCommand, signal: AbortSignal): Promise<TourResult>;
  /** Must observe verified room and shell availability without startup effects. */
  available(): boolean;
  renderer: { isolation: 'fixture-only'; renderRoom(request: any): unknown };
  pebble: { isolation: 'tutorial-sandbox'; Surface: unknown };
}) {
  const sandbox = createTourSandbox(deps.scopeId, deps.workspace);
  const listeners = new Set<() => void>();
  let current: TourSnapshot | null = null, disposed = false;
  let pending: { key: string; command: TourCommand } | null = null;
  const fail = () => { throw new Error('Tour unavailable'); };
  function check(c: Context) {
    if (disposed || c.signal.aborted || c.journey.scopeId !== deps.scopeId || !deps.available()) fail();
  }
  function ready(result: TourResult, c: Context) {
    check(c);
    if (result?.availability !== 'ready') return fail();
    const s = result.snapshot;
    if (!s || s.schemaVersion !== 1 || s.scopeId !== deps.scopeId || s.sessionId !== c.journey.journeyId
      || !Number.isSafeInteger(s.revision) || s.revision < 0 || typeof s.active !== 'boolean'
      || (s.active ? !isTourStep(s.stepId) : s.stepId !== null)
      || !['ready', 'unavailable', 'unsupported'].includes(s.roomStatus)
      || s.journey?.scopeId !== s.scopeId || s.journey.journeyId !== s.sessionId || s.journey.revision !== s.revision) return fail();
    return result.snapshot;
  }
  const changeOpen = (value: boolean) => {
    if (disposed || !deps.available()) return fail();
    sandbox.setPebbleOpen(value); listeners.forEach(notify => notify());
  };
  return {
    available: () => !disposed && deps.available() && deps.renderer.isolation === 'fixture-only' && deps.pebble.isolation === 'tutorial-sandbox',
    async read(c: Context) {
      check(c);
      const next = ready(await deps.call({ type: 'read' }, c.signal), c);
      // U10 reads the journey first. A concurrent update requires a fresh host
      // read, not a model from one revision paired with another navigation key.
      if (next.revision !== c.journey.revision || !next.active) return fail();
      current = next;
      const state = sandbox.present(next);
      return { model: { ...state.model }, ports: {
        renderer: state.roomStatus === 'ready' ? deps.renderer : { isolation: 'fixture-only',
          renderRoom: () => ({ status: state.roomStatus === 'unsupported' ? 'unsupported' : 'error' }) },
        adapter: { isolation: 'tutorial-sandbox', status: state.roomStatus === 'unavailable' ? 'error' : state.roomStatus, open: state.chat.open,
          Surface: deps.pebble.Surface, onOpenChange: changeOpen },
      } };
    },
    async command(c: Context, action: string, input?: unknown) {
      check(c);
      if (!current || current.revision !== c.journey.revision || current.sessionId !== c.journey.journeyId || !current.active) return fail();
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
      const i = input as Record<string, unknown>;
      if (i.action !== action || i.sessionId !== current.sessionId || i.revision !== current.revision || i.from !== current.stepId || !isTourStep(i.from)) return fail();
      if (action === 'open-pebble') { changeOpen(true); return; }
      if (!['next', 'back', 'skip', 'finish'].includes(action)) return fail();
      if ((action === 'next' || action === 'finish') && i.from === 'pebble' && !sandbox.read().chat.open) return fail();
      const value = { type: 'navigate' as const, sessionId: current.sessionId, revision: current.revision,
        from: i.from, action: action as 'next' | 'back' | 'skip' | 'finish', ...(i.to !== undefined ? { to: i.to as any } : {}) };
      const key = JSON.stringify(value);
      // Retain the exact receipt identity when transport loses an acknowledgement.
      if (!pending || pending.key !== key) pending = { key, command: { ...value, requestId: crypto.randomUUID() } };
      const next = ready(await deps.call(pending.command, c.signal), c);
      if (next.revision <= current.revision) return fail();
      sandbox.present(next); current = next; pending = null;
    },
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    dispose() { disposed = true; current = null; pending = null; listeners.clear(); sandbox.dispose(); },
  };
}
