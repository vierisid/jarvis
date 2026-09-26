import { describe, test, expect } from 'bun:test';
import { checkNavigationUrl, isDrivableUrl, isLocalContentUrl, isLoopbackHost, registerDevtoolsPort } from './url-policy.ts';
import { blockReason } from './browser-request-guard.ts';

describe('checkNavigationUrl (#521)', () => {
  test('allows the web, data: and about:blank, returning the normalised href', () => {
    expect(checkNavigationUrl('https://example.com')).toBe('https://example.com/');
    expect(checkNavigationUrl('http://example.com/a?b=c#d')).toBe('http://example.com/a?b=c#d');
    expect(checkNavigationUrl('  HTTPS://Example.COM/x  ')).toBe('https://example.com/x');
    expect(checkNavigationUrl('about:blank')).toBe('about:blank');
    expect(checkNavigationUrl('about:blank#top')).toBe('about:blank#top');
    expect(checkNavigationUrl('data:text/html,%3Cp%3Ehi%3C%2Fp%3E')).toStartWith('data:text/html,');
    // A dev server on loopback is fine; only DevTools ports are refused.
    expect(checkNavigationUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
  });

  test('refuses local files in every spelling the parser folds into file:', () => {
    for (const url of [
      'file:///etc/hostname',
      'FILE:///etc/hostname',
      '  file:///etc/hostname',
      '\tfile:///etc/hostname',
      'file:/etc/hostname',
      'file://localhost/etc/hostname',
      'fi\nle:///etc/hostname',
      'file:///proc/self/environ',
      'file:///C:/Users/me/.ssh/id_rsa',
    ]) {
      expect(() => checkNavigationUrl(url)).toThrow(/the browser does not open local files/);
    }
  });

  test('refuses browser-internal and wrapper schemes', () => {
    for (const url of [
      'view-source:file:///etc/hostname',
      'view-source:https://example.com',
      'filesystem:file:///persistent/x',
      'chrome://settings/passwords',
      'chrome-extension://abc/page.html',
      'chrome-untrusted://x/',
      'devtools://devtools/bundled/inspector.html',
      'about:settings',
      'about:version',
      'about:srcdoc',
      'javascript:alert(1)',
      'blob:https://example.com/0f1d2e3c',
      'ftp://example.com/file',
      'ws://example.com/',
    ]) {
      expect(() => checkNavigationUrl(url)).toThrow(/Refusing to open/);
    }
  });

  test('explains what is allowed', () => {
    expect(() => checkNavigationUrl('chrome://settings')).toThrow(/only opens http:\/\/, https:\/\/, data: and about:blank URLs \(got "chrome:"\)/);
    expect(() => checkNavigationUrl('about:settings')).toThrow(/map to browser-internal chrome:\/\/ pages/);
  });

  test('a scheme-less or empty input gets a hint, not a navigation', () => {
    expect(() => checkNavigationUrl('')).toThrow(/No URL given/);
    expect(() => checkNavigationUrl('example.com/path')).toThrow(/Include the scheme, e\.g\. https:\/\/example\.com\/path/);
    // Parses, as scheme "localhost:". Refused, and the scheme is named.
    expect(() => checkNavigationUrl('localhost:3000')).toThrow(/got "localhost:"/);
  });

  test("refuses the DevTools endpoints of Jarvis's browsers on loopback", () => {
    for (const url of [
      'http://127.0.0.1:9222/json/version',
      'http://localhost:9222/json/list',
      'http://anything.localhost:9223/json/new?file:///etc/hostname',
      'http://127.1:9222/',
      'http://0x7f.0.0.1:9222/',
      'http://[::1]:9223/',
      'https://127.0.0.1:9222/',
    ]) {
      expect(() => checkNavigationUrl(url)).toThrow(/DevTools endpoint/);
    }
    // Not refused here on another host. (The in-browser guard still blocks
    // the port on every host; see blockReason below.)
    expect(checkNavigationUrl('http://example.com:9222/')).toBe('http://example.com:9222/');

    // A connected controller's port is refused while it stays registered.
    const port = 41000 + Math.floor(Math.random() * 1000);
    expect(checkNavigationUrl(`http://127.0.0.1:${port}/`)).toBe(`http://127.0.0.1:${port}/`);
    const release = registerDevtoolsPort(port);
    const releaseAgain = registerDevtoolsPort(port);
    expect(() => checkNavigationUrl(`http://127.0.0.1:${port}/`)).toThrow(/DevTools endpoint/);
    release();
    release(); // idempotent: must not drop the other registration
    expect(() => checkNavigationUrl(`http://127.0.0.1:${port}/`)).toThrow(/DevTools endpoint/);
    releaseAgain();
    expect(checkNavigationUrl(`http://127.0.0.1:${port}/`)).toBe(`http://127.0.0.1:${port}/`);
  });

  test('isLoopbackHost', () => {
    for (const h of ['localhost', 'LOCALHOST', 'a.b.localhost', 'localhost.', '127.0.0.1', '127.9.8.7', '[::1]', '0.0.0.0']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['example.com', 'localhost.example.com', '128.0.0.1', '10.0.0.1']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  test('isDrivableUrl and isLocalContentUrl classify tabs that already exist', () => {
    expect(isDrivableUrl('https://example.com/')).toBe(true);
    expect(isDrivableUrl('about:blank')).toBe(true);
    expect(isDrivableUrl('file:///etc/hostname')).toBe(false);
    expect(isDrivableUrl('chrome://newtab/')).toBe(false);
    expect(isDrivableUrl('http://127.0.0.1:9222/json')).toBe(false);
    expect(isLocalContentUrl('file:///etc/hostname')).toBe(true);
    expect(isLocalContentUrl('view-source:file:///etc/hostname')).toBe(true);
    expect(isLocalContentUrl('https://example.com/file:')).toBe(false);
  });
});

describe('BrowserRequestGuard blockReason (#521)', () => {
  const ports = new Set([9222, 9223]);

  test('fails local files and DevTools-port requests', () => {
    expect(blockReason('file:///etc/hostname', ports)).toMatch(/local files/);
    expect(blockReason('file://server/share/x', ports)).toMatch(/local files/);
    expect(blockReason('http://127.0.0.1:9222/json/new', ports)).toMatch(/DevTools port/);
    expect(blockReason('http://foo.localhost:9223/', ports)).toMatch(/DevTools port/);
    expect(blockReason('not a url', ports)).toMatch(/unparseable/);
  });

  test('lets through a URL the port wildcard matched only textually', () => {
    expect(blockReason('https://example.com/a:9222/b', ports)).toBeNull();
    expect(blockReason('https://example.com/', ports)).toBeNull();
  });
});

describe('browser_navigate applies the allowlist on every route (#521)', () => {
  test('before routing to a sidecar, which has no check of its own', async () => {
    const { browserNavigateTool } = await import('../tools/builtin.ts');
    // Refused before the target is resolved, so no sidecar need exist.
    const out = await browserNavigateTool.execute({ url: 'file:///etc/hostname', target: 'any-sidecar' });
    expect(String(out)).toStartWith('Error: Refusing to open file:///etc/hostname');
  });

  test('for the background agent, before any browser is launched or attached', async () => {
    const { createBrowserTools } = await import('../tools/builtin.ts');
    const { BrowserController } = await import('./session.ts');
    // Nothing listens on this port; a check after connect() would fail with
    // a launch or connection error instead of the refusal.
    const ctrl = new BrowserController(39995, '/nonexistent/profile');
    const navigate = createBrowserTools(ctrl).find(t => t.name === 'browser_navigate')!;
    const out = await navigate.execute({ url: 'chrome://settings/passwords' });
    expect(String(out)).toStartWith('Error: Refusing to open chrome://settings/passwords');
    expect(ctrl.connected).toBe(false);
  });
});
