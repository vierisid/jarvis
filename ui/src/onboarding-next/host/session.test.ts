import { expect, test } from 'bun:test';
import { createSession } from './session.ts';
import { PROVIDERS, VIEWS } from './contract.ts';
import { fixture } from './test-fixture.ts';
import { parseJourney } from './policy.ts';
import { createDraftStore } from './drafts.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(done: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('Session did not settle');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('coalesces provider events received during a read and observes the terminal update', async () => {
  const f = fixture(), captured = deferred(), release = deferred();
  f.setJourney({ stepId: 'build' });
  let notify = () => {}, reads = 0, version = 0;
  f.config.adapters.build!.create = () => ({
    available: () => true, command: async () => {},
    read: async () => {
      const model = { version, outcome: version ? 'succeeded' : 'working' };
      if (++reads === 2) { captured.resolve(); await release.promise; }
      return { model };
    },
    subscribe: changed => { notify = changed; return () => {}; },
  });
  const s = createSession(f.config);
  try {
    await s.start();
    const refresh = s.refresh(); await captured.promise;
    version = 1; notify(); notify(); notify(); release.resolve();
    await refresh; await until(() => !s.state().busy);
    expect(s.state().presentation!.model).toEqual({ version: 1, outcome: 'succeeded' });
    expect(reads).toBe(3);
  } finally { release.resolve(); s.dispose(); }
});

test('drains an invalidation after a command without replaying the command', async () => {
  const f = fixture(), captured = deferred(), release = deferred();
  f.setJourney({ stepId: 'build' });
  let notify = () => {}, reads = 0, commands = 0, version = 0;
  f.config.adapters.build!.create = () => ({
    available: () => true, command: async () => { commands++; },
    read: async () => {
      const model = { version };
      if (++reads === 2) { captured.resolve(); await release.promise; }
      return { model };
    },
    subscribe: changed => { notify = changed; return () => {}; },
  });
  const s = createSession(f.config);
  try {
    await s.start(); const action = s.act(s.key(), 'resume'); await captured.promise;
    version = 1; notify(); release.resolve(); await action; await until(() => !s.state().busy);
    expect(s.state().presentation!.model.version).toBe(1); expect(commands).toBe(1);
  } finally { release.resolve(); s.dispose(); }
});

for (const dispose of [false, true]) test(`invalidation during the first read is drained unless disposed (${dispose})`, async () => {
  const f = fixture(), captured = deferred(), release = deferred();
  f.setJourney({ stepId: 'build' });
  let notify = () => {}, reads = 0, version = 0;
  f.config.adapters.build!.create = () => ({
    available: () => true, command: async () => {},
    read: async () => {
      const model = { version };
      if (++reads === 1) { captured.resolve(); await release.promise; }
      return { model };
    },
    subscribe: changed => { notify = changed; return () => {}; },
  });
  const s = createSession(f.config);
  const start = s.start(); await captured.promise;
  version = 1; notify();
  if (dispose) s.dispose();
  release.resolve(); await start;
  try {
    if (dispose) { expect(reads).toBe(1); expect(s.state().journey).toBeNull(); }
    else {
      await until(() => !s.state().busy);
      expect(s.state().presentation!.model.version).toBe(1); expect(reads).toBe(2);
    }
  } finally { if (!dispose) s.dispose(); }
});

for (const failure of ['journey', 'adapter'] as const) test(`initial ${failure} read failure retains subscriptions through recovery`, async () => {
  const f = fixture(); f.setJourney({ stepId: 'build' });
  let fail = true, notify = () => {}, subscriptions = 0, unsubscribes = 0, version = 0;
  const call = f.config.transport.call;
  f.config.transport.call = async (...args) => {
    if (failure === 'journey' && fail && args[0] === 'journey.read') throw new Error('Offline');
    return call(...args);
  };
  f.config.adapters.build!.create = () => ({
    available: () => true, command: async () => {},
    read: async () => { if (failure === 'adapter' && fail) throw new Error('Offline'); return { model: { version } }; },
    subscribe: changed => { subscriptions++; notify = changed; return () => { unsubscribes++; }; },
  });
  const s = createSession(f.config);
  try {
    await s.start(); expect(s.state().blocked).toBe(true);
    fail = false; await s.refresh(); expect(s.state().blocked).toBe(false);
    expect(subscriptions).toBe(1);
    version = 1; notify(); await until(() => !s.state().busy);
    expect(s.state().presentation!.model.version).toBe(1);
    await s.refresh(); expect(subscriptions).toBe(1);
  } finally { s.dispose(); }
  expect(unsubscribes).toBe(1);
});

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


test('explicit completed-user tutorial replay stays visible, then returns to the completed workspace', async () => {
  const f = fixture(); f.setJourney({ stepId: 'tour', completion: 'legacy_completed', activationState: 'legacy_completed',
    setupState: 'completed', interviewState: 'skipped', replayReturnStepId: 'exited' });
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('journey'); expect(s.state().view).toBe('tour');
  f.setJourney({ stepId: 'exited', tourState: 'done', replayReturnStepId: null, revision: 1 }); await s.refresh();
  expect(s.state().mode).toBe('complete'); s.dispose();
});
test('a completed host can observe an explicit tutorial replay invalidation without resetting completion', async () => {
  const f = fixture(); f.setJourney({ stepId: 'exited', completion: 'completed', setupState: 'completed', interviewState: 'done' });
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('complete');
  f.setJourney({ stepId: 'tour', replayReturnStepId: 'exited', tourState: 'pending', revision: 1 }); await s.refresh();
  expect(s.state().mode).toBe('journey'); expect(s.state().journey?.completion).toBe('completed'); s.dispose();
});
test('B06 authoritative legacy projection selects the Pebble view before a canonical step is written', async () => {
  const f = fixture(); f.setJourney({ stepId: 'tour', tourStepId: null, setupState: 'completed', interviewState: 'done' });
  f.models.tour = { stepId: 'pebble' }; f.models['pebble-tour'] = { stepId: 'pebble', revision: 0 };
  const s = createSession(f.config); await s.start(); expect(s.state().view).toBe('pebble-tour');
  expect(s.state().presentation?.model).toEqual(f.models['pebble-tour']); expect(f.calls).not.toContain('journey.transition'); s.dispose();
});

test.each(['done', 'skipped'] as const)('a previously %s legacy tour advances to activation after the remaining setup/interview', async tourState => {
  const f = fixture(); f.setJourney({ stepId: 'tour', tourState, setupState: 'completed', interviewState: 'done' });
  const s = createSession(f.config); await s.start(); expect(s.state().view).toBe('activation'); expect(s.state().mode).toBe('journey');
  expect(s.state().journey?.completion).toBe('active'); expect(s.state().journey?.tourState).toBe(tourState); s.dispose();
});

test('result completion belongs to the adapter and never synthesizes a finish command', async () => {
  const f = fixture(); f.setJourney({ stepId: 'result', activationState: 'draft_saved', jobId: 'job', draft: { flowId: 'flow', versionId: 'version' } });
  const commands: unknown[] = [];
  f.config.adapters.result!.create = () => ({ available: () => true, read: async () => ({ model: {} }),
    command: async (_c, action, input) => { commands.push({ action, input }); } });
  const s = createSession(f.config), input = { action: 'finish', draft: { continuation: { input: { requestId: 'server-receipt' } } } };
  try {
    await s.start(); await s.act(s.key(), 'finish', input);
    expect(commands).toEqual([{ action: 'finish', input }]); expect(f.calls).not.toContain('journey.transition');
    expect(s.state().mode).toBe('journey'); expect(s.state().journey?.completion).toBe('active');
  } finally { s.dispose(); }
});
test('a rejected result adapter blocks completion without falling back to a synthesized finish', async () => {
  const f = fixture(); f.setJourney({ stepId: 'result', activationState: 'draft_saved', jobId: 'job', draft: { flowId: 'flow', versionId: 'version' } });
  f.config.adapters.result!.create = () => ({ available: () => true, read: async () => ({ model: {} }), command: async () => { throw Error('result unavailable'); } });
  const s = createSession(f.config);
  try { await s.start(); await s.act(s.key(), 'finish'); expect(s.state().blocked).toBe(true); expect(f.calls).not.toContain('journey.transition'); }
  finally { s.dispose(); }
});
