import { beforeAll, beforeEach, afterEach, afterAll, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { HostDescriptor } from './owner';

const self: HostDescriptor = { schemaVersion: 1, scopeId: 'project', generation: 'boot', installMode: 'self',
  dashboard: 'legacy', capabilities: { contractVersion: 1, capabilities: {} } };

let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let DashboardRoot: typeof import('./DashboardRoot').DashboardRoot;
let root: ReturnType<typeof createRoot>, element: HTMLDivElement;
let originalFetch: typeof fetch, calls: string[], response: () => Promise<Response>;
const shell = { mounts: 0, unmounts: 0 };

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://instance.test/' });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  // The legacy shell is counted, not rendered: a remount restarts its socket and drops drafts.
  mock.module('../../v2/AppShellV2', () => ({ AppShellV2: () => {
    React.useEffect(() => { shell.mounts++; return () => { shell.unmounts++; }; }, []);
    return <p>legacy shell</p>;
  } }));
  ({ DashboardRoot } = await import('./DashboardRoot'));
});
beforeEach(() => {
  shell.mounts = 0; shell.unmounts = 0;
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  originalFetch = globalThis.fetch; calls = []; response = async () => Response.json(self);
  globalThis.fetch = (async (path: RequestInfo | URL) => { calls.push(String(path)); return response(); }) as typeof fetch;
});
afterEach(async () => { await React.act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; });
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
