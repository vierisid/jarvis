import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act;
let createRoot: typeof import('react-dom/client').createRoot;
let Callout: typeof import('./WorkflowsRoom').PausedRunCallout;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let waitpoints: unknown[];
beforeAll(async () => {
  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ PausedRunCallout: Callout } = await import('./WorkflowsRoom'));
});
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  globalThis.fetch = (async () => NativeResponse.json({ waitpoints })) as unknown as typeof fetch;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

test('dashboard identifies the required child and loop without offering a manual resume', async () => {
  waitpoints = [{ id: 'wait', stepName: 'child', type: 'MANUAL',
    child: { childRunId: 'child-run', status: 'PAUSED', executionPath: [['loop', 1]] } }];
  await act(async () => root.render(<Callout runId="parent" />));
  expect(host.textContent).toContain('Waiting for child run child-run (PAUSED)');
  expect(host.textContent).toContain('loop[1]');
  expect(host.textContent).toContain('Continues automatically');
  expect(host.textContent).not.toContain('POST');
  expect(host.textContent).not.toContain('undefined');
});

test('ordinary webhook waitpoints retain their resume instructions', async () => {
  waitpoints = [{ id: 'wait', stepName: 'signal', type: 'WEBHOOK', resumeUrl: '/api/webhooks/waitpoints/wait' }];
  await act(async () => root.render(<Callout runId="parent" />));
  expect(host.textContent).toContain('POST any JSON body');
  expect(host.textContent).toContain('/api/webhooks/waitpoints/wait');
});
