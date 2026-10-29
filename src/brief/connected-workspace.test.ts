import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ConnectedWorkspace, CONNECTED_LIMIT, type ConnectedWorkspaceSources } from './connected-workspace';
import { DEFAULT_IDS } from '../workflows/db';
import { PieceCatalog, type PieceCatalogEntry } from '../workflows/runtime/piece-catalog';
import { connectedGoogle } from './connected-workspace-runtime';
import type { JarvisConfig } from '../config/types';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

let db: Database, sources: ConnectedWorkspaceSources, provider: ConnectedWorkspace;
const piece = (name = '@fixture/mail', auth = true): PieceCatalogEntry => ({ name, version: '1.0.0', displayName: 'Mail', description: '', actions: {}, ...(auth ? { auth: { type: 'OAUTH2' as const } } : {}) });
function account(id: string, patch: Record<string, unknown> = {}) {
  const row = { id, display_name: 'Account '+id, piece_name: '@fixture/mail', piece_version: '1.0.0', status: 'ACTIVE', type: 'OAUTH2', project_id: DEFAULT_IDS.project, owner_id: null, value: 'enc2:DO-NOT-DECRYPT-SECRET', metadata: 'DO-NOT-READ-SECRET', ...patch };
  db.run(`INSERT INTO app_connection (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row) as any);
}
function row(id: string) { return provider.read().rows.find(r => r.sourceId === id)!; }
beforeEach(() => {
  db = new Database(':memory:');
  db.run('CREATE TABLE app_connection (id TEXT PRIMARY KEY, display_name TEXT, piece_name TEXT, piece_version TEXT, status TEXT, type TEXT, project_id TEXT, owner_id TEXT, value TEXT, metadata TEXT)');
  sources = { hosted: () => false, devices: () => [{ id: 'laptop', name: 'Laptop', connected: true, status: 'enrolled' }],
    google: () => ({ mode: 'self', authenticated: true, reconnect: false, canSetup: true }),
    channels: () => ({ telegram: { enabled: true, connected: true, authentication: 'verified' }, discord: { enabled: false, connected: false } }),
    pieces: () => new PieceCatalog([piece(), piece('@fixture/no-auth', false)]) };
  provider = new ConnectedWorkspace(db, sources, DEFAULT_IDS.project, DEFAULT_IDS.user, () => true);
});
afterEach(() => db.close());

test('distinct stable sources never merge same-service accounts or library authentication', () => {
  account('a'); account('b');
  const snapshot = provider.read();
  expect(new Set(snapshot.rows.map(r => r.sourceId)).size).toBe(snapshot.rows.length);
  expect(row('native:google')).toMatchObject({ status: 'connected', authenticated: true, accountId: null, evidence: 'stored_grant' });
  expect(row('account:a')).toMatchObject({ accountId: 'a', status: 'configured', authenticated: null, availability: 'unknown', evidence: 'saved_credentials' });
  expect(row('account:b').accountId).toBe('b');
  expect(row('piece:@fixture/mail')).toMatchObject({ kind: 'library_piece', status: 'installed', authenticated: null, accountId: null });
  expect(row('device:laptop')).toMatchObject({ status: 'connected', evidence: 'live_session' });
  expect(snapshot.setup.find(a => a.id === 'setup:piece:@fixture/mail')?.target.kind).toBe('piece_credentials');
  expect(snapshot.setup.some(a => a.id.endsWith('@fixture/no-auth'))).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  expect(JSON.stringify(snapshot)).not.toContain('enc2:');
});
test('scope and owner filters run before selecting any credential material', () => {
  account('a'); account('foreign', { project_id: 'elsewhere' }); account('foreign-owner', { owner_id: 'elsewhere' });
  expect(provider.read().rows.filter(r => r.kind === 'workflow_connection').map(r => r.accountId)).toEqual(['a']);
  const other = new ConnectedWorkspace(db, sources, 'elsewhere', 'owner', () => true).read();
  expect(other.rows.filter(r => r.kind === 'workflow_connection').map(r => r.accountId)).toEqual(['foreign']);
  expect(other.rows.some(r => ['device','channel','native_service'].includes(r.kind))).toBe(false);
  expect(other.setup).toEqual([]); // existing instance-only setup endpoints cannot act for a foreign project
});
test('token errors, deletion and device revocation update only their canonical row', () => {
  account('a'); account('b');
  db.run("UPDATE app_connection SET status='ERROR' WHERE id='a'");
  expect(row('account:a')).toMatchObject({ status: 'reconnect_required', authenticated: false });
  expect(row('account:b').status).toBe('configured');
  sources.google = () => ({ mode: 'self', authenticated: true, reconnect: true, canSetup: true });
  expect(row('native:google')).toMatchObject({ status: 'reconnect_required', authenticated: false });
  expect(row('channel:telegram').status).toBe('connected');
  sources.devices = () => []; db.run("DELETE FROM app_connection WHERE id='a'");
  expect(row('device:laptop')).toBeUndefined(); expect(row('account:a')).toBeUndefined(); expect(row('account:b')).toBeDefined();
});
test('source failure is explicit and never erases available sources or fabricates setup support', () => {
  account('a'); sources.devices = () => { throw Error('provider-secret'); }; sources.google = undefined; sources.pieces = () => null;
  const snapshot = provider.read();
  expect(snapshot.sources).toMatchObject({ devices: 'unavailable', google: 'unavailable', pieces: 'unavailable', accounts: 'ready' });
  expect(snapshot.rows.find(r => r.sourceId === 'native:google')?.status).toBe('unavailable');
  expect(snapshot.setup.map(a => a.id)).toEqual(['setup:discord','setup:telegram']);
  expect(JSON.stringify(snapshot)).not.toContain('provider-secret');
});
test('installed pieces must declare known auth and a version before offering manual setup', () => {
  sources.pieces = () => new PieceCatalog([piece('@fixture/valid'), { ...piece('@fixture/unversioned'), version: undefined }, { ...piece('@fixture/bad'), auth: { type: 'UNSUPPORTED' as any } }]);
  expect(provider.read().setup.filter(a => a.target.kind === 'piece_credentials').map(a => a.id)).toEqual(['setup:piece:@fixture/valid']);
  sources.pieces = () => new PieceCatalog([]); account('a');
  expect(row('account:a').availability).toBe('unavailable'); expect(row('account:a').permissions.canConnect).toBe(false);
});
test('hosted device setup uses sign-in; Google missing setup link cannot offer browser OAuth', () => {
  sources.hosted = () => true;
  sources.google = () => ({ mode: 'managed', authenticated: false, reconnect: false, canSetup: false });
  expect(provider.read().setup.find(a => a.id === 'setup:device')?.target).toEqual({ kind: 'device', flow: 'hosted_sign_in' });
  expect(row('native:google').permissions.canConnect).toBe(false);
});
test('capacity refuses an incomplete account source instead of silently truncating a ready list', () => {
  db.transaction(() => { for (let i=0;i<=CONNECTED_LIMIT;i++) account('a'+i); })();
  const snapshot = provider.read(); expect(snapshot.sources.accounts).toBe('unavailable');
  expect(snapshot.rows.filter(r => r.kind === 'workflow_connection')).toEqual([]);
});
test('disabled provider cannot read; labels are bounded plain text and arbitrary metadata is absent', () => {
  expect(() => new ConnectedWorkspace(db, sources, undefined, undefined, () => false).read()).toThrow();
  account('a', { display_name: '<script>\u0000'+ 'a'.repeat(5000) });
  expect(row('account:a').label.length).toBeLessThanOrEqual(160); expect(row('account:a').label).not.toContain('<');
  expect(Object.keys(row('account:a'))).not.toContain('value');
});
test('current Google grant and persisted revocation are read without refreshing or disclosing tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f22-google-')), path = join(dir, 'tokens.json');
  const config = { google: { client_id: 'fixture', client_secret: 'secret' }, daemon: { listen: '127.0.0.1:3142' } } as JarvisConfig;
  try {
    writeFileSync(path, JSON.stringify({ refresh_token: 'fixture-refresh', access_token: 'fixture-access', expiry_date: 1 }));
    expect(connectedGoogle(config, path)).toMatchObject({ mode: 'self', authenticated: true, reconnect: false });
    writeFileSync(path + '.reconnect', JSON.stringify({ tokenHash: createHash('sha256').update('fixture-refresh').digest('hex'), message: 'Secret provider message' }));
    expect(connectedGoogle(config, path)).toMatchObject({ authenticated: false, reconnect: true });
    writeFileSync(path, JSON.stringify({ refresh_token: 'new-grant', access_token: 'new-access' }));
    expect(connectedGoogle(config, path).authenticated).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('managed Google classification never falls back to client credentials or unsafe setup links', () => {
  const config = { google: { refresh_url: 'https://hosting/refresh', client_id: 'x', client_secret: 'secret' } } as JarvisConfig;
  expect(connectedGoogle(config)).toMatchObject({ mode: 'unavailable', canSetup: false });
  config.google = { ...config.google, instance_id: 'fixture', refresh_secret: 'secret', connect_url: 'javascript:alert(1)' };
  const dir = mkdtempSync(join(tmpdir(), 'f22-managed-'));
  try {
    expect(connectedGoogle(config, join(dir, 'absent'))).toMatchObject({ mode: 'managed', authenticated: false, canSetup: false });
    config.google.connect_url = 'https://hosting.test/connect';
    expect(connectedGoogle(config, join(dir, 'absent')).canSetup).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('valid version build metadata cannot hide accounts or loaded setup paths', () => {
  sources.pieces = () => new PieceCatalog([{ ...piece(), version: '1.2.3-beta.1+build.7' }]);
  account('versioned', { piece_version: '1.2.3+build.1' }); account('other');
  const snapshot = provider.read();
  expect(snapshot.sources.accounts).toBe('ready'); expect(snapshot.sources.pieces).toBe('ready');
  expect(row('account:versioned').pieceVersion).toBe('1.2.3+build.1'); expect(row('account:other')).toBeDefined();
  expect(snapshot.setup.find(a => a.target.kind === 'piece_credentials')?.target).toMatchObject({ pieceVersion: '1.2.3-beta.1+build.7' });
});
test('legacy channel activity flags remain unknown without an authentication-aware signal', () => {
  sources.channels = () => ({ telegram: { enabled: true, connected: true }, discord: { enabled: true, connected: true, authentication: 'verified' } });
  expect(row('channel:telegram')).toMatchObject({ status: 'unknown', authenticated: null, evidence: 'none', availability: 'unknown' });
  expect(row('channel:discord').status).toBe('connected');
});
test('real Telegram 401 observation overrides its still-active polling flag and updates only Telegram', async () => {
  const { TelegramAdapter } = await import('../comms/channels/telegram');
  const originalFetch = globalThis.fetch;
  const adapter = new TelegramAdapter('fixture-token');
  // No background loop: exercise the actual getMe/getUpdates handlers deterministically.
  (adapter as any).startPolling = async () => {};
  try {
    globalThis.fetch = (async () => Response.json({ ok: true, result: { username: 'fixture' } })) as unknown as typeof fetch;
    await adapter.connect();
    sources.channels = () => ({ telegram: { enabled: true, connected: adapter.isConnected(), authentication: adapter.authenticationState() }, discord: { enabled: true, connected: true, authentication: 'verified' } });
    expect(row('channel:telegram')).toMatchObject({ status: 'connected', evidence: 'provider_status' });
    globalThis.fetch = (async () => Response.json({ ok: false, error_code: 401 }, { status: 401 })) as unknown as typeof fetch;
    await expect((adapter as any).getUpdates()).rejects.toThrow();
    expect(adapter.isConnected()).toBe(true);
    expect(row('channel:telegram')).toMatchObject({ status: 'reconnect_required', authenticated: false, availability: 'unavailable' });
    expect(row('channel:discord').status).toBe('connected');
    // A success from an older in-flight operation cannot undo a known rejection.
    globalThis.fetch = (async () => Response.json({ ok: true, result: [] })) as unknown as typeof fetch;
    await (adapter as any).getUpdates(); expect(adapter.authenticationState()).toBe('rejected');
  } finally { await adapter.disconnect(); globalThis.fetch = originalFetch; }
});


test('managed ClickUp shows its stored grant and routes setup without exposing credentials or other scopes', () => {
  sources.clickup = () => ({configured:true, connected:true, account:{id:'7',label:'owner@example.test'}});
  expect(row('native:clickup')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'7',setupActionId:'setup:clickup'});
  expect(provider.read().setup.find(s => s.id === 'setup:clickup')?.target).toEqual({kind:'hosted_integration',provider:'clickup'});
  sources.clickup = () => ({configured:true,connected:false,account:null});
  expect(row('native:clickup').status).toBe('disconnected');
  expect(new ConnectedWorkspace(db,sources,'other','other',()=>true).read().rows.some(r=>r.sourceId==='native:clickup')).toBe(false);
});

test('managed Asana shows its stored grant and routes setup to its own hosted integration', () => {
  sources.asana = () => ({configured:true, connected:true, account:{id:'8',label:'owner@example.test'}});
  expect(row('native:asana')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'8',setupActionId:'setup:asana'});
  expect(provider.read().setup.find(s => s.id === 'setup:asana')?.target).toEqual({kind:'hosted_integration',provider:'asana'});
  sources.asana = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:asana')).toBe(false);
});

test('managed Figma shows its stored grant and routes setup to its own hosted integration', () => {
  sources.figma = () => ({configured:true, connected:true, account:{id:'8',label:'owner@example.test'}});
  expect(row('native:figma')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'8',setupActionId:'setup:figma'});
  expect(provider.read().setup.find(s => s.id === 'setup:figma')?.target).toEqual({kind:'hosted_integration',provider:'figma'});
  sources.figma = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:figma')).toBe(false);
});
