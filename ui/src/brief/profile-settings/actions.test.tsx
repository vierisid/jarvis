import { beforeAll, afterAll, afterEach, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { SettingsHook, UserProfileResponse } from '../../v2/rooms/settings/useSettingsData';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let ProfileTab: typeof import('../../v2/rooms/settings/tabs/ProfileTab').ProfileTab;
let replay: typeof import('./actions').replayProfileSettings, openVoice: typeof import('./actions').openVoiceSettings;
let takeSettings: typeof import('../../v2/shell/settings-tab-request').takeRequestedSettingsTab;
let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement;
beforeAll(async () => {
  ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client'));
  ({ ProfileTab } = await import('../../v2/rooms/settings/tabs/ProfileTab'));
  ({ replayProfileSettings: replay, openVoiceSettings: openVoice } = await import('./actions'));
  ({ takeRequestedSettingsTab: takeSettings } = await import('../../v2/shell/settings-tab-request'));
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); globalThis.fetch = originalFetch; takeSettings(); window.location.hash = ''; });
afterAll(() => GlobalRegistrator.unregister());
test('voice setup opens the current channels form with no credential or provider writes', () => {
  let writes = 0; globalThis.fetch = (async () => { writes++; return NativeResponse.json({}); }) as unknown as typeof fetch;
  openVoice(); expect(takeSettings()).toBe('channels'); expect(window.location.hash).toBe('#/_room_settings'); expect(writes).toBe(0);
});
test('confirmed replay delegates exactly once to the existing API and never requests provider setup', async () => {
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init }); return NativeResponse.json({ ok: true, scope: 'profile', cleared: [], client_cache_keys: [] });
  }) as typeof fetch;
  await expect(replay('profile', false)).rejects.toThrow();
  await expect(replay('setup' as 'profile', true)).rejects.toThrow(); expect(calls).toHaveLength(0);
  await replay('profile', true); await replay('tutorial', true);
  expect(calls.map(c => [c.url, c.init?.method, JSON.parse(c.init?.body as string)])).toEqual([
    ['/api/onboarding/reset', 'POST', { scope: 'profile' }], ['/api/onboarding/reset', 'POST', { scope: 'tutorial' }],
  ]);
});
test('the real legacy form retains its edit revision across polling and a failed save keeps the draft open', async () => {
  const profile = (revision: string): UserProfileResponse => ({ revision, questions: [{ id: 'company', label: 'Company', step: 1, step_title: 'Identity', prompt: 'Company?', description: '' }],
    profile: { version: 1, answers: { company: revision }, created_at: 1, updated_at: 1, completed_at: 1 }, answered_count: 1, total_questions: 1, has_profile: true });
  const saves: unknown[] = [];
  const data = (revision: string) => ({ profile: profile(revision), saveProfile: async (answers: unknown, rev: unknown) => { saves.push({ answers, rev }); return { ok: false, message: 'conflict' }; } } as unknown as SettingsHook);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (revision: string) => { await act(async () => root!.render(<ProfileTab data={data(revision)} onToast={() => {}} />)); };
  await render('original');
  await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Edit profile')!.click(); });
  await render('concurrent');
  await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Save profile'))!.click(); });
  expect(saves).toEqual([{ answers: { company: 'original' }, rev: 'original' }]);
  expect(host.querySelector('input')?.value).toBe('original');
});
