import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

async function mount(element: (React: typeof import('react'), Guide: typeof import('./ConnectionsPanel').OAuthSetupGuide) => import('react').ReactElement, check: (host: HTMLElement) => Promise<void>) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { OAuthSetupGuide } = await import('./ConnectionsPanel');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(element(React, OAuthSetupGuide)));
    await check(host);
  } finally { await React.act(async () => root.unmount()); host.remove(); }
}
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label);
const click = async (el: Element | undefined) => { const React = await import('react'); await React.act(async () => (el as HTMLButtonElement).click()); };

test('Sheets setup explains the exact sign-in limitation before offering administrator credentials', async () => {
  let opened = false, integrations = false;
  await mount((_, Guide) => <Guide pieceName="@activepieces/piece-google-sheets" onAdministratorSetup={() => { opened = true; }} onOpenIntegrations={() => { integrations = true; }} />, async host => {
    expect(host.textContent).toContain('cannot authorize writing to Google Sheets');
    expect(host.textContent).toContain('keep your workflow as a draft');
    expect(host.querySelector('textarea,input')).toBeNull();
    // Settings Google is read-only on hosted and self-hosted alike, so it is not offered for Sheets writes.
    expect(button(host, 'Open Integrations')).toBeUndefined();
    expect(opened).toBe(false);
    await click(button(host, 'Administrator credential setup'));
    expect(opened).toBe(true); expect(integrations).toBe(false);
  });
});

test('other OAuth connectors point to Settings integrations first and make no hosting claim', async () => {
  let opened = false, integrations = false;
  await mount((_, Guide) => <Guide pieceName="@activepieces/piece-slack" onAdministratorSetup={() => { opened = true; }} onOpenIntegrations={() => { integrations = true; }} />, async host => {
    // Hosted instances and managed connections (Slack, GitHub, Notion, ...) exist; the copy must hold for both.
    expect(host.textContent).not.toMatch(/self-hosted|hosted instance/i);
    expect(host.textContent).toContain('listed in Settings, under Integrations');
    expect(host.textContent).not.toContain('Google Sheets');
    await click(button(host, 'Open Integrations'));
    expect(integrations).toBe(true); expect(opened).toBe(false);
  });
});
