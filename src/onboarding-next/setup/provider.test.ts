import { describe, expect, test } from 'bun:test';
import { createSetupProvider } from './provider.ts';
import type { SetupPorts, SetupScope, SetupState } from './types.ts';

const owner: SetupScope = { actorId: 'fixture-owner', projectId: 'fixture-project' };
const command = { action: 'complete_setup' };
function fixture(initial: Partial<SetupState> = {}) {
  const state: SetupState = { installMode: 'hosted', configured: true, completedAt: null, ...initial };
  const calls = { saves: 0, starts: 0, reads: 0 };
  let running = false;
  const ports: SetupPorts<string> = {
    authorize: context => context === 'trusted' ? owner : null,
    store: {
      read: () => ({ ...state }),
      completeHosted: () => { calls.saves++; state.completedAt ??= 42; return state.completedAt; },
    },
    services: {
      read: async () => { calls.reads++; return running ? 'running' : 'stopped'; },
      start: async () => { calls.starts++; running = true; },
    },
  };
  return { state, calls, ports, provider: createSetupProvider(ports), stop: () => { running = false; } };
}

describe('setup.v1 transition', () => {
  test('factory and explainer reads cannot save, prompt or start services', async () => {
    const f = fixture();
    expect(f.calls).toEqual({ saves: 0, starts: 0, reads: 0 });
    expect(await f.provider.read('trusted')).toMatchObject({ reason: 'setup_required', ready: false });
    expect(f.calls).toEqual({ saves: 0, starts: 0, reads: 0 });
  });
  test('hosted setup completes without permission services or a Permissions step', async () => {
    const f = fixture();
    expect(await f.provider.complete('trusted', command)).toMatchObject({
      schemaVersion: 1, installMode: 'hosted', ready: true, completedAt: 42, services: 'running', next: 'continue',
    });
    expect(f.calls.saves).toBe(1);
    expect(f.calls.starts).toBe(1);
  });
  test('overlapping clicks, lost response and a recreated provider preserve one commit', async () => {
    const f = fixture();
    const answers = await Promise.all(Array.from({ length: 8 }, () => f.provider.complete('trusted', command)));
    expect(answers.every(value => value.ready)).toBe(true);
    expect(f.calls.saves).toBe(1);
    expect(f.calls.starts).toBe(1);
    expect(await createSetupProvider(f.ports).complete('trusted', command)).toEqual(answers[0]!);
    expect(f.calls.saves).toBe(1);
    f.stop();
    expect(await createSetupProvider(f.ports).complete('trusted', command)).toMatchObject({ ready: true, completedAt: 42 });
    expect(f.calls.starts).toBe(2);
  });
  test('unknown/delayed hosted probe never falls through to self setup', async () => {
    const f = fixture({ installMode: 'unknown', configured: false });
    expect(await f.provider.complete('trusted', command)).toMatchObject({ installMode: 'unknown', reason: 'install_mode_unknown', next: 'retry' });
    expect(f.calls.saves).toBe(0);
    f.state.installMode = 'hosted'; f.state.configured = true;
    expect(await f.provider.complete('trusted', command)).toMatchObject({ installMode: 'hosted', ready: true });
  });
  test('an unavailable hosted AI service does not expose a provider/key path', async () => {
    const f = fixture({ configured: false });
    expect(await f.provider.complete('trusted', command)).toMatchObject({ installMode: 'hosted', next: 'retry', reason: 'hosted_configuration_unavailable' });
    expect(f.calls.saves).toBe(0);
  });
  test('self hosting retains legacy configuration even after a skip marker', async () => {
    const f = fixture({ installMode: 'self', configured: false, completedAt: 42 });
    expect(await f.provider.complete('trusted', command)).toMatchObject({ next: 'legacy_setup', reason: 'legacy_setup_required' });
    expect(f.calls.saves).toBe(0); expect(f.calls.starts).toBe(0);
    f.state.configured = true; f.state.completedAt = null;
    expect(await f.provider.complete('trusted', command)).toMatchObject({ next: 'legacy_setup' });
    f.state.completedAt = 99;
    expect(await f.provider.complete('trusted', command)).toMatchObject({ ready: true, completedAt: 99 });
    expect(f.calls.saves).toBe(0);
  });
  test('save failure cannot acknowledge completion or start services, and retry works', async () => {
    const f = fixture();
    const save = f.ports.store!.completeHosted;
    f.ports.store!.completeHosted = () => { throw new Error('secret failure detail'); };
    const failed = await f.provider.complete('trusted', command);
    expect(failed).toMatchObject({ reason: 'setup_save_failed', completedAt: null, ready: false });
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(f.calls.starts).toBe(0);
    f.ports.store!.completeHosted = save;
    expect((await f.provider.complete('trusted', command)).ready).toBe(true);
  });
  test('read failure never fabricates an incomplete self-hosted installation', async () => {
    const f = fixture();
    f.ports.store!.read = () => { throw new Error('corrupt'); };
    expect(await f.provider.complete('trusted', command)).toMatchObject({ installMode: 'unknown', reason: 'setup_unavailable', ready: false });
    expect(f.calls.saves).toBe(0);
  });
  test('a service failure retains saved setup and can be retried without saving again', async () => {
    const f = fixture(); const start = f.ports.services!.start;
    f.ports.services!.start = async () => { throw new Error('failed'); };
    expect(await f.provider.complete('trusted', command)).toMatchObject({ reason: 'services_start_failed', completedAt: 42, ready: false });
    f.ports.services!.start = start;
    expect((await f.provider.complete('trusted', command)).ready).toBe(true);
    expect(f.calls.saves).toBe(1);
  });
  test('a resolved startup promise alone is not evidence of service readiness', async () => {
    const f = fixture(); f.ports.services!.start = async () => {};
    expect(await f.provider.complete('trusted', command)).toMatchObject({ reason: 'services_not_running', completedAt: 42, ready: false });
    f.ports.services!.read = async () => 'unavailable';
    expect(await f.provider.read('trusted')).toMatchObject({ reason: 'services_unavailable', ready: false });
  });
  test('missing optional modules fail closed and no sibling imports are needed', async () => {
    const f = fixture(); delete f.ports.store;
    expect(await f.provider.read('trusted')).toMatchObject({ supported: false, reason: 'provider_unavailable' });
    const other = fixture(); delete other.ports.services;
    expect(await other.provider.complete('trusted', command)).toMatchObject({ ready: false, completedAt: 42, reason: 'services_unavailable' });
    expect(await other.provider.checkAction('trusted', { action: 'screen_observation' })).toMatchObject({ supported: false, ready: false });
  });
  test('authorization runs for every retry and rejects client identity/configuration', async () => {
    const f = fixture();
    expect(await f.provider.complete('untrusted', command)).toMatchObject({ reason: 'unauthorized' });
    for (const input of [null, {}, [], { ...command, actorId: 'victim' }, { ...command, llm: { api_key: 'secret' } }, { ...command, installMode: 'self' }]) {
      expect(await f.provider.complete('trusted', input)).toMatchObject({ reason: 'invalid_request' });
    }
    expect(f.calls.saves).toBe(0);
    await f.provider.complete('trusted', command);
    f.ports.authorize = () => null;
    expect(await f.provider.complete('trusted', command)).toMatchObject({ reason: 'unauthorized' });
  });
});
