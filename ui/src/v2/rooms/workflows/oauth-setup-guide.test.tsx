import { afterAll, afterEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

async function mount(render: (mod: typeof import('./ConnectionsPanel')) => import('react').ReactElement, check: (host: HTMLElement) => Promise<void>) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const mod = await import('./ConnectionsPanel');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(render(mod)));
    await check(host);
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(label));
const click = async (el: Element | undefined) => { const React = await import('react'); await React.act(async () => (el as HTMLButtonElement).click()); };
const guide = (pieceName: string, calls: string[]) => ({ OAuthSetupGuide }: typeof import('./ConnectionsPanel')) =>
  <OAuthSetupGuide pieceName={pieceName} onAdministratorSetup={() => calls.push('admin')} onOpenIntegrations={() => calls.push('integrations')} />;

test('Sheets setup explains the exact sign-in limitation before offering administrator credentials', async () => {
  const calls: string[] = [];
  await mount(guide('@activepieces/piece-google-sheets', calls), async host => {
    expect(host.textContent).toContain('cannot authorize writing to Google Sheets');
    expect(host.textContent).toContain('Keep your workflow as a draft');
    expect(host.querySelector('textarea,input')).toBeNull();
    // Settings Google is read-only on hosted and self-hosted alike, so it is not offered for Sheets writes.
    expect(button(host, 'Open Integrations')).toBeUndefined();
    await click(button(host, 'Administrator credential setup'));
    expect(calls).toEqual(['admin']);
  });
});

test('Gmail and Calendar point to the read-only Google connection in Settings integrations', async () => {
  for (const piece of ['@activepieces/piece-gmail', '@activepieces/piece-google-calendar']) {
    const calls: string[] = [];
    await mount(guide(piece, calls), async host => {
      expect(host.textContent).toContain('Connect Google in Settings, under Integrations');
      expect(host.textContent).toContain('read-only Gmail and Calendar');
      await click(button(host, 'Open Integrations'));
      expect(calls).toEqual(['integrations']);
    });
  }
});

test('an unmapped OAuth connector makes no hosting or Settings claim and offers only administrator setup', async () => {
  const calls: string[] = [];
  await mount(guide('@activepieces/piece-hubspot', calls), async host => {
    expect(host.textContent).not.toMatch(/self-hosted|hosted instance|Settings/i);
    expect(host.textContent).toContain('no browser sign-in in Jarvis');
    expect(button(host, 'Open Integrations')).toBeUndefined();
    await click(button(host, 'Administrator credential setup'));
    expect(calls).toEqual(['admin']);
  });
});

async function panelFor(pieceName: string, check: (host: HTMLElement) => Promise<void>) {
  const { requestPieceSetup } = await import('./connection-setup-request');
  globalThis.fetch = (async (url: string) => NativeResponse.json(url === '/api/workflows/connections'
    ? { connections: [], jarvisSources: [] }
    : { configured: true, connected: false, connect_url: 'https://app.usejarvis.dev/account?integration=slack' })) as typeof fetch;
  requestPieceSetup({ kind: 'piece_credentials', pieceName, pieceVersion: '1.0.0', authType: 'OAUTH2', rowId: null });
  await mount(({ ConnectionsPanel }) => <ConnectionsPanel />, check);
}

test('a hosted provider piece keeps the managed connection row, not the guide', async () => {
  await panelFor('@activepieces/piece-slack', async host => {
    expect(host.textContent).toContain('Connect Slack');
    expect(host.querySelector('#oauth-setup-heading')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();
  });
});

test('an unmapped OAuth piece shows the guide first, then the manual form on administrator setup', async () => {
  await panelFor('@activepieces/piece-hubspot', async host => {
    expect(host.querySelector('#oauth-setup-heading')).not.toBeNull();
    expect(host.querySelector('textarea')).toBeNull();
    await click(button(host, 'Administrator credential setup'));
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.textContent).toContain('Saving credentials does not verify account access');
  });
});
