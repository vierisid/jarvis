import { beforeEach, afterEach, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { getSetting, setSetting } from '../vault/settings';
import { getUserProfile, saveUserProfile, appendUserProfileFact, getUserProfileForPrompt } from '../vault/user-profile';
import { correctFact, findFacts } from '../vault/facts';
import { MemoryForget } from './memory-forget';
import { ProfileSettings } from './profile-settings';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types';
import { mergeUserSettingsIntoConfig, persistUserPatch, saveUserSection, setSectionSavedListener } from '../daemon/user-settings';
import { SettingsReloadCoordinator } from '../daemon/settings-reload';
import { effectiveTtsForBinding } from '../daemon/usejarvis-ai';
import { USER_PROFILE_QUESTIONS } from '../user/profile';
import { recordMemoryHandoff, withMemoryRecall } from '../vault/memory-use-context';

let dir: string, file: string, config: JarvisConfig, service: ProfileSettings, env: Record<string, string | undefined>;
beforeEach(() => {
  env = Object.fromEntries(['JARVIS_BRIEF_PROFILE_SETTINGS', 'JARVIS_BRIEF_MEMORY_FORGET', 'JARVIS_SECRETS_DIR'].map(k => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'f23-')); file = join(dir, 'vault.db');
  process.env.JARVIS_SECRETS_DIR = join(dir, 'secrets'); process.env.JARVIS_BRIEF_PROFILE_SETTINGS = '1';
  initDatabase(file, { quiet: true }); config = structuredClone(DEFAULT_CONFIG); service = new ProfileSettings(config);
});
afterEach(() => { setSectionSavedListener(null); closeDb(); rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const edit = (answers: unknown) => service.saveProfile(service.profile().revision, answers);
test('maps all six native fields without account identity aliasing; preserves every existing context question', () => {
  const data = service.read();
  expect(data.fields).toHaveLength(6);
  expect(data.fields.find(f => f.id === 'full_name')).toMatchObject({ owner: 'account', state: 'unavailable', questionId: null });
  expect(data.questions.map(q => q.id)).toEqual(USER_PROFILE_QUESTIONS.map(q => q.id));
  expect(data.account).toMatchObject({ state: 'unavailable', reason: 'self_hosted' });
  expect(data.checkIn).toEqual({ state: 'unavailable', reason: 'check_in_not_supported', choices: [] });
  expect(() => edit({ full_name: 'An account name' })).toThrow('invalid_patch');
  expect(() => edit({ checkIn: 'daily' })).toThrow('invalid_patch');
  expect(getSetting('cfg.heartbeat')).toBeNull();
});
test('patch/read/restart roundtrip keeps unedited answers, interview facts, and knowledge projections', () => {
  saveUserProfile({ preferred_name: 'Alex', work_role: 'Founder at Example', interests: 'Space' });
  appendUserProfileFact({ theme: 'rhythm', summary: 'Morning work' });
  const before = service.profile();
  const saved = edit({ company: '  Example  ', communication_preferences: 'Brief answers' });
  expect(saved.answers).toMatchObject({ company: 'Example', work_role: 'Founder at Example', interests: 'Space' });
  expect(saved.revision).not.toBe(before.revision);
  expect(findFacts({ predicate: 'company' }).some(f => f.object === 'Example')).toBe(true);
  closeDb(); initDatabase(file, { quiet: true }); service = new ProfileSettings(structuredClone(DEFAULT_CONFIG));
  expect(service.profile()).toEqual(saved);
  expect(getUserProfile()?.interview_facts?.[0]?.summary).toBe('Morning work');
  edit({ company: null }); expect(service.profile().answers.company).toBeUndefined();
});
test('stale saves conflict with legacy writers, interview updates, and memory corrections', () => {
  edit({ preferred_name: 'Alex', company: 'Old company' });
  let revision = service.profile().revision;
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Space' });
  expect(() => service.saveProfile(revision, { company: 'lost update' })).toThrow('revision_conflict');
  revision = service.profile().revision;
  appendUserProfileFact({ theme: 'work', summary: 'New information' });
  expect(() => service.saveProfile(revision, { company: 'lost update' })).toThrow('revision_conflict');
  revision = service.profile().revision;
  const fact = findFacts({ predicate: 'company' }).find(f => f.object === 'Old company')!;
  correctFact(fact.id, 'Corrected company', 'User correction');
  expect(service.profile().answers.company).toBe('Corrected company');
  expect(() => service.saveProfile(revision, { company: 'lost update' })).toThrow('revision_conflict');
});
test('unchanged saves and unrelated edits do not resurrect forgotten profile facts', () => {
  process.env.JARVIS_BRIEF_MEMORY_FORGET = '1'; edit({ preferred_name: 'Alex', company: 'Forgotten company' });
  const fact = findFacts({ predicate: 'company' }).find(f => f.object === 'Forgotten company')!;
  const forget = new MemoryForget(getDb()), current = forget.get(fact.id);
  if (current.state !== 'ready') throw Error('fixture');
  forget.forget(fact.id, { requestId: 'forget-company', expectedRevision: current.revision, confirmed: true });
  const before = service.profile();
  expect(edit({ company: 'Forgotten company' })).toEqual(before);
  edit({ interests: 'Space' });
  expect(getUserProfileForPrompt()?.answers.company).toBeUndefined();
  expect(findFacts({ predicate: 'company' })).toHaveLength(0);
});
for (const change of ['edit', 'clear', 'blank'] as const) test(`a revisioned ${change} during a prepared turn ${change === 'edit' ? 'passes' : 'is refused as a delete'} (Q-16)`, () => {
  edit({ preferred_name: 'Alex', company: 'Example' });
  const handoff = (text: string) => recordMemoryHandoff([{ role: 'system', content: text }]);
  withMemoryRecall(() => {
    const prepared = JSON.stringify(getUserProfileForPrompt()!.answers);
    edit({ company: change === 'edit' ? 'Example Two' : change === 'clear' ? null : '  ' });
    if (change === 'edit') expect(() => handoff(prepared)).not.toThrow();
    else expect(() => handoff(prepared)).toThrow('was deleted');
  });
  withMemoryRecall(() => handoff(JSON.stringify(getUserProfileForPrompt()?.answers ?? {})));
});
test('invalid/oversized fields, corrupt records and failed projections fail without partial writes', () => {
  const revision = service.profile().revision;
  for (const input of [{ company: 42 }, { company: 'x'.repeat(4001) }, [], {}, { foreign: 'x' }]) expect(() => edit(input)).toThrow('invalid_patch');
  expect(service.profile().revision).toBe(revision);
  getDb().run("CREATE TRIGGER refuse_fact BEFORE INSERT ON facts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect(() => edit({ preferred_name: 'Alex', company: 'X' })).toThrow();
  expect(getUserProfile()).toBeNull();
  expect(service.profile().revision).toBe(revision);
  for (const raw of ['{', '[]', '{"version":2,"answers":{}}']) {
    setSetting('user.profile.v1', raw); expect(() => service.profile()).toThrow('profile_unavailable');
  }
});
test('hosted silent defaults survive voice-only save, reload and restart without any SYSTEM writes', async () => {
  config.usejarvis_ai = { base_url: 'https://fixture.invalid', api_key: 'system-fixture-key' };
  const systemBefore = JSON.stringify(config.usejarvis_ai);
  const first = service.read();
  expect(first.setup).toMatchObject({ deployment: 'hosted', providerSetup: 'managed' });
  expect(first.voice).toMatchObject({ provider: 'usejarvis', voice: 'alloy' });
  const result = await service.saveVoice(first.voice.revision, 'nova');
  expect(result).toMatchObject({ saved: true, application: 'restart_required', voice: { voice: 'nova' } });
  expect(JSON.parse(getSetting('cfg.tts')!)).toEqual({ voice: 'nova' });
  expect(JSON.stringify(config.usejarvis_ai)).toBe(systemBefore);
  closeDb(); initDatabase(file, { quiet: true });
  const restarted = structuredClone(DEFAULT_CONFIG); restarted.usejarvis_ai = config.usejarvis_ai;
  mergeUserSettingsIntoConfig(restarted);
  expect(effectiveTtsForBinding(restarted)).toMatchObject({ provider: 'usejarvis', voice: 'nova', enabled: false });
  expect(new ProfileSettings(restarted).read().voice).toEqual(result.voice);
  expect(getDb().query('SELECT key FROM settings').all()).toEqual([{ key: 'cfg.tts' }]);
});
test('voice validation preserves nested configuration and keychain credentials; no paid provider call', async () => {
  saveUserSection('tts', { provider: 'edge', enabled: true, elevenlabs: { api_key: 'fixture-secret', voice_id: 'existing' } });
  const initial = service.voice();
  await expect(service.saveVoice(initial.revision, 'arbitrary')).rejects.toThrow('unsupported_voice');
  expect(service.voice()).toEqual(initial);
  await service.saveVoice(initial.revision, 'en-US-GuyNeural');
  expect(config.tts?.elevenlabs).toMatchObject({ api_key: 'fixture-secret', voice_id: 'existing' });
  expect(getSetting('cfg.tts')).not.toContain('fixture-secret');
  expect(JSON.stringify(service.read())).not.toContain('fixture-secret');
  expect(config.tts?.enabled).toBe(true);
  const rev = service.voice().revision;
  persistUserPatch('tts', { rate: '+20%' });
  await expect(service.saveVoice(rev, 'en-US-AriaNeural')).rejects.toThrow('revision_conflict');
  expect(JSON.parse(getSetting('cfg.tts')!).rate).toBe('+20%');
});
test('unavailable providers and corrupt rows never become arbitrary writable voices', async () => {
  for (const raw of ['{', '[]', '{"provider":"elevenlabs"}', '{"provider":"sarvam"}', '{"provider":"usejarvis"}']) {
    setSetting('cfg.tts', raw); const current = service.voice();
    expect(current.state).toBe('unavailable');
    await expect(service.saveVoice(current.revision, 'nova')).rejects.toThrow();
    expect(getSetting('cfg.tts')).toBe(raw);
  }
});
test('hot apply uses the current canonical voice and exposes failed application after a successful save', async () => {
  const reload = new SettingsReloadCoordinator(config, { googleTokensPath: join(dir, 'absent') });
  const seen: string[] = [];
  reload.registerApplier('tts', c => { seen.push(c.tts!.voice!); });
  service = new ProfileSettings(config, () => reload.applyNow('tts'));
  expect(await service.saveVoice(service.voice().revision, 'en-US-GuyNeural')).toMatchObject({ saved: true, application: 'applied' });
  expect(seen).toEqual(['en-US-GuyNeural']);
  service = new ProfileSettings(config, async () => { throw Error('secret backend error'); });
  const response = await service.saveVoice(service.voice().revision, 'en-US-AriaNeural');
  expect(response.application).toBe('failed'); expect(response.saved).toBe(true);
  expect(JSON.stringify(response)).not.toContain('secret');
  expect(JSON.parse(getSetting('cfg.tts')!).voice).toBe('en-US-AriaNeural');
});
test('direct mutations obey the default-off gate', async () => {
  delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS;
  expect(service.readiness()).toBe('unavailable'); expect(() => service.read()).toThrow('unavailable');
  expect(() => edit({ company: 'X' })).toThrow('unavailable');
  await expect(service.saveVoice('0'.repeat(64), 'nova')).rejects.toThrow('unavailable');
});


test('Profile exposes interview context without copying it over editable answers', () => {
  appendUserProfileFact({ theme: 'work', summary: 'Runs a Cornish surf apparel brand' });
  appendUserProfileFact({ theme: 'goals', summary: 'Reach 50 orders per month' });
  expect(service.profile().interviewFacts).toEqual([
    { theme: 'work', summary: 'Runs a Cornish surf apparel brand' },
    { theme: 'goals', summary: 'Reach 50 orders per month' },
  ]);
  expect(service.profile().answers).toEqual({});
  edit({ company: 'Cornish Surf' });
  expect(service.profile().interviewFacts).toHaveLength(2);
});


test('Profile hides forgotten or superseded interview statements on refresh', () => {
  appendUserProfileFact({ theme: 'work', summary: 'Runs the old business' });
  const fact = findFacts({ predicate: 'shared about work' })[0]!;
  correctFact(fact.id, 'Runs the new business', 'Updated by user');
  expect(service.profile().interviewFacts).toEqual([]);
  appendUserProfileFact({ theme: 'tools', summary: 'Uses Shopify' });
  const tool = findFacts({ predicate: 'shared about tools' })[0]!;
  const forget = new MemoryForget(getDb(), () => true); const read = forget.get(tool.id);
  if (read.state !== 'ready') throw Error('missing tool');
  forget.forget(tool.id, { requestId: 'forget-profile-context', expectedRevision: read.revision, confirmed: true });
  expect(service.profile().interviewFacts).toEqual([]);
});
