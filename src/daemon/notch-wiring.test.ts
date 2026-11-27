/**
 * The notch's part of the brain's start (./notch-wiring.ts), held by what it does: with the switch off nothing
 * of it is made and Pause keeps its meaning; a part that cannot be made leaves the brain up, puts back what
 * was set for it and tells the dashboard; a notch that is made is held for the way down; and on the way down
 * the notch is stopped first, with the commitment executor beside it.
 *
 * It replaces the test that read the source of index.ts (fix 02, step 7). Where the way down stops the notch,
 * before anything is awaited, is held by the narrow check of handleShutdown at the end, and by the SIGTERM test
 * in ./notch-start.test.ts, which runs the real handler.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmergencyController, pauseIsHolding, setActiveEmergencyController, setPauseHoldsLoops } from '../authority/emergency.ts';
import { ownerWordProbes, setOwnerWordProbe } from '../authority/owner-word.ts';
import { captureMayBeKept, setCaptureGuard } from '../awareness/capture-guard.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { listUnreadDashboardNotifications } from '../vault/dashboard-notifications.ts';
import { notchFrontNow, setNotchFrontSource } from './notch-asks.ts';
import { NOTCH_FAILED_NOTICE, holdNotch, stopNotch } from './notch-start.ts';

// The real things on the notch, made by a stand-in when a test says so: the wiring around them is what is held here.
const made = { fake: null as unknown };
const real = await import('../notch/real.ts');
mock.module('../notch/real.ts', () => ({
  ...real,
  attachNotchReal: (...args: Parameters<typeof real.attachNotchReal>) => (made.fake ? made.fake as ReturnType<typeof real.attachNotchReal> : real.attachNotchReal(...args)),
}));
const wiring = await import('./notch-wiring.ts');
const { createNotch, notchIsUp, notchRefreshWhere, notchShowing, notchSuggestionsNow, notchTurnsReady, resetNotchWiring, startNotch, stopNotchFirst } = wiring;

const realSwitch = process.env.JARVIS_NOTCH;
const realError = console.error;
const printed: string[] = [];
const told: string[] = [];
const paused = new EmergencyController();
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  resetNotchWiring();
  made.fake = null;
  told.length = 0;
  printed.length = 0;
  // What a part that cannot be made prints, with its stack, is kept here and not on the test's output.
  console.error = (...line: unknown[]) => { printed.push(line.map(String).join(' ')); };
  setPauseHoldsLoops(false);
  setOwnerWordProbe(null);
  setNotchFrontSource(null);
  setCaptureGuard(null);
});
afterEach(() => {
  stopNotch();
  holdNotch(null);
  resetNotchWiring();
  console.error = realError;
  setActiveEmergencyController(null);
  setPauseHoldsLoops(false);
  setOwnerWordProbe(null);
  setNotchFrontSource(null);
  setCaptureGuard(null);
  if (realSwitch === undefined) delete process.env.JARVIS_NOTCH; else process.env.JARVIS_NOTCH = realSwitch;
  closeDb();
});

/** A sidecar manager that has nothing connected, and says which of its listeners were asked for. */
function sidecars(more: { onEvent?: () => void } = {}) {
  const asked: string[] = [];
  return {
    asked,
    manager: {
      dispatchRPC: async () => ({}),
      onEvent: () => { asked.push('onEvent'); more.onEvent?.(); },
      onSidecarConnected: () => { asked.push('onSidecarConnected'); },
      onSidecarDisconnected: () => { asked.push('onSidecarDisconnected'); },
      getConnectedSidecars: () => [],
      listConnected: () => [],
    } as never,
  };
}

const ws = { broadcastNotificationToDashboard: (text: string) => { told.push(text); } } as never;
const early = (manager: never) => ({ sidecarManager: manager, wsService: ws, pebblePanelOrigin: 'http://localhost:1', notchDemoState: 'off' as const });

/** Everything the rest of the notch is made from, on stand-ins. */
const late = (over: Record<string, unknown> = {}) => ({
  sidecarManager: sidecars().manager, agentService: { getConfig: () => ({}), getLLMManager: () => ({}) }, wsService: ws, dataDir: '/nowhere',
  pebblePanelOrigin: 'http://localhost:1', notchDemoState: 'off', jarvisConfig: {},
  emergencyController: { getState: () => 'normal', subscribe: () => () => {}, pause() {} }, approvalManager: {},
  approvalDelivery: {}, deferredExecutor: {}, auditTrail: {}, executor: {},
  getDb: () => getDb(), googleAuthNow: () => null, bgAgentNow: () => null, workflowDepsNow: () => null, setPeerSetup: () => {},
  ...over,
}) as never;

/** Whether Pause holds the model loops: asked of a pause that is on. */
const holdsLoops = (): boolean => { setActiveEmergencyController(paused); paused.pause(); const holds = pauseIsHolding(); paused.resume(); return holds; };

describe('the surface, made where a desktop app may connect', () => {
  test('with the switch off nothing of the notch is made, and no listener is asked for', () => {
    delete process.env.JARVIS_NOTCH;
    const { manager, asked } = sidecars();
    createNotch(early(manager));
    expect(wiring.notchSurface).toBeNull();
    expect(asked).toEqual([]);
  });

  test('one that cannot be made leaves the brain up: no surface, and the dashboard is told once', () => {
    process.env.JARVIS_NOTCH = '1';
    const { manager } = sidecars({ onEvent: () => { throw new Error('no port'); } });
    expect(() => createNotch(early(manager))).not.toThrow();
    expect(wiring.notchSurface).toBeNull();
    expect(listUnreadDashboardNotifications().map((row) => row.message)).toEqual([NOTCH_FAILED_NOTICE]);
    expect(told).toEqual([NOTCH_FAILED_NOTICE]);
    expect(printed.join('\n')).toContain('no port');
  });
});

describe('the real things on the notch', () => {
  test('with no surface nothing is made, and Pause keeps its meaning of the switch being off', () => {
    delete process.env.JARVIS_NOTCH;
    createNotch(early(sidecars().manager));
    const { manager, asked } = sidecars();
    // Left on by something before: the start of the notch puts it back to off.
    setPauseHoldsLoops(true);
    startNotch(late({ sidecarManager: manager, getDb: () => { throw new Error('asked for the database'); } }));
    expect(wiring.notchReal).toBeNull();
    expect(asked).toEqual([]);
    expect(holdsLoops()).toBe(false);
    expect(stopNotch()).toBe(false);
  });

  test('a making that throws leaves the brain up: no notch, what was set for it put back, and the dashboard told', () => {
    process.env.JARVIS_NOTCH = '1';
    createNotch(early(sidecars().manager));
    expect(wiring.notchSurface).not.toBeNull();
    let asked = 0;
    // The database is asked for as the notch is made: here it cannot be had.
    expect(() => startNotch(late({ getDb: () => { asked++; throw new Error('no such table: notch_actions'); } }))).not.toThrow();
    expect(asked).toBeGreaterThan(0);
    expect(wiring.notchReal).toBeNull();
    expect(stopNotch()).toBe(false);
    expect(listUnreadDashboardNotifications().map((row) => row.message)).toEqual([NOTCH_FAILED_NOTICE]);
    expect(told).toEqual([NOTCH_FAILED_NOTICE]);
    expect(printed.join('\n')).toContain('no such table: notch_actions');
    // What was set for it is put back: Pause, the owner-word probes, the front source and the capture guard.
    expect(holdsLoops()).toBe(false);
    expect(ownerWordProbes()).toEqual({ press: false, front: false });
    // Asked again with a notch there: what was put back asks none of it.
    resetNotchWiring({ real: { where: { front: () => ({ name: 'Excel', site: '' }), mayKeep: () => false } } as never });
    expect(notchFrontNow()).toBeNull();
    expect(captureMayBeKept('pc', { event_type: 'screen_capture', payload: { app_name: 'Excel' } })).toBe(true);
  });

  test('a notch that is made is held for the way down, and Pause holds the loops', () => {
    process.env.JARVIS_NOTCH = '1';
    createNotch(early(sidecars().manager));
    const stops: string[] = [];
    made.fake = { stop() { stops.push('stopped'); }, where: { front: () => null, mayKeep: () => true } };
    startNotch(late());
    expect(wiring.notchReal).toBe(made.fake as never);
    expect(notchIsUp()).toBe(true);
    expect(holdsLoops()).toBe(true);
    expect(stopNotch()).toBe(true);
    expect(stops).toEqual(['stopped']);
  });
});

describe('what the rest of the brain asks of the notch', () => {
  test('with no notch each answers as if there were none, and the turn store is still kept for when there is one', () => {
    expect(wiring.notchReal).toBeNull();
    expect([notchIsUp(), notchShowing(), notchSuggestionsNow()]).toEqual([false, false, null]);
    expect(() => notchRefreshWhere()).not.toThrow();
    const store = { name: 'the turn store' } as never;
    notchTurnsReady(store);
    expect(wiring.notchTurnStore).toBe(store);
  });
});

describe('the way down', () => {
  test('the notch is stopped first, and the commitment executor with it; without a notch the executor is left where it is', () => {
    const order: string[] = [];
    holdNotch({ stop() { order.push('notch'); } });
    stopNotchFirst(() => order.push('executor'));
    expect(order).toEqual(['notch', 'executor']);
    order.length = 0;
    stopNotchFirst(() => order.push('executor'));
    expect(order).toEqual([]);
  });

  test('the brain stops the notch before it waits for anything on its way down', () => {
    // Narrow on purpose: only the handler of the way down is read, and only the place of this one call in it.
    const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');
    const start = source.indexOf('async function handleShutdown(');
    const down = source.slice(start, source.indexOf('\n}\n', start));
    const stops = 'stopNotchFirst(() => commitmentExecutor?.stop());';
    expect(down.indexOf(stops)).toBeGreaterThan(0);
    expect(down.split(stops).length - 1).toBe(1);
    expect(down.indexOf(stops)).toBeLessThan(down.indexOf('await '));
  });
});
