import { beforeAll, beforeEach, afterEach, afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { FOREGROUND_ALIASES } from '../entry/release-route';
import type { HostDescriptor } from './owner';
import { resolveHostedEntry, useHostedEntry } from './hosted-entry';

const hosted: HostDescriptor = { schemaVersion: 1, scopeId: 'project', generation: 'boot', installMode: 'hosted',
  dashboard: 'brief', capabilities: { contractVersion: 1, capabilities: {} } };

test('the hosted root and existing foreground bookmarks open Brief without URL opt-in', () => {
  expect(resolveHostedEntry('https://instance.test/', hosted)).toEqual({ kind: 'brief', route: { room: 'today', selection: {} } });
  for (const [hash, room] of Object.entries(FOREGROUND_ALIASES))
    expect(resolveHostedEntry(`https://instance.test/${hash}`, hosted)).toEqual({ kind: 'brief', route: { room, selection: {} } });
  expect(resolveHostedEntry('https://instance.test/#/brief/workflow?flowId=f1&versionId=v1', hosted))
    .toEqual({ kind: 'brief', route: { room: 'workflow', selection: { flowId: 'f1', versionId: 'v1' } } });
});

test('legacy rollback, self-hosting and older descriptors cannot be overridden by a URL', () => {
  for (const descriptor of [null, { ...hosted, dashboard: undefined }, { ...hosted, dashboard: 'legacy' as const },
    { ...hosted, installMode: 'self' as const }]) {
    for (const href of ['https://instance.test/', 'https://instance.test/?brief=1#/brief/today'])
      expect(resolveHostedEntry(href, descriptor).kind).toBe('legacy');
  }
});

test('rollback, native panels, onboarding and maintenance destinations retain their existing owners', () => {
  for (const suffix of ['?brief=0#/', '?brief=0#/brief/today', '?onboarding=reset#/', '?briefMaintenance=1#/_room_settings',
    '?settingsTab=llm#/_room_settings', '?sidecarId=device#/_room_settings', '#/_panel_settings', '#/_task_result', '#/_room_logs'])
    expect(resolveHostedEntry('https://instance.test/' + suffix, hosted).kind).toBe('legacy');
  expect(resolveHostedEntry('https://instance.test/#/brief/retired-room', hosted).kind).toBe('moved');
});

let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let root: ReturnType<typeof createRoot>, element: HTMLDivElement, current: ReturnType<typeof useHostedEntry>;
let originalFetch: typeof fetch, calls: { path: string; init?: RequestInit }[], response: () => Promise<Response>;
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://instance.test/' });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
});
beforeEach(() => {
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  originalFetch = globalThis.fetch; calls = []; response = async () => Response.json(hosted);
  globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(path), init }); return response(); }) as typeof fetch;
});
afterEach(async () => { await React.act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());
function Entry({ active = true }: { active?: boolean }) { current = useHostedEntry(active); return <p>{current.state.status}</p>; }
async function render(active = true) { await React.act(async () => root.render(<Entry active={active} />)); }

test('bootstrap uses authenticated no-store reads and retains the chosen owner through navigation', async () => {
  await render();
  expect(current.state).toEqual({ status: 'ready', descriptor: hosted });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ path: '/api/brief/host', init: { credentials: 'same-origin', cache: 'no-store', redirect: 'error' } });
  await render(false); await render(true);
  expect(calls).toHaveLength(1);
});

test('native and explicitly legacy entry paths do not request hosted activation', async () => {
  await render(false); expect(calls).toHaveLength(0);
  await render(true); expect(calls).toHaveLength(1); expect(current.state.status).toBe('ready');
});

test('authentication or network failure offers recovery instead of silently mounting legacy', async () => {
  response = async () => new Response(null, { status: 401 });
  await render(); expect(current.state.status).toBe('unavailable');
  response = async () => { throw Error('Offline'); };
  await React.act(async () => current.retry()); expect(current.state.status).toBe('unavailable');
  response = async () => Response.json(hosted);
  await React.act(async () => current.retry()); expect(current.state).toEqual({ status: 'ready', descriptor: hosted });
});

test('older daemons are compatible but malformed descriptors are unavailable', async () => {
  response = async () => Response.json({ schemaVersion: 2 });
  await render(); expect(current.state.status).toBe('unavailable');
  response = async () => new Response(null, { status: 404 });
  await React.act(async () => current.retry()); expect(current.state).toEqual({ status: 'ready', descriptor: null });
});
