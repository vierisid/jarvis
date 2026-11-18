import { beforeAll, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { SettingsHook } from '../useSettingsData';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot, Tab: typeof import('./IntegrationsTab').IntegrationsTab;
beforeAll(async () => { GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; React = await import('react'); ({ createRoot } = await import('react-dom/client')); ({ IntegrationsTab: Tab } = await import('./IntegrationsTab')); });
afterAll(() => GlobalRegistrator.unregister());

async function render(google: Record<string, unknown>, extra: Partial<SettingsHook> = {}) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await React.act(async () => root.render(<Tab data={{ google, refresh() {}, ...extra } as SettingsHook} onToast={() => {}} />));
  return { host, done: async () => { await React.act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch; } };
}

test('#957: connecting is read-only unless the owner ticks sending, and the grant is said before they choose', async () => {
  const asked: Array<{ send?: boolean }> = [];
  const savedOpen = window.open; window.open = (() => null) as typeof window.open;
  const view = await render({ status: 'credentials_saved', managed: false, scopes: [] }, {
    initGoogleAuth: async (opts: { send?: boolean } = {}) => { asked.push(opts); return { ok: false as const, message: 'stop' }; } } as Partial<SettingsHook>);
  try {
    expect(view.host.textContent).toContain('Every send still waits for your approval on a card');
    const connect = [...view.host.querySelectorAll('button')].find(b => b.textContent === 'Connect Google account')!;
    await React.act(async () => connect.click());
    const box = view.host.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await React.act(async () => box.click());
    await React.act(async () => connect.click());
    expect(asked).toEqual([{ send: false }, { send: true }]);
  } finally { window.open = savedOpen; await view.done(); }
});

test('#957: the connected account says what is true in each state', async () => {
  const readOnly = await render({ status: 'connected', is_authenticated: true, managed: false, scopes: ['gmail.readonly', 'calendar.readonly'], can_send: false, token_expiry: null });
  try {
    expect(readOnly.host.textContent).toContain('Read-only: Jarvis does not send mail or edit events from this account.');
    expect([...readOnly.host.querySelectorAll('button')].map(b => b.textContent)).toContain('Allow sending mail');
    expect(readOnly.host.textContent).not.toContain('never sends');
  } finally { await readOnly.done(); }
  const sending = await render({ status: 'connected', is_authenticated: true, managed: false, scopes: ['gmail.readonly', 'calendar.readonly', 'gmail.send'], can_send: true, token_expiry: null });
  try {
    expect(sending.host.textContent).toContain('read and send (each send asks you first)');
    expect(sending.host.textContent).toContain('Every send waits for your approval on a card before it goes out.');
    expect([...sending.host.querySelectorAll('button')].map(b => b.textContent)).toContain('Make read-only');
  } finally { await sending.done(); }
  const hosted = await render({ status: 'connected', is_authenticated: true, managed: true, connect_url: 'https://example.test/account', scopes: [], can_send: false, send_available: false, token_expiry: null });
  try {
    expect(hosted.host.textContent).toContain('connected, read-only. Jarvis does not send mail or edit events from this account.');
    expect(hosted.host.textContent).toContain('not turned on for this instance');
  } finally { await hosted.done(); }
  const hostedSend = await render({ status: 'connected', is_authenticated: true, managed: true, connect_url: 'https://example.test/account', scopes: [], can_send: true, send_available: true, token_expiry: null });
  try {
    expect(hostedSend.host.textContent).toContain('Jarvis can send mail from this account, and every send waits for your approval on a card first.');
  } finally { await hostedSend.done(); }
});
