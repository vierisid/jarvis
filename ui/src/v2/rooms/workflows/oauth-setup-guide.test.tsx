import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
test('Sheets setup explains the exact sign-in limitation before offering administrator credentials', async () => {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { OAuthSetupGuide } = await import('./ConnectionsPanel');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let opened = false;
  try {
    await React.act(async () => root.render(<OAuthSetupGuide pieceName="@activepieces/piece-google-sheets" onAdministratorSetup={() => { opened = true; }} />));
    expect(host.textContent).toContain('cannot authorize writing to Google Sheets');
    expect(host.textContent).toContain('Keep your workflow as a draft');
    expect(host.querySelector('textarea,input')).toBeNull();
    expect(opened).toBe(false);
    await React.act(async () => host.querySelector('button')!.click());
    expect(opened).toBe(true);
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
