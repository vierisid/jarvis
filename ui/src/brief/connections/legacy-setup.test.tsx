import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ConnectionSetupAction } from '../../../../src/brief/connected-workspace-contracts';
const NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let WorkflowsRoomBody: typeof import('../../v2/rooms/workflows/WorkflowsRoom').WorkflowsRoomBody;
let ConnectionsPanel: typeof import('../../v2/rooms/workflows/ConnectionsPanel').ConnectionsPanel;
let open: typeof import('./legacy-setup').openLegacyConnectionSetup;
let takeSettings: typeof import('../../v2/shell/settings-tab-request').takeRequestedSettingsTab;
let takePiece: typeof import('../../v2/rooms/workflows/connection-setup-request').takePieceSetup;
let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement;
beforeAll(async () => {
  ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client'));
  ({ WorkflowsRoomBody } = await import('../../v2/rooms/workflows/WorkflowsRoom'));
  ({ ConnectionsPanel } = await import('../../v2/rooms/workflows/ConnectionsPanel'));
  ({ openLegacyConnectionSetup: open } = await import('./legacy-setup'));
  ({ takeRequestedSettingsTab: takeSettings } = await import('../../v2/shell/settings-tab-request'));
  ({ takePieceSetup: takePiece } = await import('../../v2/rooms/workflows/connection-setup-request'));
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); globalThis.fetch = originalFetch; window.history.replaceState(null, '', '/'); window.location.hash = ''; takeSettings(); takePiece(); });
afterAll(() => GlobalRegistrator.unregister());
const action = (target: ConnectionSetupAction['target']): ConnectionSetupAction => ({ id: 'fixture', label: 'Fixture', target, verifies: { kind: 'workflow_connection', serviceId: 'fixture' } });
const piece = action({ kind: 'piece_credentials', pieceName: '@fixture/mail', pieceVersion: '1.2.3', authType: 'SECRET_TEXT' });
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => { root!.render(<ConnectionsPanel />); }); }
const inputs = () => Array.from(host.querySelectorAll('input')).map(i => i.value);
function serve(connections: unknown[] = []) {
  const writes: unknown[] = [];
  globalThis.fetch = (async (_: unknown, init?: RequestInit) => { if (init?.method) writes.push(init); return NativeResponse.json({ connections, jarvisSources: [] }); }) as typeof fetch;
  return writes;
}
test('Google, channels and enrollment navigate to the existing settings setup tabs with no OAuth or enrollment writes', () => {
  for (const [target, tab] of [[{ kind: 'google', flow: 'oauth' }, 'integrations'], [{ kind: 'google', flow: 'hosted_browser' }, 'integrations'], [{ kind: 'channel', channel: 'telegram' }, 'channels'], [{ kind: 'device', flow: 'hosted_sign_in' }, 'sidecar']] as const) {
    open(action(target), null); expect(window.location.hash).toBe('#/_room_settings'); expect(takeSettings()).toBe(tab);
  }
});
test('piece handoff opens the canonical manual form with exact piece/version/type and no saved secrets', async () => {
  const writes = serve(); open(piece, null); expect(window.location.hash).toBe('#/_room_workflows'); await mount();
  expect(inputs()).toEqual(['','', '@fixture/mail','1.2.3']); expect(host.querySelector('select')?.value).toBe('SECRET_TEXT');
  expect(writes).toEqual([]);
  await act(async () => open(action({ kind: 'piece_credentials', pieceName: '@fixture/next', pieceVersion: '2.0.0', authType: 'BASIC_AUTH' }), null));
  expect(inputs()).toEqual(['','', '@fixture/next','2.0.0']); expect(host.querySelector('select')?.value).toBe('BASIC_AUTH');
});
test('existing account handoff edits only that identity and repeated handoff reopens after cancellation', async () => {
  const meta = (id: string) => ({ id, externalId: id, displayName: id, type: 'SECRET_TEXT', status: 'ACTIVE', pieceName: '@fixture/mail', pieceVersion: '1.2.3', updated: 1 });
  const writes = serve([meta('a'), meta('b')]); open(piece, 'account:b'); await mount();
  expect(inputs()).toEqual(['b']); expect(writes).toEqual([]);
  await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Cancel')!.click(); });
  expect(inputs()).toEqual([]);
  await act(async () => open(piece, 'account:b'));
  expect(inputs()).toEqual(['b']); expect(writes).toEqual([]);
});

test('workflows room handoff opens Connections even when an old workflow query would open the editor', async () => {
  globalThis.fetch = (async (url: string) => NativeResponse.json(url === '/api/workflows/connections' ? { connections: [], jarvisSources: [] } : url === '/api/workflows/triggers' ? { triggers: [] } : [])) as typeof fetch;
  window.history.replaceState(null, '', '/?workflow=old-flow');
  open(piece, null);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<WorkflowsRoomBody />); });
  expect(inputs()).toEqual(['','', '@fixture/mail','1.2.3']);
  expect(host.querySelector('.wf-editor')).toBeNull();
});

test('piece handoff works on a plain HTTP LAN browser without randomUUID', () => {
  const old = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try { open(piece, null); expect(takePiece()?.requestId).toMatch(/^[a-f0-9-]{36}$/); }
  finally { if (old) Object.defineProperty(crypto, 'randomUUID', old); else delete (crypto as any).randomUUID; }
});

const oauthProviders = ['clickup','slack','trello','mailchimp','github','dropbox','asana','intercom','typeform','airtable','notion','calendly','linear','todoist','monday'] as const;
function serveOAuth(id: string, status: Record<string, unknown> = {}) {
  const requests: string[] = [], writes: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push(url); if (init?.method && init.method !== 'GET') writes.push(url);
    return NativeResponse.json(url === '/api/workflows/connections' ? { connections: [], jarvisSources: [{ id }] } : {
      configured: true, connected: false, connect_url: `https://app.usejarvis.dev/account?integration=${id}`, ...status,
    });
  }) as typeof fetch;
  return { requests, writes };
}
for (const id of oauthProviders) test(`${id}: library OAuth setup opens Connect without a token form or writes`, async () => {
  const { writes, requests } = serveOAuth(id);
  open(action({ kind: 'hosted_integration', provider: id }), null);
  expect(window.location.hash).toBe('#/_room_workflows');
  await mount();
  expect(host.querySelector('textarea')).toBeNull();
  expect(host.querySelector('a')?.href).toBe(`https://app.usejarvis.dev/account?integration=${id}`);
  expect(host.querySelector('a')?.textContent).toContain('Connect');
  expect(host.textContent).toContain('Not connected');
  expect(host.textContent).not.toContain('Reusable Jarvis credentials');
  expect(requests).toContain(`/api/integrations/${id}`);
  expect(writes).toEqual([]);
});
test('an older ClickUp piece handoff also avoids the manual token form', async () => {
  serveOAuth('clickup');
  open(action({ kind: 'piece_credentials', pieceName: '@activepieces/piece-clickup', pieceVersion: '0.9.1', authType: 'OAUTH2' }), null);
  await mount(); expect(host.querySelector('textarea')).toBeNull(); expect(host.textContent).toContain('Connect ClickUp');
});
test('registered is not connected; a delivered grant, reconnect and failed check update the real status', async () => {
  let body: Record<string, unknown> = { configured: true, connected: false, connect_url: 'https://app.usejarvis.dev/account?integration=clickup' };
  let fail = false;
  globalThis.fetch = (async (url: string) => url === '/api/workflows/connections'
    ? NativeResponse.json({ connections: [], jarvisSources: [{ id: 'clickup' }, { id: 'unknown-source' }] })
    : fail ? new NativeResponse('unavailable', { status: 503 }) : NativeResponse.json(body)) as typeof fetch;
  await mount(); expect(host.textContent).toContain('Not connected');
  expect(host.textContent).toContain('Registration does not confirm');
  body = { ...body, connected: true, account: { label: 'owner@example.test' } };
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(host.textContent).toContain('owner@example.test'); expect(host.textContent).toContain('Manage ClickUp');
  body = { ...body, reconnect: true };
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(host.textContent).toContain('Reconnect required'); expect(host.textContent).toContain('Reconnect ClickUp');
  fail = true;
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(host.textContent).toContain('Could not check connection'); expect(host.querySelector('a')).toBeNull();
  expect(host.querySelector('textarea')).toBeNull();
  fail = false; body = { ...body, reconnect: false };
  await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Try again')!.click(); });
  expect(host.textContent).toContain('Manage ClickUp');
});
test('Google uses its existing status and hosted account link', async () => {
  const { requests } = serveOAuth('google', { managed: true, is_authenticated: true });
  await mount(); expect(requests).toContain('/api/auth/google/status');
  expect(host.textContent).toContain('Manage Google'); expect(host.querySelector('textarea')).toBeNull();
});
test('unsafe setup links fail closed without credential fallback', async () => {
  serveOAuth('clickup', { connect_url: 'javascript:alert(1)' }); await mount();
  expect(host.querySelector('a')).toBeNull(); expect(host.textContent).toContain('Could not check connection');
});
test('existing manually configured ClickUp accounts still open their own credential editor', async () => {
  serve([{ id: 'manual', externalId: 'manual', displayName: 'Manual ClickUp', type: 'OAUTH2', status: 'ACTIVE', pieceName: '@activepieces/piece-clickup', pieceVersion: '0.9.1', updated: 1 }]);
  open(action({ kind: 'piece_credentials', pieceName: '@activepieces/piece-clickup', pieceVersion: '0.9.1', authType: 'OAUTH2' }), 'account:manual');
  await mount(); expect(host.querySelector('textarea')?.value).toBe(''); expect(inputs()).toEqual(['Manual ClickUp']);
});
test('self-hosted manual fallback is explicit and only offered after configuration is known unavailable', async () => {
  serveOAuth('clickup', { configured: false, connected: false, connect_url: null });
  open(action({ kind: 'piece_credentials', pieceName: '@activepieces/piece-clickup', pieceVersion: '0.9.1', authType: 'OAUTH2' }), null);
  await mount(); expect(host.querySelector('textarea')).toBeNull();
  await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Enter credentials manually')!.click(); });
  expect(host.querySelector('textarea')).not.toBeNull();
});
test('Google workflow pieces keep the manual credential form: the Google grant is read-only Gmail and Calendar', async () => {
  for (const name of ['gmail', 'google-sheets']) {
    serveOAuth('google', { managed: true, is_authenticated: true });
    open(action({ kind: 'piece_credentials', pieceName: `@activepieces/piece-${name}`, pieceVersion: '0.9.1', authType: 'OAUTH2' }), null);
    await mount();
    // No managed row: the setup guide states the read-only grant, then opens the manual form.
    expect(host.textContent).toContain('read-only Gmail and Calendar');
    expect(host.textContent).not.toContain('Enter credentials manually');
    await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Administrator credential setup'))!.click(); });
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('.wf-conn__form')?.textContent).not.toContain('Enter credentials manually');
    await act(async () => root!.unmount()); root = undefined; host.remove();
  }
});
