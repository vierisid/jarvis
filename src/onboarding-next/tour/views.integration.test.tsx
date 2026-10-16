import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createTourProvider, createTourViewAdapter, TOUR_STEPS } from './index.ts';
import { owner, key } from './test-fixture.ts';
const paths = { journey: '../journey/index.ts', rooms: '../../../ui/src/onboarding-next/views/tour/index.tsx',
  pebble: '../../../ui/src/onboarding-next/views/pebble-tour/index.tsx', shell: '../../../ui/src/brief/shell/pebble-layout/PebbleLayout.tsx',
  host: '../../../ui/src/onboarding-next/host/session.ts', hostFixture: '../../../ui/src/onboarding-next/host/test-fixture.ts' };
const available = ['journey', 'rooms', 'pebble', 'shell'].every(k => existsSync(join(import.meta.dir, paths[k as keyof typeof paths])));
let act: any, createRoot: any, RoomView: any, PebbleView: any, PebbleLayout: any, root: any, host: HTMLElement, db: Database;
const originalAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
let closeAdapter: (() => void) | undefined;

describe.skipIf(!available)('real U05/U06 views, D06 shell and B01/B06 progress', () => {
  beforeAll(async () => {
    GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client'));
    ({ TourView: RoomView } = await import(paths.rooms)); ({ PebbleTourView: PebbleView } = await import(paths.pebble));
    ({ PebbleLayout } = await import(paths.shell));
  });
  afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; host?.remove(); closeAdapter?.(); closeAdapter = undefined; db?.close(); });
  afterAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = originalAct; GlobalRegistrator.unregister(); });
  async function fixture(legacy: Record<string, unknown> = {}) {
    const { createJourneyProvider, createSettingsJourneyPersistence } = await import(paths.journey);
    db = new Database(':memory:'); db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    const journey = createJourneyProvider({ authorize: () => owner, persistence: createSettingsJourneyPersistence({ databaseForScope: () => db,
      readLegacy: () => ({ setup_completed: true, setup_skipped_profile: true, profile_completed: false, tutorial_completed: false, tutorial_dismissed: false, tutorial_progress_step: null, ...legacy }) }) });
    const provider = createTourProvider({ enabled: true, authorize: () => owner, journeyFor: () => journey, roomStatus: () => 'ready' });
    const workspace = { roomId: 'workflows', selectedObject: { kind: 'draft', id: 'original-version' }, theme: 'dark' as const, sidebar: 'rail' as const, chat: { open: true, conversationId: 'original-chat' } };
    const original = structuredClone(workspace); let effects = 0, last: any, presentation: any;
    function Surface({ open, onOpenChange }: any) {
      return <PebbleLayout enabled reducedMotion shell={{ mode: 'preview', chatOpen: open, setChatOpen: onOpenChange }}
        conversation={{ source: 'fixture', content: <textarea data-pebble-focus aria-label="Unsent tutorial draft" defaultValue="Kept sample draft" /> }}>
        <main data-selection="original-version">Read-only workspace</main>
      </PebbleLayout>;
    }
    const adapter = createTourViewAdapter({ scopeId: key(), workspace, available: () => true, call: (c, signal) => provider.request(null, c, signal),
      renderer: { isolation: 'fixture-only', renderRoom: request => ({ status: 'ready', content: <main data-room={request.step.id}><button onClick={() => effects++}>Live action trap</button></main> }) },
      pebble: { isolation: 'tutorial-sandbox', Surface } });
    closeAdapter = adapter.dispose;
    const context = async () => ({ journey: (await journey.read()).snapshot, signal: new AbortController().signal });
    async function render() {
      last = await context();
      if (last.journey.stepId !== 'tour') { await act(async () => root.render(<div data-activation>First workflow</div>)); return; }
      presentation = await adapter.read(last);
      const View = presentation.model.stepId === 'pebble' ? PebbleView : RoomView;
      await act(async () => root.render(<View model={presentation.model} {...presentation.ports} reducedMotion onNavigate={async (intent: any) => { await adapter.command(last, intent.action, intent); }} />));
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); await render();
    const click = async (label: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
      if (!button) throw Error(`Missing ${label}`); await act(async () => button.click()); await render();
    };
    return { journey, provider, adapter, context, render, click, workspace, original, effects: () => effects };
  }
  test('walk all rooms, preserve the original workspace, retain the D06 surface on close/reopen and finish at activation', async () => {
    const f = await fixture();
    for (const step of TOUR_STEPS.slice(0, -1)) {
      expect(host.querySelector('[data-room]')?.getAttribute('data-room')).toBe(step);
      await f.click('Live action trap'); expect(f.effects()).toBe(0);
      await f.click('Next');
    }
    expect(host.querySelector('.on-pebble-tour')).not.toBeNull(); await f.click('Open Pebble');
    const draft = host.querySelector('textarea'); expect(draft?.value).toBe('Kept sample draft');
    for (let i = 0; i < 3; i++) { await f.click('Close conversation'); await f.click('Open Pebble'); expect(host.querySelector('textarea')).toBe(draft); }
    await f.click('Let’s build your first workflow'); expect(host.querySelector('[data-activation]')).not.toBeNull();
    expect((await f.journey.read()).snapshot).toMatchObject({ stepId: 'activation', completion: 'active', tourState: 'done' });
    expect(f.workspace).toEqual(f.original); expect(f.effects()).toBe(0);
  });
  test('Memory refresh and Back retain authoritative progress before skip', async () => {
    const f = await fixture({ tutorial_progress_step: 'brief:v1:context' });
    expect(host.querySelector('[data-room]')?.getAttribute('data-room')).toBe('memory'); await f.render();
    expect(host.querySelector('[data-room]')?.getAttribute('data-room')).toBe('memory');
    await f.click('Back'); expect(host.querySelector('[data-room]')?.getAttribute('data-room')).toBe('goals');
    await f.click('Skip tour'); expect((await f.journey.read()).snapshot).toMatchObject({ stepId: 'activation', tourState: 'skipped', completion: 'active' });
  });
  test.skipIf(!existsSync(join(import.meta.dir, paths.host)))('U10 routes the authoritative migrated Pebble hint to U06', async () => {
    const f = await fixture({ tutorial_progress_step: 'brief:v1:talk' });
    const { fixture: hostFixture } = await import(paths.hostFixture), { createSession } = await import(paths.host);
    const h = hostFixture(); h.config.transport.call = async (op: string, input: any) => op === 'journey.read' ? f.journey.read() : f.journey.transition(input);
    h.config.adapters.tour = h.config.adapters['pebble-tour'] = { available: () => true, create: () => f.adapter };
    const session = createSession(h.config); await session.start();
    expect(session.state().view).toBe('pebble-tour'); expect(session.state().presentation.model.stepId).toBe('pebble'); session.dispose();
  });
  test.skipIf(!existsSync(join(import.meta.dir, paths.host)))('U10 assembly renders an explicit completed-user replay', async () => {
    const f = await fixture({ tutorial_completed: true, tutorial_progress_step: 'brief:v1:talk' });
    let s = (await f.journey.read()).snapshot;
    await f.journey.transition({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: 'replay', command: { type: 'replay_tutorial' } });
    const { fixture: hostFixture } = await import(paths.hostFixture), { createSession } = await import(paths.host);
    const h = hostFixture(); h.config.transport.call = async (op: string, input: any) => op === 'journey.read' ? f.journey.read() : f.journey.transition(input);
    h.config.adapters.tour = h.config.adapters['pebble-tour'] = { available: () => true, create: () => f.adapter };
    const session = createSession(h.config); await session.start(); expect(session.state().mode).toBe('journey'); expect(session.state().view).toBe('tour'); session.dispose();
  });
  test.skipIf(!existsSync(join(import.meta.dir, paths.host)))('U10 does not replay a completed tour after the remaining legacy interview finishes', async () => {
    const f = await fixture({ tutorial_completed: true, setup_skipped_profile: false });
    let s = (await f.journey.read()).snapshot;
    await f.journey.acknowledge({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: 'interview', command: { type: 'interview_finished', state: 'done' } });
    s = (await f.journey.read()).snapshot;
    await f.journey.transition({ journeyId: s.journeyId, expectedRevision: s.revision, requestId: 'tour', command: { type: 'navigate', stepId: 'tour' } });
    const { fixture: hostFixture } = await import(paths.hostFixture), { createSession } = await import(paths.host);
    const h = hostFixture(); h.config.transport.call = async (op: string, input: any) => op === 'journey.read' ? f.journey.read() : f.journey.transition(input);
    h.config.adapters.tour = h.config.adapters['pebble-tour'] = { available: () => true, create: () => f.adapter };
    const session = createSession(h.config); await session.start(); expect(session.state().view).toBe('activation'); expect(session.state().journey.completion).toBe('active'); session.dispose();
  });

});
