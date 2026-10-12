import { beforeEach, expect, test } from 'bun:test';
import { ConnectionSetup, type SetupPorts, type ConnectedPosition } from './setup';
import type { ConnectedWorkspaceSnapshot, ConnectedRow, ConnectionSetupAction } from '../../../../src/brief/connected-workspace-contracts';
const action: ConnectionSetupAction = { id: 'setup:mail', label: 'Mail', target: { kind: 'piece_credentials', pieceName: 'mail', pieceVersion: '1.0.0', authType: 'OAUTH2' }, verifies: { kind: 'workflow_connection', serviceId: 'mail' } };
const account = (id: string): ConnectedRow => ({ sourceId: id, serviceId: 'mail', accountId: id, kind: 'workflow_connection', label: 'Mail', authenticated: null, status: 'configured', evidence: 'saved_credentials', availability: 'unknown', pieceVersion: '1.0.0', setupActionId: action.id, permissions: { canInspect: true, canConnect: true, canRevoke: true } });
const position: ConnectedPosition = { search: 'mail', anchorId: 'account:a', scrollTop: 410 };
let data: ConnectedWorkspaceSnapshot, stored: Map<string,string>, opened: unknown[], ports: SetupPorts, now: number, controller: ConnectionSetup;
beforeEach(() => {
  data = { contractVersion: 1, scopeId: 'scope', asOf: 1, rows: [account('account:a'), account('account:b')], setup: [structuredClone(action)], sources: { accounts: 'ready', google: 'ready', channels: 'ready', devices: 'ready', pieces: 'ready' } };
  stored = new Map(); opened = []; now = 1000;
  ports = { storage: { getItem: k => stored.get(k) ?? null, setItem: (k,v) => { stored.set(k,v); } }, read: async () => structuredClone(data), open: (a, row) => { opened.push([a,row]); }, now: () => now, nonce: () => 'nonce-unique' };
  controller = new ConnectionSetup('scope', ports);
});
test('persists position before handing off only a currently supported setup path', async () => {
  ports.open = (a, row) => { expect(stored.size).toBe(1); opened.push([a,row]); };
  const a = await controller.begin(action.id, position, 'account:a');
  expect(a?.position).toEqual(position); expect(opened).toEqual([[action,'account:a']]);
  expect([...stored.values()][0]).not.toContain('authType'); // no setup descriptor or credential is persisted
  expect(await controller.begin('unsupported', position).catch(e => e.message)).toBe('Setup unavailable');
  expect(opened).toHaveLength(1);
});
test('cancel and reload preserve selection/search/scroll without reopening or claiming an account', async () => {
  await controller.begin(action.id, position, 'account:a');
  expect(controller.cancel()).toEqual(position);
  const restored = new ConnectionSetup('scope', ports);
  expect(restored.current()).toMatchObject({ phase: 'canceled', position });
  expect(restored.returned('nonce-unique')).toBeNull(); expect(await restored.verify('nonce-unique')).toBeNull();
  expect(opened).toHaveLength(1);
});
test('reload retains pending position but reads canonical state again before verification', async () => {
  await controller.begin(action.id, position, 'account:a');
  const restored = new ConnectionSetup('scope', ports);
  expect(restored.current()).toMatchObject({ phase: 'returned', position });
  data.rows[0]!.status = 'reconnect_required'; data.rows[0]!.authenticated = false;
  expect((await restored.verify('nonce-unique'))?.result).toBe('not_connected'); expect(opened).toHaveLength(1);
});
test('foreign, expired and replayed-after-cancel callbacks do not change source state', async () => {
  await controller.begin(action.id, position, 'account:a');
  expect(controller.returned('wrong-state')).toBeNull(); expect(await controller.verify('wrong-state')).toBeNull();
  now += 600_000;
  expect(controller.returned('nonce-unique')).toBeNull(); expect(await controller.verify('nonce-unique')).toBeNull();
  expect(controller.current()).toMatchObject({ phase: 'expired', position });
});
test('callback is only a return signal; manual credentials are configured, never falsely authenticated', async () => {
  await controller.begin(action.id, position, 'account:a');
  expect(controller.returned('nonce-unique')).toEqual(position);
  expect((await controller.verify('nonce-unique'))?.result).toBe('configured');
  expect(await controller.verify('nonce-unique', 'account:b')).toBeNull();
  data.rows = [account('account:b')]; expect(await controller.verify('nonce-unique')).toBeNull();
});
test('new account must be selected by canonical identity and belong to the requested service/kind', async () => {
  await controller.begin(action.id, position);
  expect(await controller.verify('nonce-unique')).toBeNull();
  data.rows.push({ ...account('library'), kind: 'library_piece', status: 'installed' });
  expect(await controller.verify('nonce-unique', 'library')).toBeNull();
  expect((await controller.verify('nonce-unique', 'account:b'))?.result).toBe('configured');
});
test('live connection observation can be verified but is not cached across return or reload', async () => {
  data.setup[0]!.verifies = { kind: 'channel', serviceId: 'mail' }; data.rows[0]!.kind = 'channel';
  await controller.begin(action.id, position, 'account:a');
  data.rows[0]!.status = 'connected'; data.rows[0]!.authenticated = true;
  expect((await controller.verify('nonce-unique'))?.result).toBe('connected');
  data.rows[0]!.status = 'disconnected'; data.rows[0]!.authenticated = false;
  expect((await new ConnectionSetup('scope', ports).verify('nonce-unique'))?.result).toBe('not_connected');
});
test('storage failure and foreign scope prevent launching; corrupted storage cannot supply a redirect', async () => {
  ports.storage.setItem = () => { throw Error('blocked'); };
  await expect(controller.begin(action.id, position)).rejects.toThrow(); expect(opened).toHaveLength(0);
  data.scopeId = 'foreign'; await expect(controller.begin(action.id, position)).rejects.toThrow('unavailable');
  stored.set('jarvis:brief:connection-setup:v1:scope', '{');
  expect(new ConnectionSetup('scope', ports).current()).toBeNull();
});
test('cancel during a pending source read prevents later launch or verification results', async () => {
  let resolve!: (s: ConnectedWorkspaceSnapshot) => void;
  ports.read = () => new Promise(r => { resolve = r; });
  const begin = controller.begin(action.id, position); controller.cancel(); resolve(data);
  expect(await begin).toBeNull(); expect(opened).toHaveLength(0);
  ports.read = async () => data; await controller.begin(action.id, position, 'account:a');
  ports.read = () => new Promise(r => { resolve = r; });
  const verify = controller.verify('nonce-unique'); controller.cancel(); resolve(data);
  expect(await verify).toBeNull();
});

test('plain HTTP browser without randomUUID still persists a random setup identity and opens', async () => {
  const old = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    delete ports.nonce;
    const attempt = await controller.begin(action.id, position);
    expect(attempt?.nonce).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(opened).toHaveLength(1);
  } finally { if (old) Object.defineProperty(crypto, 'randomUUID', old); else delete (crypto as any).randomUUID; }
});
