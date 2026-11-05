import { afterAll, afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

// A self-hosted daemon: every hosted provider reports no connect link (#1246).
const selfHosted = { configured: false, connected: false, connect_url: null };
async function panel(statuses: Record<string, unknown>, check: (host: HTMLElement) => Promise<void> | void, gate?: () => Promise<void>) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { ConnectionsPanel } = await import('./ConnectionsPanel');
  globalThis.fetch = (async (url: string) => {
    if (url === '/api/workflows/connections') return NativeResponse.json({ connections: [], jarvisSources: Object.keys(statuses).map(id => ({ id })) });
    const id = url === '/api/auth/google/status' ? 'google' : url.split('/').at(-1)!;
    await gate?.();
    const status = statuses[id];
    return status === 'error' ? new NativeResponse('', { status: 500 }) : NativeResponse.json(status);
  }) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(<ConnectionsPanel />));
    for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    await check(host);
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
const rows = (host: HTMLElement) => [...host.querySelectorAll('.wf-conn__managed-row')].map(r => r.getAttribute('aria-label'));

test('self-hosted providers with no setup path collapse into one line instead of a row each', async () => {
  await panel({
    google: { configured: false, is_authenticated: false },
    slack: selfHosted, figma: selfHosted, trello: selfHosted,
    clickup: { ...selfHosted, connected: true, account: { label: 'Team' } },
    github: { ...selfHosted, reconnect: true },
  }, host => {
    expect(host.textContent).not.toContain('Setup unavailable');
    expect(rows(host)).toEqual(['Google connection', 'ClickUp connection', 'GitHub connection']);
    expect(host.textContent).toContain('One-click setup is not available on this instance for Slack, Figma, Trello.');
    expect(host.textContent).toContain('Reconnect required');
    expect(host.textContent).toContain('Connect your apps securely');
  });
});

test('a failed status check stays a visible row, and a hosted provider keeps its connect link', async () => {
  await panel({
    slack: 'error',
    notion: { configured: true, connected: false, connect_url: 'https://app.usejarvis.dev/account?integration=notion' },
  }, host => {
    expect(rows(host)).toEqual(['Slack connection', 'Notion connection']);
    expect(host.textContent).toContain('Could not check connection');
    expect(host.textContent).toContain('Connect Notion');
    expect(host.textContent).not.toContain('One-click setup is not available on this instance for');
  });
});

test('a Google config the daemon refused stays a visible Setup unavailable row, not part of the note', async () => {
  await panel({ google: { configured: false, is_authenticated: false, reason: 'refresh_url set without instance_id' }, slack: selfHosted }, host => {
    expect(rows(host)).toEqual(['Google connection']);
    expect(host.textContent).toContain('Setup unavailable');
    expect(host.textContent).toContain('One-click setup is not available on this instance for Slack.');
  });
});

test('Refresh keeps collapsed providers collapsed while their statuses reload', async () => {
  const React = await import('react');
  let hold: Promise<void> | null = null, release = () => {};
  await panel({ slack: selfHosted, figma: selfHosted }, async host => {
    expect(rows(host)).toEqual([]);
    expect(host.textContent).not.toContain('Connect your apps securely');
    hold = new Promise(r => { release = r; });
    const refresh = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Refresh'))!;
    await React.act(async () => refresh.click());
    for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(rows(host)).toEqual([]);
    expect(host.textContent).not.toContain('Checking connection');
    expect(host.textContent).toContain('One-click setup is not available on this instance for Slack, Figma.');
    await React.act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
  }, () => hold ?? Promise.resolve());
});

test('first load shows one checking line, not a row per provider, until each status answers (#1260)', async () => {
  const React = await import('react');
  let release = () => {};
  const hold = new Promise<void>(r => { release = r; });
  await panel({
    slack: selfHosted, figma: selfHosted, trello: selfHosted,
    notion: { configured: true, connected: false, connect_url: 'https://app.usejarvis.dev/account?integration=notion' },
  }, async host => {
    expect(rows(host)).toEqual([]);
    expect(host.textContent).not.toContain('Checking connection…');
    const statuses = [...host.querySelectorAll('[role="status"]')].map(s => s.textContent);
    expect(statuses).toEqual(['Checking connections...']);
    const region = host.querySelector('[role="status"]');
    // A provider still waiting is neither a row nor named in the unavailable note.
    expect(host.textContent).not.toContain('One-click setup is not available on this instance for');
    expect(host.textContent).not.toContain('Connect your apps securely');
    await React.act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
    for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(rows(host)).toEqual(['Notion connection']);
    expect(host.textContent).not.toContain('Checking connections');
    // The same live region stays in place and is emptied, not removed.
    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).toBe('');
    expect(host.textContent).toContain('One-click setup is not available on this instance for Slack, Figma, Trello.');
    expect(host.textContent).toContain('Connect your apps securely');
  }, () => hold);
});

test('a provider whose first check fails shows its error row while others still wait (#1260)', async () => {
  const React = await import('react');
  let release = () => {};
  const hold = new Promise<void>(r => { release = r; });
  let calls = 0;
  await panel({ slack: 'error', figma: selfHosted }, async host => {
    expect(rows(host)).toEqual(['Slack connection']);
    expect(host.textContent).toContain('Could not check connection');
    expect(host.textContent).toContain('Checking connections...');
    await React.act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
    for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(rows(host)).toEqual(['Slack connection']);
    expect(host.textContent).not.toContain('Checking connections');
    expect(host.textContent).toContain('One-click setup is not available on this instance for Figma.');
  }, () => (++calls === 1 ? Promise.resolve() : hold));
});

test('the first load never shows the connect subtitle before a provider has answered, not even for a frame (#1260)', async () => {
  const React = await import('react');
  let release = () => {};
  const hold = new Promise<void>(r => { release = r; });
  const added: string[] = [];
  // Records are read after the fact: a node added and then removed again is
  // found among the removed ones, which keep their text once detached.
  const observer = new MutationObserver(records => { for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) added.push(n.textContent ?? ''); });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    await panel({ slack: selfHosted, figma: selfHosted }, async host => {
      await React.act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
      for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(host.textContent).toContain('One-click setup is not available on this instance for Slack, Figma.');
    }, () => hold);
  } finally { observer.disconnect(); }
  expect(added.join('|')).not.toContain('Connect your apps securely');
});
