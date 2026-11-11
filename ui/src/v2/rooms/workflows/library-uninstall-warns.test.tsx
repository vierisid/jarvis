import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
let act: typeof import('react').act;
let createRoot: typeof import('react-dom/client').createRoot;
let LibraryPanel: typeof import('./LibraryPanel').LibraryPanel;
let Env: typeof import('./WorkflowEditorEnvironment').WorkflowEditorEnvironment;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeAll(async () => {
  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ LibraryPanel } = await import('./LibraryPanel'));
  ({ WorkflowEditorEnvironment: Env } = await import('./WorkflowEditorEnvironment'));
});
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { globalThis.fetch = originalFetch; await act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

const WARNING = '"Daily post" uses Discord and stops working until you reinstall it from the Library.';
const entry = { id: 'discord', npmPackage: '@activepieces/piece-discord', displayName: 'Discord', description: '', iconUrl: null, tier: 'community',
  versionRange: '^0.1.0', vettedVersion: '0.1.0', vettedAt: null, sourceUrl: null, licenseSpdx: '', estimatedSizeMb: null,
  installed: { resolvedVersion: '0.1.0', installedAt: 1, source: 'user' }, withdrawn: null };

test('the uninstall confirmation names the enabled workflows that use the piece', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/dependents')) return NativeResponse.json({ usedBy: [{ id: 'f1', name: 'Daily post' }], warning: WARNING });
    if (init?.method === 'DELETE') return NativeResponse.json({ uninstalled: true });
    return NativeResponse.json({ managed: false, entries: [entry] });
  }) as typeof fetch;
  let asked = '';
  window.confirm = (message?: string) => { asked = String(message); return false; };
  const request = (async (url: string) => NativeResponse.json({ managed: false, entries: [entry] })) as any;
  await act(async () => root.render(<Env.Provider value={{ request, portalHost: null, workspace: false }}><LibraryPanel /></Env.Provider>));
  const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Community'))!;
  await act(async () => toggle.click());
  const uninstall = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Uninstall')!;
  await act(async () => { uninstall.click(); await new Promise((r) => setTimeout(r, 20)); });
  expect(seen).toContain('GET /api/workflows/pieces/library/discord/dependents');
  expect(asked).toContain(WARNING);
  // Declined: nothing is uninstalled.
  expect(seen.some((s) => s.startsWith('DELETE'))).toBe(false);
});
