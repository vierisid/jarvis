import { expect, test } from 'bun:test';
import { createTourProvider, legacyTourStep, TOUR_STEPS } from './index.ts';
import { owner, portFixture } from './test-fixture.ts';
const command = { type: 'navigate', sessionId: 'journey', revision: 0, requestId: 'next-1', from: 'today', action: 'next' };
function setup(options: Record<string, unknown> = {}) {
  const f = portFixture();
  const p = createTourProvider({ enabled: true, authorize: () => owner, journeyFor: () => f.port, roomStatus: () => 'ready', ...options });
  return { f, p };
}
test('default-off factory has no startup effects; disabled requests touch no ports', async () => {
  let calls = 0;
  const p = createTourProvider({ authorize: () => { calls++; return owner; }, journeyFor: () => { throw Error('unexpected'); } });
  expect(calls).toBe(0); expect(await p.request(null, { type: 'read' })).toEqual({ availability: 'unsupported', reason: 'disabled' }); expect(calls).toBe(0);
});
test('v1 order, legacy aliases and unknown hints are explicit', () => {
  expect(TOUR_STEPS).toHaveLength(12);
  for (const step of TOUR_STEPS) { expect(legacyTourStep(step)).toBe(step); expect(legacyTourStep(`brief:v1:${step}`)).toBe(step); }
  expect(legacyTourStep('brief:v1:context')).toBe('memory'); expect(legacyTourStep('brief:v1:apps')).toBe('connected-workspace');
  expect(legacyTourStep('brief:v1:talk')).toBe('pebble'); expect(legacyTourStep('toString')).toBe('today'); expect(legacyTourStep('future:v2:memory')).toBe('today');
});
test('known legacy hint projects without read writes; the next deliberate action persists a canonical step', async () => {
  const { f, p } = setup(); f.state.legacyTourStepId = 'brief:v1:context';
  expect(await p.request(null, { type: 'read' })).toMatchObject({ availability: 'ready', snapshot: { stepId: 'memory' } }); expect(f.writes).toBe(0);
  expect(await p.request(null, { ...command, from: 'memory' })).toMatchObject({ availability: 'ready', snapshot: { stepId: 'connected-workspace' } }); expect(f.writes).toBe(1);
});
test.each([null, {}, { type: 'read', scope: owner }, { ...command, action: 'approve' }, { ...command, from: 'talk' },
  { ...command, revision: NaN }, { ...command, requestId: '' }, { ...command, to: 'billing' }, { ...command, action: 'finish' }, { ...command, action: 'back' }])('rejects malformed or nonadjacent requests: %j', async input => {
  const { f, p } = setup(); expect((await p.request(null, input)).availability).not.toBe('ready'); expect(f.writes).toBe(0);
});
test('missing capability blocks forward actions but retains Back/Skip', async () => {
  const { f, p } = setup({ roomStatus: undefined }); f.state.tourStepId = 'memory';
  expect(await p.request(null, { type: 'read' })).toMatchObject({ snapshot: { stepId: 'memory', roomStatus: 'unsupported' } });
  expect(await p.request(null, { ...command, from: 'memory' })).toEqual({ availability: 'unavailable', reason: 'room_unavailable' });
  expect(await p.request(null, { ...command, from: 'memory', action: 'back' })).toMatchObject({ snapshot: { stepId: 'goals' } });
  expect(await p.request(null, { ...command, revision: 1, from: 'goals', action: 'skip' })).toMatchObject({ snapshot: { active: false, journey: { stepId: 'activation' } } });
});
test('unknown persisted v2 step is not reset or silently completed', async () => {
  const { f, p } = setup(); f.state.tourStepId = 'future';
  expect(await p.request(null, { type: 'read' })).toEqual({ availability: 'unsupported', reason: 'unsupported_progress' }); expect(f.writes).toBe(0);
});
test('server scope is checked against the journey and revocation fences a capability probe before writes', async () => {
  const { f, p } = setup({ authorize: () => ({ ...owner, actorId: 'other' }) });
  expect((await p.request(null, { type: 'read' })).availability).toBe('unavailable'); expect(f.writes).toBe(0);
  let authorized = true;
  const g = setup({ authorize: () => authorized ? owner : null, roomStatus: () => { authorized = false; return 'ready'; } });
  expect(await g.p.request(null, command)).toEqual({ availability: 'unavailable', reason: 'unauthorized' }); expect(g.f.writes).toBe(0);
});
test('cancellation and service failures are safe; no raw error or scope leaks', async () => {
  const { f, p } = setup(); const signal = AbortSignal.abort();
  expect(await p.request(null, command, signal)).toEqual({ availability: 'unavailable', reason: 'unauthorized' }); expect(f.writes).toBe(0);
  f.port.read = async () => { throw Error('private SQL and credential'); };
  expect(await p.request(null, { type: 'read' })).toEqual({ availability: 'unavailable', reason: 'storage_unavailable' });
});
