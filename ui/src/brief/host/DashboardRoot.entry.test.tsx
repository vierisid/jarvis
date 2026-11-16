import { beforeAll, beforeEach, afterEach, afterAll, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { HostDescriptor } from './owner';

const self: HostDescriptor = { schemaVersion: 1, scopeId: 'project', workspaceId: 'workspace', generation: 'boot', installMode: 'self',
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
function serveHosted(descriptor = hosted) {
  globalThis.WebSocket = QuietSocket as never;
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    calls.push(String(path));
    return String(path) === '/api/brief/host' ? Response.json(descriptor)
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

for (const hash of ['#/', maintenance]) test(`self-hosted Brief preserves its owner at ${hash}`, async () => {
  serveHosted({ ...self, dashboard: 'brief' });
  await open(hash);
  await navigate(maintenance);
  expect(element.querySelector('.brief-maintenance')?.textContent).toContain('Back to workspace');
  expect(shell).toEqual({ mounts: 0, unmounts: 0 });
});

const withDecisions: HostDescriptor = { ...hosted, capabilities: { contractVersion: 1, asOf: 1, capabilities: {
  decisions: { supported: true, ready: true, enabled: true, state: 'ready', reason: null },
  navigationCompatibility: { supported: true, ready: true, enabled: true, state: 'ready', reason: null } } } };
test('when Jarvis cannot be reached the page says so after a grace period, hides stale counts, and clears on recovery', async () => {
  let up = true;
  globalThis.WebSocket = QuietSocket as never;
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    const url = String(path); calls.push(url);
    if (url === '/api/brief/host') return Response.json(withDecisions);
    if (url === '/api/onboarding/status') return Response.json({ setup_completed: true, profile_completed: true, tutorial_completed: true });
    if (!up) throw new TypeError('Failed to fetch');
    if (url === '/api/authority/status') return Response.json({ enabled: true, emergency_state: 'normal' });
    if (url === '/api/workflow-inputs') return Response.json({ requests: [{ id: 'r1', status: 'pending' }] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });
  const focus = async () => { await React.act(async () => window.dispatchEvent(new Event('focus'))); await settle(); };
  await open('#/'); await settle();
  expect(element.textContent).toContain('1 workflow request needs your attention');
  expect(element.textContent).not.toContain('Jarvis is not reachable');

  up = false; await focus(); await focus(); await focus();
  // Inside the grace period the page stays quiet: no flicker and no misleading emergency notice.
  expect(element.textContent).not.toContain('Jarvis is not reachable');
  expect(element.textContent).not.toContain('Emergency status is unavailable');
  await React.act(async () => { await new Promise(r => setTimeout(r, 4200)); });
  expect(element.textContent).toContain('Jarvis is not reachable. Your work is safe; this page will reconnect on its own.');
  expect(element.textContent).not.toContain('workflow request needs your attention');
  expect(element.querySelector('.brief-connection-text')?.textContent).toBe('Offline');

  up = true; await focus();
  expect(element.textContent).not.toContain('Jarvis is not reachable');
  expect(element.textContent).toContain('1 workflow request needs your attention');
}, 15000);

/** A socket the test opens and closes: `sockets` lists every one the page constructed. */
class ControlledSocket { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; binaryType = ''; onopen: null | (() => unknown) = null; onclose: null | (() => unknown) = null;
  onerror: null | (() => unknown) = null; onmessage: null | ((event: unknown) => unknown) = null;
  constructor() { sockets.push(this); } send() {} close() {} }
let sockets: ControlledSocket[] = [];
test('Retry reconnects the socket at once, and a socket that comes back first never shows the emergency notice', async () => {
  let up = true; sockets = [];
  globalThis.WebSocket = ControlledSocket as never;
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    const url = String(path); calls.push(url);
    if (url === '/api/brief/host') return Response.json(withDecisions);
    if (url === '/api/onboarding/status') return Response.json({ setup_completed: true, profile_completed: true, tutorial_completed: true });
    if (!up) throw new TypeError('Failed to fetch');
    if (url === '/api/authority/status') return Response.json({ enabled: true, emergency_state: 'normal' });
    if (url === '/api/workflow-inputs') return Response.json({ requests: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });
  const focus = async () => { await React.act(async () => window.dispatchEvent(new Event('focus'))); await settle(); };
  await open('#/'); await settle();
  expect(sockets.length).toBeGreaterThan(0);
  // Jarvis stops: the socket closes and status reads fail past the grace period.
  up = false; const failed = sockets.at(-1)!; failed.readyState = 3;
  await React.act(async () => { failed.onclose?.(); }); await focus(); await focus();
  await React.act(async () => { await new Promise(r => setTimeout(r, 4200)); });
  expect(element.textContent).toContain('Jarvis is not reachable');
  for (const socket of sockets) socket.readyState = 3;
  const before = sockets.length;
  await React.act(async () => (element.querySelector('.brief-connection-banner button') as HTMLButtonElement).click());
  // A real reconnect, not only re-reads: a new socket starts without waiting out the backoff.
  expect(sockets.length).toBe(before + 1);

  // Jarvis is back and the socket opens before any focus or poll re-reads the status.
  up = true; const socket = sockets.at(-1)!; socket.readyState = 1;
  await React.act(async () => { await socket.onopen?.(); });
  await settle();
  expect(element.textContent).not.toContain('Jarvis is not reachable');
  expect(element.textContent).not.toContain('Emergency status is unavailable');
}, 15000);
