import { expect, it } from 'bun:test';
import { googleBrowserPorts } from './browser.ts';

it('reuses external-open detection and cleans the exact return listeners on exit', () => {
  const saved = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
  const win = new EventTarget(), doc = new EventTarget();
  let externally = false, refreshes = 0;
  Object.defineProperties(win, { open: { value: () => null }, __jarvisOpensExternally: { get: () => externally } });
  Object.defineProperty(doc, 'visibilityState', { value: 'visible' });
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    expect(googleBrowserPorts.open('https://accounts.google.com/fixture')).toBe(false);
    externally = true; expect(googleBrowserPorts.open('https://accounts.google.com/fixture')).toBe(true);
    const cleanup = googleBrowserPorts.onReturn(() => { refreshes++; });
    win.dispatchEvent(new Event('focus')); doc.dispatchEvent(new Event('visibilitychange')); expect(refreshes).toBe(2);
    win.dispatchEvent(new Event('message')); expect(refreshes).toBe(2);
    cleanup(); win.dispatchEvent(new Event('focus')); doc.dispatchEvent(new Event('visibilitychange')); expect(refreshes).toBe(2);
  } finally {
    for (const key of ['window', 'document'] as const) {
      const descriptor = saved[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
