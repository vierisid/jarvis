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
    expect(launchChrome(9222)).rejects.toThrow(/browser\.local: false/);
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
