import { beforeAll, afterAll, beforeEach, afterEach, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let useStorage: typeof import('./StorageStatus').useStorageStatus, Banner: typeof import('./StorageStatus').StorageStatusBanner;
let root: Root, host: HTMLDivElement, health: unknown;
beforeAll(async () => { GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  ({ useStorageStatus: useStorage, StorageStatusBanner: Banner } = await import('./StorageStatus')); });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
const http: any = { json: async (path: string) => { expect(path).toBe('/api/health'); if (health instanceof Error) throw health; return health; } };
function App() { return <Banner problem={useStorage(http)} />; }
const show = async () => { await React.act(async () => { root.render(<App />); await new Promise(r => setTimeout(r, 0)); }); };

test('a full disk shows a plain banner', async () => {
  health = { storage: { writable: false, message: 'Jarvis cannot save: the disk is full. Free some space and Jarvis will carry on.' } };
  await show();
  expect(host.textContent).toContain('Jarvis cannot save: the disk is full');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

test('nothing shows while saving works, or when health cannot be read', async () => {
  health = { storage: { writable: true, message: null } };
  await show();
  expect(host.textContent).toBe('');
  health = new Error('offline');
  await show();
  expect(host.textContent).toBe('');
});
