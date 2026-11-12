import { describe, expect, test } from 'bun:test';
import { NOTCH_PAGE_PATH, notchRoutes } from './routes.ts';

describe('the notch page route', () => {
  // Off means the page is not there at all, not there-but-refused.
  test('does not exist while the switch is off', () => {
    expect(Object.keys(notchRoutes(false))).toEqual([]);
  });

  test('serves the page as HTML, uncached, while the switch is on', async () => {
    const routes = notchRoutes(true);
    expect(Object.keys(routes)).toEqual([NOTCH_PAGE_PATH]);
    const res = routes[NOTCH_PAGE_PATH]!.GET(new Request(`http://localhost${NOTCH_PAGE_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  // The path is under /api on purpose: that prefix is what the server sends
  // through its session check before any route runs.
  test('lives under /api so it is behind the session check', () => {
    expect(NOTCH_PAGE_PATH.startsWith('/api/')).toBe(true);
  });

  // The page and the desktop app meet at three names. If one side renames
  // them the window would open and stay invisible, because no outline arrives.
  test('the page calls the three functions the desktop app provides', async () => {
    const html = await notchRoutes(true)[NOTCH_PAGE_PATH]!.GET(new Request('http://localhost/')).text();
    for (const name of ['__notch_set_outline', '__notch_focus', '__notch_log']) {
      expect(html).toContain(`'${name}'`);
    }
    const sidecar = await Bun.file(new URL('../../sidecar/notch_host.go', import.meta.url)).text();
    for (const name of ['__notch_set_outline', '__notch_focus', '__notch_log']) {
      expect(sidecar).toContain(`bind("${name}"`);
    }
    // And one the other way: the desktop app tells the page where the pointer is.
    expect(html).toContain('window.__notch_cursor = ');
    expect(sidecar).toContain('window.__notch_cursor&&window.__notch_cursor(');
  });
});
