import { beforeAll, afterAll, afterEach, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { SettingsHook, UserProfileResponse } from '../../v2/rooms/settings/useSettingsData';
const NativeResponse = globalThis.Response, NativeRequest = globalThis.Request, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let ProfileTab: typeof import('../../v2/rooms/settings/tabs/ProfileTab').ProfileTab;
let useSettingsData: typeof import('../../v2/rooms/settings/useSettingsData').useSettingsData;
let replay: typeof import('./actions').replayProfileSettings, openVoice: typeof import('./actions').openVoiceSettings;
let takeSettings: typeof import('../../v2/shell/settings-tab-request').takeRequestedSettingsTab;
let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement;
beforeAll(async () => {
  ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client'));
  ({ ProfileTab } = await import('../../v2/rooms/settings/tabs/ProfileTab'));
  ({ useSettingsData } = await import('../../v2/rooms/settings/useSettingsData'));
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

test('real hook keeps canonical save/clear results despite reordered responses and failed reads', async () => {
  const { initDatabase, closeDb } = await import('../../../../src/vault/schema');
  const { saveUserProfile } = await import('../../../../src/vault/user-profile');
  const { createApiRoutes } = await import('../../../../src/daemon/api-routes');
  const { DEFAULT_CONFIG } = await import('../../../../src/config/types');
  const oldFlag = process.env.JARVIS_BRIEF_PROFILE_SETTINGS;
  process.env.JARVIS_BRIEF_PROFILE_SETTINGS = '1'; initDatabase(':memory:', { quiet: true });
  try {
    saveUserProfile({ company: 'Before' });
    const table = createApiRoutes({ config: structuredClone(DEFAULT_CONFIG) } as any) as any;
    let observed!: SettingsHook, holdNext = false, release!: (r: Response) => void, held!: Response;
    let failProfileReads = false, legacyClearReply = false;
    let holdSave = false, releaseSave!: (r: Response) => void, heldSave!: Response;
    const posts: number[] = [], toasts: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === '/api/user-profile' && !init?.method && failProfileReads) return NativeResponse.json({}, { status: 503 });
      if (url === '/api/user-profile' || url === '/api/user-profile/clear') {
        const response = await table[url][init?.method ?? 'GET'](new NativeRequest('http://localhost'+url, init));
        if (init?.method === 'POST') posts.push(response.status);
        if (url === '/api/user-profile' && init?.method === 'POST' && holdSave) {
          holdSave = false; heldSave = response; return new Promise<Response>(r => { releaseSave = r; });
        }
        if (url === '/api/user-profile/clear' && legacyClearReply) return NativeResponse.json({ ok: true, message: 'User profile cleared.' });
        if (!init?.method && holdNext) { holdNext = false; held = response; return new Promise<Response>(r => { release = r; }); }
        return response;
      }
      return NativeResponse.json(null);
    }) as typeof fetch;
    function Harness() { observed = useSettingsData(); return <ProfileTab data={observed} onToast={text => toasts.push(text)} />; }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(<Harness />); });
    const before = observed.profile!.revision!;
    holdNext = true; const poll = observed.refresh();
    await act(async () => { expect((await observed.saveProfile({ company: 'After' }, before)).ok).toBe(true); });
    const saved = observed.profile!.revision!; expect(saved).not.toBe(before);
    await act(async () => { release(held); await poll; });
    expect(observed.profile!.revision).toBe(saved);
    const click = async (label: string) => act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label)!.click(); });
    await click('Edit profile'); await click('Next'); await click('Next'); await click('Next'); await click('Save profile');
    expect(posts).toEqual([200, 200]); expect(toasts).toEqual(['User profile saved.']);
    holdNext = true; const clearingPoll = observed.refresh();
    await act(async () => { expect((await observed.clearProfile()).ok).toBe(true); });
    expect(observed.profile!.profile).toBeNull();
    await act(async () => { release(held); await clearingPoll; });
    expect(observed.profile!.profile).toBeNull();
    holdSave = true;
    let saving!: ReturnType<SettingsHook['saveProfile']>;
    await act(async () => { saving = observed.saveProfile({ company: 'Delayed response' }, observed.profile!.revision); });
    expect(heldSave.status).toBe(200);
    await act(async () => { expect((await observed.clearProfile()).ok).toBe(true); });
    const clearedRevision = observed.profile!.revision;
    await act(async () => { releaseSave(heldSave); expect((await saving).ok).toBe(false); });
    expect(observed.profile!.profile).toBeNull(); expect(observed.profile!.revision).toBe(clearedRevision);
    await act(async () => { expect((await observed.saveProfile({ company: 'Latest' }, clearedRevision)).ok).toBe(true); });
    expect(observed.profile!.profile?.answers.company).toBe('Latest');
    failProfileReads = true;
    await act(async () => { expect((await observed.clearProfile()).ok).toBe(true); });
    expect(observed.profile!.profile).toBeNull(); expect(host.textContent).not.toContain('Loading profile');
    failProfileReads = false;
    await act(async () => { expect((await observed.saveProfile({ company: 'Legacy fallback' }, observed.profile!.revision)).ok).toBe(true); });
    legacyClearReply = true; failProfileReads = true;
    await act(async () => {
      const result = await observed.clearProfile(); expect(result.ok).toBe(false); expect(result.message).toContain('was cleared');
    });
    expect(observed.profile).not.toBeNull(); expect(host.textContent).not.toContain('Loading profile');
  } finally {
    closeDb(); if (oldFlag === undefined) delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS; else process.env.JARVIS_BRIEF_PROFILE_SETTINGS = oldFlag;
  }
});
