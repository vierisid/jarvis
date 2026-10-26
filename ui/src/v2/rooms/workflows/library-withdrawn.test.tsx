import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// #971: a piece the catalog withdrew (Actual Budget, for its dependencies'
// licenses) stays installed on a self-managed install. Its Library row says
// why, and offers Uninstall only: the server refuses Install and Update.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NativeResponse = globalThis.Response;
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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

const REASON = 'Actual Budget is no longer offered: it pulls GPL-3.0-only and AGPL-3.0-or-later code.';
const row = (id: string, extra: Record<string, unknown>) => ({
  id, npmPackage: `@activepieces/piece-${id}`, displayName: id, description: '', iconUrl: null, tier: 'community',
  versionRange: '^0.1.0', vettedVersion: '0.2.0', vettedAt: null, sourceUrl: null, licenseSpdx: '', estimatedSizeMb: null,
  ...extra,
});

const calls: Array<{ url: string; method: string }> = [];
const render = async (extra: unknown[] = []) => {
  calls.length = 0;
  const request = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return NativeResponse.json({
      managed: false,
      entries: [
        // Older than the vetted version, so an ordinary row would offer Update.
        row('actualbudget', { installed: { resolvedVersion: '0.1.9', installedAt: 1, source: 'user' }, withdrawn: { reason: REASON } }),
        row('activecampaign', { installed: { resolvedVersion: '0.1.0', installedAt: 1, source: 'user' }, withdrawn: null }),
        row('gmail', { installed: null, withdrawn: null }),
        ...extra,
      ],
    });
  }) as any;
  await act(async () => root.render(
    <Env.Provider value={{ request, portalHost: null, workspace: false }}><LibraryPanel /></Env.Provider>));
  const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Community'))!;
  await act(async () => toggle.click());
};
const rowFor = (name: string) =>
  [...host.querySelectorAll('li.wf-lib__row')].find((li) => li.querySelector('.wf-lib__row-name')?.textContent === name)!;
const buttons = (li: Element) => [...li.querySelectorAll('button')].map((b) => b.textContent?.trim());

test('a withdrawn row says why and offers Uninstall only', async () => {
  await render();
  const li = rowFor('actualbudget');
  expect(li.textContent).toContain('Withdrawn');
  expect(li.textContent).toContain(REASON);
  expect(li.textContent).toContain('workflows can keep using it until you uninstall it');
  expect(buttons(li)).toEqual(['Uninstall']);
  expect(li.textContent).not.toContain('Update');
  // No source link when the server had none to give.
  expect(li.querySelector('a.wf-lib__row-source')).toBeNull();
});

test('an ordinary installed row behind the vetted version still offers Update', async () => {
  await render();
  const li = rowFor('activecampaign');
  expect(li.textContent).not.toContain('Withdrawn');
  expect(buttons(li)).toEqual(['Update', 'Uninstall']);
});

test('the subtitle counts a withdrawn row as installed but not as available', async () => {
  await render();
  // Installed: actualbudget + activecampaign. Available: activecampaign + gmail.
  expect(host.querySelector('.wf-lib__subtitle')?.textContent).toBe('2 installed of 2 available');
});

test('uninstalling a withdrawn row whose manifest id is not a plain slug stays on its own route', async () => {
  // A withdrawn id comes from the local manifest, not the static catalog.
  await render([row('../../x?y', { installed: { resolvedVersion: '1.0.0', installedAt: 1, source: 'user' }, withdrawn: { reason: REASON } })]);
  const prevConfirm = window.confirm;
  const asked: string[] = [];
  window.confirm = (msg?: string) => { asked.push(String(msg)); return true; };
  try {
    const li = rowFor('../../x?y');
    const btn = [...li.querySelectorAll('button')].find((b) => b.textContent?.includes('Uninstall'))!;
    await act(async () => btn.click());
  } finally {
    window.confirm = prevConfirm;
  }
  expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/workflows/pieces/library/..%2F..%2Fx%3Fy']);
  // A withdrawn piece cannot be installed again, so the prompt must not promise a reinstall.
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('cannot be installed again');
  expect(asked[0]).not.toContain('until reinstalled');
});
