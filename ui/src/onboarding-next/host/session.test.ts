import { expect, test } from 'bun:test';
import { createSession } from './session.ts';
import { PROVIDERS, VIEWS } from './contract.ts';
import { fixture } from './test-fixture.ts';
import { parseJourney } from './policy.ts';
import { createDraftStore } from './drafts.ts';

test('default off and absent release decision do no reads, loads or writes', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(); f.config.enabled = enabled; f.config.authorizeRelease = undefined;
    const s = createSession(f.config); await s.start();
    expect(s.state().mode).toBe('legacy'); expect(f.calls).toEqual([]); s.dispose();
  }
});
for (const count of [0, 1, 4]) test(`${count} views retains complete legacy without initializing a journey`, async () => {
  const f = fixture(); f.config.modules = f.config.modules.slice(0, count);
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('legacy'); expect(f.calls).toEqual(['status']); s.dispose();
});
for (const spec of VIEWS) test(`removing ${spec.id} refuses the whole switch`, async () => {
  const f = fixture(); f.config.modules = f.config.modules.filter(m => m.manifest.id !== spec.id);
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('legacy'); expect(f.calls).toEqual(['status']); s.dispose();
});
for (const capability of PROVIDERS) test(`unready ${capability} cannot mount a partial journey`, async () => {
  const f = fixture(); f.status.capabilities[capability]!.ready = false;
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('legacy'); expect(f.calls).toEqual(['status']); s.dispose();
});
test('unknown install mode and missing local adapter fall back', async () => {
  for (const missing of ['mode', 'adapter', 'self-setup']) {
    const f = fixture();
    if (missing === 'mode') f.status.installMode = 'unknown';
    if (missing === 'adapter') delete f.config.adapters.interview;
    if (missing === 'self-setup') { f.status.installMode = 'self'; delete f.config.adapters['legacy-provider-setup']; }
    const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('legacy'); s.dispose();
  }
});
test('hosted setup commits through B02 before navigating; self setup keeps the existing provider port', async () => {
  for (const mode of ['hosted', 'self'] as const) {
    const f = fixture(); f.status.installMode = mode;
    const s = createSession(f.config); await s.start();
    await s.act(s.key(), 'continue'); expect(s.state().view).toBe('explainer');
    await s.act(s.key(), 'continue'); expect(s.state().view).toBe(mode === 'hosted' ? 'google' : 'legacy-provider-setup');
    expect(f.calls.includes('setup.complete')).toBe(mode === 'hosted'); s.dispose();
  }
});
test('Welcome exit leaves the UI without manufacturing completed progress', async () => {
  const f = fixture(), s = createSession(f.config); await s.start(); const before = f.journey();
  await s.act(s.key(), 'explore'); expect(s.state().mode).toBe('complete'); expect(f.journey()).toEqual(before);
  expect(f.calls).not.toContain('journey.transition'); s.dispose();
});
test('leaving Google cancels through its owner before navigation; failed cancellation retains the journey', async () => {
  for (const failed of [false, true]) {
    const f = fixture(); f.setJourney({ stepId: 'google', setupState: 'completed' });
    const create = f.config.adapters.google!.create;
    f.config.adapters.google!.create = () => ({ ...create(), command: async (_context, action) => {
      f.calls.push(`google:${action}`);
      if (failed) throw new Error('Uncertain cancellation');
    } });
    const s = createSession(f.config); await s.start(); await s.act(s.key(), 'back');
    expect(f.calls).toContain('google:skip');
    if (failed) {
      expect(f.calls).not.toContain('journey.transition'); expect(s.state().blocked).toBe(true);
      expect(s.state().view).toBe('google');
    } else {
      expect(f.calls.indexOf('google:skip')).toBeLessThan(f.calls.indexOf('journey.transition'));
      expect(s.state().view).toBe('explainer');
    }
    s.dispose();
  }
});
test('tutorial completion retains activation until explicit Explore first', async () => {
  const f = fixture(); f.setJourney({ stepId: 'tour', setupState: 'completed', interviewState: 'done' });
  const s = createSession(f.config); await s.start();
  f.setJourney({ tourState: 'done', stepId: 'activation', revision: 1 }); await s.refresh();
  expect(s.state().mode).toBe('journey'); expect(s.state().view).toBe('activation');
  await s.act(s.key(), 'explore', { draft: { prompt: 'Keep this request' } });
  expect(s.state().mode).toBe('complete'); expect(f.models.activation!.draft).toEqual({ prompt: 'Keep this request' }); s.dispose();
});
test('completed legacy users enter the shell without replaying setup', async () => {
  const f = fixture(); f.setJourney({ stepId: 'exited', completion: 'legacy_completed', activationState: 'legacy_completed' });
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('complete');
  expect(f.calls.filter(c => c.includes('complete') || c.includes('transition'))).toEqual([]); s.dispose();
});
test('failure after entry stays in bounded recovery and preserves the draft', async () => {
  const f = fixture(); f.setJourney({ stepId: 'activation' });
  const s = createSession(f.config); await s.start(); s.draft(s.key(), { prompt: 'Do not lose me' });
  f.status.ready = false; await s.act(s.key(), 'create', {});
  expect(s.state().blocked).toBe(true); expect(s.state().mode).toBe('journey'); expect(f.calls).not.toContain('activation:create');
  f.status.ready = true; await s.refresh(); expect(s.state().blocked).toBe(false);
  expect(s.state().presentation!.model.draft).toEqual({ prompt: 'Do not lose me' }); s.dispose();
});
test('stale revision, changed journey or changed scope cannot replace an active session', async () => {
  for (const patch of [{ revision: 0 }, { journeyId: 'other' }, { scopeId: 'other-owner' }]) {
    const f = fixture(); f.setJourney({ revision: 4 }); const s = createSession(f.config); await s.start();
    f.setJourney(patch); await s.refresh(); expect(s.state().blocked).toBe(true);
    expect(s.state().journey!.scopeId).toBe('fixture-owner-project'); expect(s.state().journey!.revision).toBe(4); s.dispose();
  }
});
test('old callbacks and overlapping clicks cannot repeat a transition', async () => {
  const f = fixture(), s = createSession(f.config); await s.start(); const key = s.key();
  await Promise.all([s.act(key, 'continue'), s.act(key, 'continue')]);
  await s.act(key, 'continue'); expect(f.calls.filter(c => c === 'journey.transition')).toHaveLength(1); s.dispose();
});
test('view import failure falls back without creating a journey', async () => {
  const f = fixture(); f.config.modules[0]!.load = async () => { throw new Error('missing chunk'); };
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('legacy'); expect(f.calls).not.toContain('journey.read'); s.dispose();
});
test('unknown journey values do not manufacture a welcome screen', () => {
  const f = fixture();
  for (const patch of [{ stepId: 'future' }, { revision: -1 }, { scopeId: null }, { buildRequestId: {} }, { stepId: 'result', draft: null }]) {
    expect(() => parseJourney({ availability: 'ready', snapshot: { ...f.journey(), ...patch } })).toThrow();
  }
});
test('draft records survive recreation and are isolated by server scope/journey', () => {
  const values = new Map<string, string>(), storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  createDraftStore(storage, 'owner', 'journey').save('activation', { prompt: 'Keep', requestId: 'stable' });
  expect(createDraftStore(storage, 'owner', 'journey').read('activation')).toEqual({ prompt: 'Keep', requestId: 'stable' });
  expect(createDraftStore(storage, 'other', 'journey').read('activation')).toBeNull();
  expect(createDraftStore(storage, 'owner', 'different').read('activation')).toBeNull();
  for (const key of values.keys()) values.set(key, '{bad');
  expect(() => createDraftStore(storage, 'owner', 'journey').save('activation', { prompt: '' })).toThrow();
  expect([...values.values()]).toEqual(['{bad']);
});
