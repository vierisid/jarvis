import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import { makeCanvasFixture } from '../../brief/workflows/canvas/fixtures';
import type { HostTransport } from '../../brief/host/http';
import type { ResultCanvasProps } from '../views/result';

let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot,
  createResultCanvas: typeof import('./renderers').createResultCanvas;
let host: HTMLDivElement, root: Root;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react');
  ({ createRoot } = await import('react-dom/client'));
  ({ createResultCanvas } = await import('./renderers'));
});
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

type Fixture = ReturnType<typeof makeCanvasFixture>;
type Read = (input: RequestInfo | URL, init: RequestInit | undefined, fixture: Fixture) => Promise<Response>;
async function render(read: Read) {
  const fixture = makeCanvasFixture(true);
  const Canvas = createResultCanvas({ request: (input: RequestInfo | URL, init?: RequestInit) => read(input, init, fixture) } as unknown as HostTransport);
  let unavailable = 0;
  const draft = { flowId: 'meeting', versionId: fixture.versionId, scopeId: 'result-test', title: 'Meeting', graph: {}, selectedNodeId: null } as unknown as ResultCanvasProps['draft'];
  await React.act(async () => root.render(<Canvas draft={draft} reviewing={false} onDirtyChange={() => {}} onUnavailable={() => { unavailable++; }} />));
  return () => unavailable;
}

test('an interrupted read the editor retries does not revoke the onboarding result canvas', async () => {
  let attempts = 0;
  const unavailable = await render((input, init, fixture) => {
    if (String(input) === '/api/workflows/meeting' && ++attempts === 1) return Promise.reject(new DOMException('Fetch is aborted', 'AbortError'));
    return fixture.request(input, init);
  });
  expect(attempts).toBe(2);
  expect(unavailable()).toBe(0);
  expect(host.textContent).not.toContain('Workflow loading was interrupted');
});

test('a real read failure still revokes the onboarding result canvas', async () => {
  const unavailable = await render((input, init, fixture) =>
    String(input) === '/api/workflows/meeting' ? Promise.reject(new TypeError('Failed to fetch')) : fixture.request(input, init));
  expect(unavailable()).toBeGreaterThan(0);
});
