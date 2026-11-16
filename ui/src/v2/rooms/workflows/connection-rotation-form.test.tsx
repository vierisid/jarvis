import { afterAll, afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

const connection = { id: 'c1', externalId: 'slack-main', displayName: 'Slack', type: 'SECRET_TEXT', pieceName: '@activepieces/piece-slack',
  status: 'ACTIVE', created: 1, updated: 1 };
const sentence = '"Weekly digest" uses this connection. If you save a new key, it stops running until you publish it again to accept the new key.';

const AFTER = '"Weekly digest" uses this connection and is paused until you publish it again to accept the new key.';

async function openRotate(message: string | null, saved: Record<string, unknown> = {}) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { ConnectionsPanel } = await import('./ConnectionsPanel');
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/workflows/connections') return NativeResponse.json({ connections: [connection], jarvisSources: [] });
    if (url === '/api/workflows/connections/c1/rotation-impact') return NativeResponse.json({ workflows: [], message });
    if (url === '/api/workflows/connections/c1' && init?.method === 'PATCH') return NativeResponse.json({ id: 'c1', ...saved });
    return NativeResponse.json({});
  }) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await React.act(async () => root.render(<ConnectionsPanel />));
  for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const rotate = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Rotate'))!;
  await React.act(async () => rotate.click());
  for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { host, done: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

test('the Rotate form says which workflows stop when a new key is saved', async () => {
  const { host, done } = await openRotate(sentence);
  try {
    expect(host.querySelector('[data-testid="rotation-notice"]')?.textContent).toBe(sentence);
  } finally { await done(); }
});

test('the Rotate form says nothing extra when no enabled workflow runs on the connection', async () => {
  const { host, done } = await openRotate(null);
  try {
    expect(host.querySelector('[data-testid="rotation-notice"]')).toBeNull();
  } finally { await done(); }
});

test('saving a new key that paused workflows says which, and saving nothing new says only "Updated"', async () => {
  for (const [saved, expected] of [[{ notice: AFTER }, `Updated "Slack". ${AFTER}`], [{}, 'Updated "Slack"']] as const) {
    const { React } = { React: await import('react') };
    const { host, done } = await openRotate(sentence, saved);
    try {
      const area = host.querySelector('textarea')!;
      await React.act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        set.call(area, '{"secret_text":"canary-new"}');
        area.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const save = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Save'))!;
      await React.act(async () => { save.click(); await new Promise(r => setTimeout(r, 20)); });
      expect(host.querySelector('.wf-toast')?.textContent).toBe(expected);
    } finally { await done(); }
  }
});
