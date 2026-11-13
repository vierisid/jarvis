import { beforeAll, afterAll, beforeEach, afterEach, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let useLost: typeof import('./ConnectionLost').useConnectionLost, Banner: typeof import('./ConnectionLost').ConnectionLostBanner;
let root: Root, host: HTMLDivElement, retries: number;
beforeAll(async () => { GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  ({ useConnectionLost: useLost, ConnectionLostBanner: Banner } = await import('./ConnectionLost')); });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); retries = 0; });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

function App({ down }: { down: boolean }) {
  const lost = useLost(down, 30);
  return <>{lost && <Banner retry={() => { retries++; }} />}</>;
}
const wait = (ms: number) => React.act(async () => { await new Promise(r => setTimeout(r, ms)); });
const show = (down: boolean) => React.act(async () => root.render(<App down={down} />));
const text = () => host.textContent ?? '';

test('the banner appears only after the grace period and clears on recovery', async () => {
  await show(true); expect(text()).toBe('');
  await wait(60);
  expect(text()).toContain('Jarvis is not reachable. Your work is safe; this page will reconnect on its own.');
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await show(false); expect(text()).toBe('');
});

test('a brief blip never shows the banner', async () => {
  await show(true); await wait(10); await show(false); await wait(60);
  expect(text()).toBe('');
});

test('Retry asks the page to try again', async () => {
  await show(true); await wait(60);
  await React.act(async () => host.querySelector('button')!.click());
  expect(retries).toBe(1);
});
