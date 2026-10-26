import { beforeEach, afterEach, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiRoutes, type ApiContext } from './api-routes';
import { initDatabase, closeDb } from '../vault/schema';
import { DEFAULT_CONFIG } from '../config/types';
import { getUserProfile } from '../vault/user-profile';
import { ProfileSettings } from '../brief/profile-settings';
import { BriefCapabilities } from '../brief/capabilities';
import { registerProfileSettings } from '../brief/registrations/profile-settings';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';
import { createProfilePort } from '../../ui/src/brief/account/profile/adapter';
import { ProfileController } from '../../ui/src/brief/account/profile/controller';
import { createSettingsPort } from '../../ui/src/brief/account/settings/adapter';

let service: ProfileSettings, config: typeof DEFAULT_CONFIG, flag: string | undefined;
const path = '/api/brief/profile-settings';
beforeEach(() => {
  flag = process.env.JARVIS_BRIEF_PROFILE_SETTINGS; process.env.JARVIS_BRIEF_PROFILE_SETTINGS = '1';
  initDatabase(':memory:', { quiet: true }); config = structuredClone(DEFAULT_CONFIG); service = new ProfileSettings(config);
});
afterEach(() => { closeDb(); if (flag === undefined) delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS; else process.env.JARVIS_BRIEF_PROFILE_SETTINGS = flag; });
function routes(enabled = true, registered = service): Record<string, any> {
  return createApiRoutes({ config, briefProfileSettings: service, briefCapabilities: new BriefCapabilities(registerProfileSettings(registered), enabled ? ['profileSettings'] : []) } as ApiContext);
}
const req = (suffix = '', value?: unknown) => new Request('http://localhost'+path+suffix, value === undefined ? {} : { method: 'PATCH', body: JSON.stringify(value) });
test('exact provider, capability and live flag gate reads and writes; errors and reads never cache', async () => {
  for (const table of [routes(false), routes(true, new ProfileSettings(config)), createApiRoutes({} as ApiContext) as any]) {
    for (const suffix of ['', '/profile']) {
      const response = await table[path+suffix][suffix ? 'PATCH' : 'GET'](req(suffix, suffix ? {} : undefined));
      expect([501,503]).toContain(response.status); expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  }
  expect((await routes()[path].GET(req('?scope=foreign'))).status).toBe(400);
  delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS;
  expect((await routes()[path].GET(req())).status).toBe(503);
});
test('malformed, foreign scope and oversized mutations fail before any persistence', async () => {
  const route = routes()[path+'/profile'].PATCH;
  for (const body of [null, [], {}, { revision: 'x', answers: {} }, { revision: service.profile().revision, answers: { company: 'X' }, scope: 'foreign' }]) {
    expect((await route(req('/profile', body))).status).toBe(400);
  }
  expect((await route(new Request('http://localhost'+path+'/profile', { method: 'PATCH', body: 'x'.repeat(64_001) }))).status).toBe(413);
  expect((await route(new Request('http://localhost'+path+'/profile', { method: 'PATCH', body: new Uint8Array([255]) }))).status).toBe(400);
  expect(getUserProfile()).toBeNull();
});
test('rechecks the gate and revision after waiting for the body', async () => {
  const route = routes()[path+'/profile'].PATCH, revision = service.profile().revision;
  const racing = (change: () => void) => new Request('http://localhost'+path+'/profile', { method: 'PATCH', body: new ReadableStream({ pull(c) {
    change(); c.enqueue(new TextEncoder().encode(JSON.stringify({ revision, answers: { company: 'Stale' } }))); c.close();
  } }) });
  expect((await route(racing(() => { delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS; }))).status).toBe(503);
  expect(getUserProfile()).toBeNull(); process.env.JARVIS_BRIEF_PROFILE_SETTINGS = '1';
  expect((await route(racing(() => { service.saveProfile(revision, { company: 'Concurrent' }); }))).status).toBe(409);
  expect(getUserProfile()?.answers.company).toBe('Concurrent');
});
test('legacy profile editor shares CAS and cannot overwrite a newer Brief save', async () => {
  const table = routes(), legacy = table['/api/user-profile'];
  const initial = await (await legacy.GET()).json();
  service.saveProfile(initial.revision, { company: 'New company' });
  const post = (body: unknown) => legacy.POST(new Request('http://localhost/api/user-profile', { method: 'POST', body: JSON.stringify(body) }));
  expect((await post({ revision: initial.revision, answers: { preferred_name: 'Old tab' } })).status).toBe(409);
  expect((await post({ answers: { preferred_name: 'Old binary' } })).status).toBe(428);
  expect(getUserProfile()?.answers.company).toBe('New company');
  expect((await post({ revision: service.profile().revision, answers: { preferred_name: 'Fresh tab', company: 'New company' } })).status).toBe(200);
  expect(getUserProfile()?.answers.preferred_name).toBe('Fresh tab');
});
test('flag off: legacy saves without a revision still work; Settings full-form and empty-form saves succeed', async () => {
  delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS;
  const legacy = routes(false)['/api/user-profile'];
  const post = (body: unknown) => legacy.POST(new Request('http://localhost/api/user-profile', { method: 'POST', body: JSON.stringify(body) }));
  const empty = await (await legacy.GET()).json();
  expect((await post({ revision: empty.revision, answers: {} })).status).toBe(200);
  expect((await post({ revision: 'f'.repeat(64), answers: {} })).status).toBe(409);
  expect(getUserProfile()).toBeNull();
  expect((await post({ answers: { anything_else: 'Old client' } })).status).toBe(200);
  const current = await (await legacy.GET()).json();
  const saved = await post({ revision: current.revision, answers: { ...current.profile.answers, preferred_name: 'Sam', company: '' } });
  expect(saved.status).toBe(200);
  expect(getUserProfile()?.answers).toEqual({ anything_else: 'Old client', preferred_name: 'Sam' });
  const bad = await post({ revision: (await saved.json()).revision, answers: { anything_else: 'x'.repeat(4001) } });
  expect(bad.status).toBe(400);
  expect(JSON.stringify(await bad.json())).not.toContain('invalid_patch');
});
test('authenticated HTTP feeds the live Brief Profile and Settings ports; anonymous reads and mutations fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f23-http-')), socket = join(dir, 'api.sock');
  const secrets = process.env.JARVIS_SECRETS_DIR; process.env.JARVIS_SECRETS_DIR = join(dir, 'secrets');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture' ? sessions.create('device') : null, resolvePanelSession: (s: string) => sessions.get(s) } as SidecarManager);
  server.setApiRoutes(routes());
  const send = (url: string, init: RequestInit = {}) => fetch('http://localhost'+url, { ...init, unix: socket });
  const signal = () => new AbortController().signal;
  try {
    server.start(); expect((await send(path)).status).toBe(401);
    expect((await send(path+'/profile', { method: 'PATCH', body: '{}' })).status).toBe(401);
    const bootstrap = await send(path+'?token=fixture', { redirect: 'manual' });
    const Cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const request = (url: string, init: RequestInit) => send(url, { ...init, headers: { ...init.headers as Record<string, string>, Cookie } });
    expect((await send(path, { headers: { Cookie } })).headers.get('Cache-Control')).toBe('no-store');

    // D-29 Profile: the real F-23 snapshot passes the strict mapping check and a save is confirmed by readback.
    const profile = createProfilePort('live-profile', { request, canWrite: true });
    const read = await profile.read(signal());
    if (read.state !== 'ready') throw new Error('profile read ' + read.state);
    const saved = await profile.save(read.data.revision, { company: 'Example' }, signal());
    expect(saved).toMatchObject({ state: 'confirmed', data: { answers: { company: 'Example' } } });
    expect(getUserProfile()?.answers.company).toBe('Example');
    // A save elsewhere wins: the stale revision is a conflict, the controller keeps the draft, nothing is overwritten.
    const controller = new ProfileController(profile);
    try {
      controller.setAccess(true);
      for (let i = 0; i < 2000 && (controller.snapshot().reading || !controller.snapshot().base); i++) await Bun.sleep(5);
      expect(controller.snapshot().base?.answers.company).toBe('Example');
      service.saveProfile(service.profile().revision, { company: 'Memory correction' });
      controller.edit('company', 'Unsaved draft');
      await controller.save();
      expect(controller.snapshot().phase).toBe('conflict');
      expect(controller.value('company')).toBe('Unsaved draft');
      expect(getUserProfile()?.answers.company).toBe('Memory correction');
    } finally { controller.retire(); }

    // D-30 Settings: voice is revision-bound through the real route.
    const settings = createSettingsPort('live-settings', { request, canWrite: true, destinations: {} });
    const current = await settings.read(signal());
    if (current.state !== 'ready') throw new Error('settings read ' + current.state);
    const next = current.data.voice.choices.find(c => c.id !== current.data.voice.voice)!.id;
    expect(await settings.saveVoice(current.data.voice.revision, next, signal())).toMatchObject({ state: 'confirmed', data: { voice: { voice: next } } });
    expect(await settings.saveVoice(current.data.voice.revision, next, signal())).toEqual({ state: 'conflict' });
    expect(service.voice().voice).toBe(next);
    // Anonymous transport is refused, not read as an empty profile.
    expect(await createProfilePort('anon', { request: send, canWrite: true }).read(signal())).toEqual({ state: 'unavailable' });
  } finally {
    server.stop(); rmSync(dir, { recursive: true, force: true });
    if (secrets === undefined) delete process.env.JARVIS_SECRETS_DIR; else process.env.JARVIS_SECRETS_DIR = secrets;
  }
});
