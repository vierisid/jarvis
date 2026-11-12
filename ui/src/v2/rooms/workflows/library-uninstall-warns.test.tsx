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

/** One environment request answers the panel's reads and writes, as the Brief host's transport does. */
function hostRequest(deleteAnswer: Record<string, unknown>, seen: string[]) {
  return (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/dependents')) return NativeResponse.json({ usedBy: [{ id: 'f1', name: 'Daily post' }], warning: WARNING });
    if (init?.method === 'DELETE') return NativeResponse.json(deleteAnswer);
    return NativeResponse.json({ managed: false, entries: [entry] });
  }) as any;
}

async function clickUninstall(request: unknown) {
  // The global fetch is not the panel's: every call goes through the environment's request.
  globalThis.fetch = (async () => { throw new Error('the panel must use the environment request'); }) as unknown as typeof fetch;
  await act(async () => root.render(<Env.Provider value={{ request: request as typeof fetch, portalHost: null, workspace: true }}><LibraryPanel /></Env.Provider>));
  const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Community'))!;
  await act(async () => toggle.click());
  const uninstall = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Uninstall')!;
  await act(async () => { uninstall.click(); await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

test('the uninstall confirmation names the enabled workflows that use the piece', async () => {
  const seen: string[] = [];
  let asked = '';
  window.confirm = (message?: string) => { asked = String(message); return false; };
  await clickUninstall(hostRequest({ uninstalled: true }, seen));
  expect(seen).toContain('GET /api/workflows/pieces/library/discord/dependents');
  expect(asked).toContain(WARNING);
  // Declined: nothing is uninstalled.
  expect(seen.some((s) => s.startsWith('DELETE'))).toBe(false);
});

test('after the uninstall the toast names the workflows the uninstall itself reported', async () => {
  // The answer to DELETE is read as the piece goes; it can name a workflow enabled after the confirmation opened.
  const DELETED = '"Daily post", "Weekly digest" use Discord and stop working until you reinstall it from the Library.';
  const seen: string[] = [];
  window.confirm = () => true;
  await clickUninstall(hostRequest({ uninstalled: true, usedBy: [], warning: DELETED }, seen));
  expect(seen).toContain('DELETE /api/workflows/pieces/library/discord');
  expect(host.querySelector('.wf-toast')?.textContent).toBe(`Discord uninstalled. ${DELETED}`);
});
