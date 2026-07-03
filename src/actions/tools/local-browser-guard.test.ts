import { test, expect, describe, afterEach } from 'bun:test';
import {
  setLocalBrowserDisabled,
  isLocalBrowserDisabled,
  LOCAL_BROWSER_DISABLED_MSG,
} from './local-tools-guard.ts';
import { launchChrome } from '../browser/chrome-launcher.ts';
import { browserNavigateTool, browserSnapshotTool, browserClickTool } from './builtin.ts';

describe('browser.local: false', () => {
  afterEach(() => {
    setLocalBrowserDisabled(false);
  });

  test('flag round-trips and defaults to enabled', () => {
    expect(isLocalBrowserDisabled()).toBe(false);
    setLocalBrowserDisabled(true);
    expect(isLocalBrowserDisabled()).toBe(true);
  });

  test('launchChrome is a hard choke point: throws, no process spawned', async () => {
    setLocalBrowserDisabled(true);
    // The await matters: without it this assertion can never fail the test.
    await expect(launchChrome(9222)).rejects.toThrow(/browser\.local: false/);
  });

  test('connect() refuses even when something already listens on the CDP port', async () => {
    // Regression (review): connect() probes the port and ATTACHES to any
    // existing listener before ever calling launchChrome - on a shared host
    // that could be another tenant's process. Serve a fake CDP endpoint and
    // verify the guard fires before the probe.
    setLocalBrowserDisabled(true);
    const fakeCdp = Bun.serve({
      port: 0,
      fetch: () => Response.json([]),
    });
    try {
      const { BrowserController } = await import('../browser/session.ts');
      const ctrl = new BrowserController(fakeCdp.port);
      await expect(ctrl.connect()).rejects.toThrow(/browser\.local: false/);
    } finally {
      fakeCdp.stop();
    }
  });

  test('background-agent browser tools surface the refusal (no silent bypass)', async () => {
    setLocalBrowserDisabled(true);
    const { createBrowserTools } = await import('./builtin.ts');
    const { BrowserController } = await import('../browser/session.ts');
    const tools = createBrowserTools(new BrowserController(39996));
    const navigate = tools.find((t) => t.name === 'browser_navigate')!;
    const result = await navigate.execute({ url: 'https://example.com' });
    expect(result).toContain('browser.local: false');
  });

  test('browser tools return the sidecar guidance instead of launching locally', async () => {
    setLocalBrowserDisabled(true);
    // No sidecar is connected in tests, so auto-targeting finds none and the
    // tools hit the local path, which must refuse before touching Chrome.
    expect(await browserNavigateTool.execute({ url: 'https://example.com' })).toBe(
      LOCAL_BROWSER_DISABLED_MSG,
    );
    expect(await browserSnapshotTool.execute({})).toBe(LOCAL_BROWSER_DISABLED_MSG);
    expect(await browserClickTool.execute({ element_id: 1 })).toBe(LOCAL_BROWSER_DISABLED_MSG);
  });
});
