import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { BriefReconciliationClient } from '../reconciliation/client';
import { createHostTransport } from './http';
import { CompanionContext } from '../shell/pebble-layout/PebbleCompanion';

let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot, Rooms: typeof import('./data-rooms');
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost:3199/' });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client')); Rooms = await import('./data-rooms');
});
afterAll(() => GlobalRegistrator.unregister());

test('Today shows the unplanned interview goal notice, and drops it once the server says none', async () => {
  const provider = { readiness: () => 'ready' as const };
  const caps = new BriefCapabilities([{ id: 'reconciliation', provider }, { id: 'goalMeasurements', provider }], ['reconciliation', 'goalMeasurements']).snapshot();
  let initial: 'unplanned' | 'none' = 'unplanned';
  const transport = createHostTransport((async (path: string) => {
    if (path === '/api/brief/goals') return Response.json({ state: 'empty', data: [], asOf: 1 });
    if (path === '/api/brief/initial-goal') return Response.json({ state: initial });
    return Response.json({ state: 'unavailable' }, { status: 503 });
  }) as unknown as typeof fetch);
  const reconciliation = new BriefReconciliationClient({ capabilities: async () => caps, pollMs: 3_600_000 });
  const rooms = Rooms.createDataRooms({ scopeId: 'scope', transport, capabilities: () => caps, storage: window.localStorage, reconciliation, createGoal() {} });
  const navigated: unknown[] = [];
  const host = document.createElement('div'), companion = document.createElement('aside'); document.body.append(host, companion); const root = createRoot(host);
  const Today = rooms.rooms.today!.Body!;
  // Poll for an observable state, never a fixed number of ticks.
  const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); }); return done(); };
  const notice = () => companion.querySelector('.brief-goal-plan');
  reconciliation.start();
  try {
    await React.act(async () => root.render(<CompanionContext.Provider value={{ target: companion, setPresent: () => {} }}><div className="brief-root"><Today shell={{ navigate: (to: unknown) => navigated.push(to), route: { room: 'today', selection: {} } } as never} /></div></CompanionContext.Provider>));
    expect(await until(() => !!notice())).toBe(true);
    const card = companion.querySelector('.brief-goal-card')!;
    expect(card.getAttribute('data-state')).toBe('empty');
    expect(card.textContent).toContain('No active goal');
    expect(card.textContent).toContain('could not be planned');
    await React.act(async () => (notice() as HTMLButtonElement).click());
    expect(navigated).toEqual([{ room: 'goals', selection: {} }]);
    // The notice was rendered from a settled read, so its disappearance proves the 'none' answer was read.
    initial = 'none'; rooms.refresh();
    expect(await until(() => !notice())).toBe(true);
    expect(companion.querySelector('.brief-goal-card')!.textContent).toContain('Choose a goal');
  } finally {
    await React.act(async () => root.unmount()); host.remove(); companion.remove(); reconciliation.stop(); rooms.retire(); transport.stop();
  }
});

test('Needs you never shows an all-clear while the independent permission list has cards or an unknown status', () => {
  const snap = (state: string, data: unknown, extra: object = {}) => ({ state, data, refreshing: false, reason: null, ...extra }) as any;
  expect(Rooms.onlyOtherDecisions(snap('empty', null), 2)).toBe(true);
  expect(Rooms.onlyOtherDecisions(snap('stale', null, { refreshing: true }), 2)).toBe(true);
  expect(Rooms.onlyOtherDecisions(snap('ready', [{ actions: [] }]), 0)).toBe(true);
  expect(Rooms.onlyOtherDecisions(snap('ready', [{ actions: ['approve'] }]), 2)).toBe(false);
  expect(Rooms.onlyOtherDecisions(snap('empty', null), 0)).toBe(false);
  // An unknown (loading or failed) permission list is not an all-clear.
  expect(Rooms.onlyOtherDecisions(snap('empty', null), null)).toBe(true);
  // A document read that is loading or failed keeps its own room and status.
  expect(Rooms.onlyOtherDecisions(snap('loading', null), 2)).toBe(false);
  expect(Rooms.onlyOtherDecisions(snap('unavailable', null, { reason: 'down' }), 2)).toBe(false);
  expect(Rooms.onlyOtherDecisions(snap('stale', [{ actions: [] }], { reason: 'down' }), 2)).toBe(false);
});

test('day bars are labelled with the short weekday and carry the full date', () => {
  expect(Rooms.dayLabels('2026-11-09').label).toBe('Mon'); expect(Rooms.dayLabels('2026-11-09').title).toContain('2026');
  expect(Rooms.dayLabels('2026-11-15').label).toBe('Sun'); expect(Rooms.dayLabels('nope')).toEqual({ label: 'nope', title: 'nope' });
});

test('Today recent activity lists real workflow runs with plain statuses and opens the run', async () => {
  const provider = { readiness: () => 'ready' as const };
  const caps = new BriefCapabilities([{ id: 'reconciliation', provider }, { id: 'goalMeasurements', provider }], ['reconciliation', 'goalMeasurements']).snapshot();
  const runFor = (flowId: string, status: string, startTime: number) => ({ runId: `run-${flowId}`, flowId, flowVersionId: `v-${flowId}`, name: `Flow ${flowId}`, status, startTime, created: startTime, steps: { private: 'CANARY' } });
  let extra: unknown[] = [];
  const requested: string[] = [];
  const transport = createHostTransport((async (path: string) => {
    requested.push(path);
    if (path === '/api/brief/goals') return Response.json({ state: 'empty', data: [], asOf: 1 });
    if (path === '/api/brief/initial-goal') return Response.json({ state: 'none' });
    if (path === '/api/workflow-runs/recent?limit=5') return Response.json({ items: [...extra, runFor('ok', 'SUCCEEDED', 3000), runFor('bad', 'FAILED', 2000), { ...runFor('wait', 'PAUSED', 1000), waitingOn: 'person' }] });
    return Response.json({ state: 'unavailable' }, { status: 503 });
  }) as unknown as typeof fetch);
  const reconciliation = new BriefReconciliationClient({ capabilities: async () => caps, pollMs: 3_600_000 });
  const rooms = Rooms.createDataRooms({ scopeId: 'scope', transport, capabilities: () => caps, storage: window.localStorage, reconciliation, createGoal() {} });
  const navigated: unknown[] = [];
  const host = document.createElement('div'), companion = document.createElement('aside'); document.body.append(host, companion); const root = createRoot(host);
  const Today = rooms.rooms.today!.Body!;
  const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); }); return done(); };
  const rows = () => [...host.querySelectorAll('.brief-recent-activity li')];
  reconciliation.start();
  try {
    await React.act(async () => root.render(<CompanionContext.Provider value={{ target: companion, setPresent: () => {} }}><div className="brief-root"><Today shell={{ navigate: (to: unknown) => navigated.push(to), route: { room: 'today', selection: {} } } as never} /></div></CompanionContext.Provider>));
    expect(await until(() => rows().length === 3)).toBe(true);
    expect(rows().map(row => row.querySelector('strong')!.textContent)).toEqual(['Flow ok', 'Flow bad', 'Flow wait']);
    expect(rows().map(row => row.textContent)).toEqual([expect.stringContaining('Done'), expect.stringContaining('Failed'), expect.stringContaining('Waiting for you')]);
    expect(host.textContent).not.toContain('No workflow has run yet');
    expect(host.textContent).not.toContain('CANARY');
    // One bounded read, never a per-workflow fan-out.
    expect(requested.filter(path => path.startsWith('/api/workflow')) ).toEqual(['/api/workflow-runs/recent?limit=5']);
    await React.act(async () => rows()[0]!.querySelector('button')!.click());
    expect(navigated).toEqual([{ room: 'workflow', selection: { flowId: 'ok', versionId: 'v-ok', runId: 'run-ok' } }]);
    // A run that finishes while Today is open appears without a reload.
    extra = [runFor('new', 'SUCCEEDED', 4000)]; rooms.refresh();
    expect(await until(() => rows().length === 4)).toBe(true);
    expect(rows()[0]!.querySelector('strong')!.textContent).toBe('Flow new');
  } finally {
    await React.act(async () => root.unmount()); host.remove(); companion.remove(); reconciliation.stop(); rooms.retire(); transport.stop();
  }
});
