/**
 * The notch's part of the brain's start (./notch-wiring.ts), held by what it does: with the switch off nothing
 * of it is made; a part that cannot be made leaves the brain up, puts back what was set for it and tells the
 * dashboard; and on the way down the notch is stopped first, with the commitment executor beside it.
 *
 * It replaces the test that read the source of index.ts (fix 02, step 7). The order of the way down against
 * the turns being waited for is held by the SIGTERM test in ./notch-start.test.ts, which runs the real handler.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { listUnreadDashboardNotifications } from '../vault/dashboard-notifications.ts';
import { NOTCH_FAILED_NOTICE, holdNotch, stopNotch } from './notch-start.ts';
import { createNotch, notchReal, notchSurface, startNotch, stopNotchFirst } from './notch-wiring.ts';

const realSwitch = process.env.JARVIS_NOTCH;
beforeEach(() => { initDatabase(':memory:', { quiet: true }); });
afterEach(() => {
  stopNotch();
  holdNotch(null);
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

const told: string[] = [];
const ws = { broadcastNotificationToDashboard: (text: string) => { told.push(text); } } as never;

describe('the surface, made where a desktop app may connect', () => {
  test('with the switch off nothing of the notch is made, and no listener is asked for', () => {
    delete process.env.JARVIS_NOTCH;
    const { manager, asked } = sidecars();
    createNotch({ sidecarManager: manager, wsService: ws, pebblePanelOrigin: 'http://localhost:1', notchDemoState: 'off' });
    expect(notchSurface).toBeNull();
    expect(asked).toEqual([]);
  });

  test('one that cannot be made leaves the brain up: no surface, and the dashboard is told once', () => {
    process.env.JARVIS_NOTCH = '1';
    told.length = 0;
    const { manager } = sidecars({ onEvent: () => { throw new Error('no port'); } });
    expect(() => createNotch({ sidecarManager: manager, wsService: ws, pebblePanelOrigin: 'http://localhost:1', notchDemoState: 'off' })).not.toThrow();
    expect(notchSurface).toBeNull();
    expect(listUnreadDashboardNotifications().map((row) => row.message)).toEqual([NOTCH_FAILED_NOTICE]);
    expect(told).toEqual([NOTCH_FAILED_NOTICE]);
  });
});

describe('the real things on the notch', () => {
  test('with no surface nothing is made, and Pause keeps its meaning of the switch being off', () => {
    delete process.env.JARVIS_NOTCH;
    createNotch({ sidecarManager: sidecars().manager, wsService: ws, pebblePanelOrigin: 'http://localhost:1', notchDemoState: 'off' });
    const { manager, asked } = sidecars();
    startNotch({ sidecarManager: manager, getDb: () => { throw new Error('asked for the database'); } } as never);
    expect(notchReal).toBeNull();
    expect(asked).toEqual([]);
  });

  test('a making that throws leaves the brain up: no notch, and the dashboard told', () => {
    process.env.JARVIS_NOTCH = '1';
    told.length = 0;
    createNotch({ sidecarManager: sidecars().manager, wsService: ws, pebblePanelOrigin: 'http://localhost:1', notchDemoState: 'off' });
    expect(notchSurface).not.toBeNull();
    let asked = 0;
    // The database is asked for as the notch is made: here it cannot be had.
    const late = {
      sidecarManager: sidecars().manager, agentService: {}, wsService: ws, dataDir: '/nowhere', pebblePanelOrigin: 'http://localhost:1',
      notchDemoState: 'off', jarvisConfig: {}, emergencyController: { getState: () => 'normal', subscribe: () => () => {} }, approvalManager: {},
      approvalDelivery: {}, deferredExecutor: {}, auditTrail: {}, executor: {},
      getDb: () => { asked++; throw new Error('no such table: notch_actions'); },
      googleAuthNow: () => null, bgAgentNow: () => null, workflowDepsNow: () => null, setPeerSetup: () => {},
    };
    expect(() => startNotch(late as never)).not.toThrow();
    expect(asked).toBeGreaterThan(0);
    expect(notchReal).toBeNull();
    expect(listUnreadDashboardNotifications().map((row) => row.message)).toEqual([NOTCH_FAILED_NOTICE]);
    expect(told).toEqual([NOTCH_FAILED_NOTICE]);
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
});
