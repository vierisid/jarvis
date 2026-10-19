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
