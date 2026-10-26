import { beforeAll, beforeEach, afterEach, afterAll, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { HostDescriptor } from './owner';

const self: HostDescriptor = { schemaVersion: 1, scopeId: 'project', generation: 'boot', installMode: 'self',
  dashboard: 'legacy', capabilities: { contractVersion: 1, capabilities: {} } };

let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let DashboardRoot: typeof import('./DashboardRoot').DashboardRoot;
let root: ReturnType<typeof createRoot>, element: HTMLDivElement;
let originalFetch: typeof fetch, originalSocket: typeof WebSocket, calls: string[], response: () => Promise<Response>;
const shell = { mounts: 0, unmounts: 0 };

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://instance.test/' });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  // The legacy shell is counted, not rendered: a remount restarts its socket and drops drafts.
  // mock.module is process-wide in a bun test run and DashboardRoot keeps this stub once
  // loaded, so no other test file may import DashboardRoot or AppShellV2 for real.
  mock.module('../../v2/AppShellV2', () => ({ AppShellV2: () => {
    React.useEffect(() => { shell.mounts++; return () => { shell.unmounts++; }; }, []);
    return <p>legacy shell</p>;
  } }));
  ({ DashboardRoot } = await import('./DashboardRoot'));
});
beforeEach(() => {
  shell.mounts = 0; shell.unmounts = 0;
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  originalFetch = globalThis.fetch; originalSocket = globalThis.WebSocket; calls = []; response = async () => Response.json(self);
  globalThis.fetch = (async (path: RequestInfo | URL) => { calls.push(String(path)); return response(); }) as typeof fetch;
});
afterEach(async () => { await React.act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });
afterAll(() => GlobalRegistrator.unregister());

async function open(hash: string) {
  window.history.replaceState(null, '', 'https://instance.test/' + hash);
  await React.act(async () => root.render(<DashboardRoot />));
}
async function navigate(hash: string) {
  await React.act(async () => {
    window.history.pushState(null, '', 'https://instance.test/' + hash);
    window.dispatchEvent(new Event('hashchange'));
  });
}

test('a document opened on a legacy-only room never swaps its shell for the hosted loading screen', async () => {
  await open('#/_room_logs');
  for (const hash of ['#/_room_workflows', '#/', '#/_room_settings', '#/_room_logs']) await navigate(hash);
  expect(element.textContent).toBe('legacy shell');
  expect(shell).toEqual({ mounts: 1, unmounts: 0 });
  expect(calls).toHaveLength(0);
});

test('the self-hosted choice is read once at document start and kept through navigation', async () => {
  await open('#/');
  expect(calls).toEqual(['/api/brief/host']);
  for (const hash of ['#/_room_logs', '#/_room_workflows', '#/_task_result', '#/']) await navigate(hash);
  expect(element.textContent).toBe('legacy shell');
  expect(shell).toEqual({ mounts: 1, unmounts: 0 });
  expect(calls).toHaveLength(1);
});

test('a failed document-start read offers reconnect, then the mounted shell stays put', async () => {
  response = async () => new Response(null, { status: 503 });
  await open('#/');
  expect(element.textContent).toContain('Dashboard unavailable');
  expect(shell.mounts).toBe(0);
  response = async () => Response.json(self);
  await React.act(async () => (element.querySelector('button') as HTMLButtonElement).click());
  for (const hash of ['#/_room_logs', '#/_room_workflows']) await navigate(hash);
  expect(shell).toEqual({ mounts: 1, unmounts: 0 });
  expect(calls).toHaveLength(2);
});

const hosted: HostDescriptor = { ...self, installMode: 'hosted', dashboard: 'brief' };
const maintenance = '?brief=0&briefMaintenance=1#/_room_settings';
const hostReads = () => calls.filter(path => path === '/api/brief/host').length;
/** The real Brief tree renders under happy-dom; only its socket and the host routes are stubbed. */
class QuietSocket extends EventTarget { readyState = 0; send() {} close() {} }
function serveHosted() {
  globalThis.WebSocket = QuietSocket as never;
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    calls.push(String(path));
    return String(path) === '/api/brief/host' ? Response.json(hosted)
      : String(path) === '/api/onboarding/status' ? Response.json({ setup_completed: true, profile_completed: true, tutorial_completed: true })
      : new Response(null, { status: 404 });
  }) as typeof fetch;
}

test('a hosted Brief maintenance link keeps the room inside the mounted Brief owner', async () => {
  serveHosted();
  await open('#/');
  expect(element.querySelector('.brief-maintenance')).toBeNull();
  const reads = hostReads();
  await navigate(maintenance);
  expect(element.querySelector('.brief-maintenance')?.textContent).toContain('Back to workspace');
  expect(element.textContent).not.toContain('Opening your workspace');
  expect(shell).toEqual({ mounts: 0, unmounts: 0 });
  expect(calls[0]).toBe('/api/brief/host');
  expect(hostReads()).toBe(reads);
});

test('reloading a hosted Brief maintenance link reopens the room inside Brief', async () => {
  serveHosted();
  await open(maintenance);
  expect(calls[0]).toBe('/api/brief/host');
  expect(element.querySelector('.brief-maintenance')?.textContent).toContain('Back to workspace');
  expect(shell).toEqual({ mounts: 0, unmounts: 0 });
});

test('a self-hosted maintenance link still ends on the legacy shell', async () => {
  await open(maintenance);
  expect(calls).toEqual(['/api/brief/host']);
  await navigate('#/_room_logs');
  expect(element.textContent).toBe('legacy shell');
  expect(shell).toEqual({ mounts: 1, unmounts: 0 });
});

test('a failed read on a maintenance link keeps the legacy shell instead of blocking on reconnect', async () => {
  response = async () => new Response(null, { status: 503 });
  await open(maintenance);
  for (const hash of ['#/', '#/_room_logs']) await navigate(hash);
  expect(element.textContent).toBe('legacy shell');
  expect(shell).toEqual({ mounts: 1, unmounts: 0 });
  expect(calls).toEqual(['/api/brief/host']);
});
