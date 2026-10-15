import { describe, expect, test } from 'bun:test';
import { createOnboardingRuntime } from './runtime.ts';
import { PROVIDERS, REQUIRED, type Operation } from './contract.ts';
import { fixtureOptions, omit, request } from './test-fixture.ts';

describe('optional runtime and release closure', () => {
  test('constructs with zero modules without loading or touching services', async () => {
    const o = fixtureOptions(); const runtime = createOnboardingRuntime({ ...o, modules: [] });
    expect(o.calls).toEqual([]);
    const s = await runtime.status(request());
    expect(s.ready).toBe(false); expect(s.supported).toBe(false);
    expect(Object.values(s.capabilities).every(c => !c.present && c.reason === 'module_absent')).toBe(true);
    expect(o.calls).toEqual([]);
    await expect(runtime.execute(request(), 'build.submit', {})).rejects.toMatchObject({ status: 503 });
  });
  test('a single merged module is registered but cannot switch the journey', async () => {
    const o = fixtureOptions(); o.modules = o.modules.slice(0, 1);
    const s = await createOnboardingRuntime(o).status(request());
    expect(s.capabilities['journey.v1']).toEqual({ present: true, registered: true, supported: true, ready: true, reason: 'ready' });
    expect(s.ready).toBe(false); expect(s.released).toBe(false);
  });
  for (const cap of REQUIRED) test(`removing ${cap} blocks the complete journey`, async () => {
    const o = omit(fixtureOptions(), cap); const runtime = createOnboardingRuntime(o);
    expect((await runtime.status(request())).ready).toBe(false);
    await expect(runtime.execute(request(), 'build.submit', {})).rejects.toMatchObject({ status: 503 });
  });
  test('missing optional diagnostics does not block or become a reverse dependency', async () => {
    expect((await createOnboardingRuntime(omit(fixtureOptions(), 'diagnostics.v1')).status(request())).ready).toBe(true);
  });
  test('does not load dependent factory until its provider requirements are ready', async () => {
    const o = fixtureOptions(); const s = await createOnboardingRuntime(omit(o, 'interview-profile.v1')).status(request());
    expect(s.capabilities['interview-session.v1'].reason).toBe('dependency_unavailable');
    expect(o.calls).not.toContain('load:interview-session.v1');
  });
  test('all source modules without bindings remain unsupported', async () => {
    const o = fixtureOptions(); const s = await createOnboardingRuntime({ ...o, bindings: {} }).status(request());
    expect(s.supported).toBe(false); expect(o.calls).toEqual([]);
  });
  test('binding without its HTTP operations is incomplete', async () => {
    const o = fixtureOptions(); o.bindings!['build-job.v1'] = () => ({ probe: () => ({ ready: true, reason: 'ready' }), operations: {} });
    const s = await createOnboardingRuntime(o).status(request());
    expect(s.capabilities['build-job.v1'].ready).toBe(false); expect(s.ready).toBe(false);
  });
  test('module presence, readiness, flag and release permission are distinct', async () => {
    for (const patch of [{ enabled: false }, { enabled: undefined }, { authorizeRelease: undefined }, { candidate: undefined }, { authorizeRelease: async () => false }]) {
      const o = { ...fixtureOptions(), ...patch }; const r = createOnboardingRuntime(o); const s = await r.status(request());
      expect(s.capabilities['build-job.v1'].ready).toBe(true); expect(s.ready).toBe(false);
      await expect(r.execute(request(), 'build.submit', {})).rejects.toMatchObject({ status: 503 });
      expect(o.calls.some(c => c.startsWith('execute:'))).toBe(false);
    }
  });
  test('unknown/failed install probes never classify as self or ready', async () => {
    for (const installMode of [() => 'unknown' as const, () => { throw new Error('secret'); }]) {
      const o = { ...fixtureOptions(), installMode }; const s = await createOnboardingRuntime(o).status(request());
      expect(s.installMode).toBe('unknown'); expect(s.ready).toBe(false); expect(o.calls).toEqual([]);
    }
  });
  test('approved exact candidate is checked each time; revoked approval blocks effects', async () => {
    const o = fixtureOptions(); let approved = true; let checks = 0;
    o.authorizeRelease = async candidate => { checks++; expect(candidate).toEqual(o.candidate!); return approved; };
    const r = createOnboardingRuntime(o); await r.execute(request(), 'build.submit', {});
    approved = false;
    await expect(r.execute(request(), 'build.submit', {})).rejects.toMatchObject({ reason: 'release_blocked' });
    expect(checks).toBe(2); expect(o.calls.filter(c => c === 'execute:build.submit')).toHaveLength(1);
  });
  test('rechecks revoked identity after asynchronous readiness before any effect', async () => {
    const o = fixtureOptions(); let active = true;
    o.authorize = () => active ? { actorId: 'owner', projectId: 'project' } : null;
    o.authorizeRelease = async () => { active = false; return true; };
    await expect(createOnboardingRuntime(o).execute(request(), 'build.submit', {})).rejects.toMatchObject({ status: 401 });
    expect(o.calls.some(c => c.startsWith('execute:'))).toBe(false);
  });
  test('scope change and abort refuse response without claiming rollback', async () => {
    const o = fixtureOptions(); let actor = 'owner'; o.authorize = () => ({ actorId: actor, projectId: 'project' });
    const original = o.bindings!['build-job.v1']!;
    o.bindings!['build-job.v1'] = async (...args) => {
      const p = (await original(...args))!;
      p.operations['build.submit'] = async () => { actor = 'other'; return {}; }; return p;
    };
    await expect(createOnboardingRuntime(o).execute(request(), 'build.submit', {})).rejects.toMatchObject({ status: 401 });
    const aborted = new Request(request(), { signal: AbortSignal.abort() });
    await expect(createOnboardingRuntime(fixtureOptions()).status(aborted)).rejects.toMatchObject({ status: 401 });
  });
  test('readiness exceptions and hangs are bounded and redacted', async () => {
    const o = fixtureOptions(); o.probeTimeoutMs = 5;
    o.bindings!['journey.v1'] = () => ({ probe: () => new Promise(() => {}), operations: { 'journey.read': async () => ({}), 'journey.transition': async () => ({}) } });
    const s = await createOnboardingRuntime(o).status(request());
    expect(s.ready).toBe(false); expect(s.capabilities['journey.v1'].reason).toBe('provider_unavailable');
  });
  test('rejects forged registry IDs, versions, requirements and duplicates', () => {
    for (const edit of [(m: any) => m.id = 'evil', (m: any) => m.schemaVersion = 2, (m: any) => m.requires = ['journey.v1']]) {
      const o = fixtureOptions(); edit(o.modules[0]!.manifest); expect(() => createOnboardingRuntime(o)).toThrow('Invalid onboarding registry');
    }
    const o = fixtureOptions(); o.modules = [...o.modules, o.modules[0]!]; expect(() => createOnboardingRuntime(o)).toThrow();
  });
  test('internal acknowledgements and arbitrary operation names are unreachable', async () => {
    await expect(createOnboardingRuntime(fixtureOptions()).execute(request(), 'journey.acknowledge' as Operation, {})).rejects.toMatchObject({ status: 404 });
  });
});
