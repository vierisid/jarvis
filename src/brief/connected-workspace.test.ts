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
test('the engine test fixture pieces are not offered as connectable library pieces', () => {
  sources.pieces = () => new PieceCatalog([piece(), piece('@jarvispieces/piece-jarvis-validate'), piece('@jarvispieces/piece-jarvis-test', false)]);
  const snapshot = provider.read();
  expect(snapshot.rows.filter(r => r.kind === 'library_piece').map(r => r.sourceId)).toEqual(['piece:@fixture/mail']);
  expect(snapshot.setup.some(a => a.id.includes('piece-jarvis-'))).toBe(false);
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

test('managed Notion shows its stored grant, a renewal that needs reconnect, and routes setup to its own hosted integration', () => {
  sources.notion = () => ({configured:true, connected:true, reconnect:false, account:{id:'9',label:'Workspace'}});
  expect(row('native:notion')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'9',label:'Notion: Workspace',setupActionId:'setup:notion'});
  expect(provider.read().setup.find(s => s.id === 'setup:notion')?.target).toEqual({kind:'hosted_integration',provider:'notion'});
  sources.notion = () => ({configured:true, connected:false, reconnect:true, account:{id:'9',label:'Workspace'}});
  expect(row('native:notion')).toMatchObject({status:'reconnect_required',authenticated:false,availability:'unavailable',evidence:'none'});
  sources.notion = () => ({configured:false,connected:false,reconnect:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:notion')).toBe(false);
});

test('a hosted provider whose setup is broken stays visible as unavailable, without a setup action (#1259)', () => {
  sources.notion = () => ({configured:false,connected:false,reconnect:false,account:null,reason:'One-click setup is broken on this hosted instance'});
  expect(row('native:notion')).toMatchObject({status:'unavailable',authenticated:null,setupActionId:null});
  expect(provider.read().setup.some(s => s.id === 'setup:notion')).toBe(false);
});

test('managed Airtable shows its stored grant, reads a reconnect as disconnected and routes setup to its own hosted integration', () => {
  sources.airtable = () => ({configured:true, connected:true, account:{id:'usr1',label:'owner@example.test'}});
  expect(row('native:airtable')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'usr1',setupActionId:'setup:airtable'});
  expect(provider.read().setup.find(s => s.id === 'setup:airtable')?.target).toEqual({kind:'hosted_integration',provider:'airtable'});
  sources.airtable = () => ({configured:true, connected:false, account:{id:'usr1',label:'owner@example.test'}});
  expect(row('native:airtable')).toMatchObject({status:'disconnected',availability:'unavailable',evidence:'none'});
  sources.airtable = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:airtable')).toBe(false);
});

test('managed Calendly shows its stored grant and routes setup to its own hosted integration', () => {
  sources.calendly = () => ({configured:true, connected:true, account:{id:'cal-1',label:'owner@example.test'}});
  expect(row('native:calendly')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'cal-1',setupActionId:'setup:calendly'});
  expect(provider.read().setup.find(s => s.id === 'setup:calendly')?.target).toEqual({kind:'hosted_integration',provider:'calendly'});
  sources.calendly = () => ({configured:true,connected:false,account:null});
  expect(row('native:calendly').status).toBe('disconnected');
  sources.calendly = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:calendly')).toBe(false);
});

test('managed Asana shows its stored grant and routes setup to its own hosted integration', () => {
  sources.asana = () => ({configured:true, connected:true, account:{id:'8',label:'owner@example.test'}});
  expect(row('native:asana')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'8',setupActionId:'setup:asana'});
  expect(provider.read().setup.find(s => s.id === 'setup:asana')?.target).toEqual({kind:'hosted_integration',provider:'asana'});
  sources.asana = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:asana')).toBe(false);
});
test('managed Linear shows its stored grant and routes setup to its own hosted integration', () => {
  sources.linear = () => ({configured:true, connected:true, account:{id:'8',label:'owner@example.test'}});
  expect(row('native:linear')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'8',setupActionId:'setup:linear'});
  expect(provider.read().setup.find(s => s.id === 'setup:linear')?.target).toEqual({kind:'hosted_integration',provider:'linear'});
  sources.linear = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:linear')).toBe(false);
});

test('managed Typeform shows its stored grant, a reconnect as disconnected, and routes setup to its own hosted integration', () => {
  sources.typeform = () => ({configured:true, connected:true, account:{id:'01TF',label:'owner@example.test'}});
  expect(row('native:typeform')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'01TF',setupActionId:'setup:typeform'});
  expect(provider.read().setup.find(s => s.id === 'setup:typeform')?.target).toEqual({kind:'hosted_integration',provider:'typeform'});
  sources.typeform = () => ({configured:true, connected:false, account:{id:'01TF',label:'owner@example.test'}});
  expect(row('native:typeform')).toMatchObject({status:'disconnected',evidence:'none'});
  sources.typeform = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:typeform')).toBe(false);
});

test('managed Todoist shows its stored grant and routes setup to its own hosted integration', () => {
  sources.todoist = () => ({configured:true, connected:true, account:{id:'9',label:'owner@example.test'}});
  expect(row('native:todoist')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'9',setupActionId:'setup:todoist'});
  expect(provider.read().setup.find(s => s.id === 'setup:todoist')?.target).toEqual({kind:'hosted_integration',provider:'todoist'});
  sources.todoist = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:todoist')).toBe(false);
});

test('a Todoist grant that needs reconnecting reads as disconnected and still offers setup', () => {
  sources.todoist = () => ({configured:true, connected:false, account:{id:'9',label:'owner@example.test'}});
  expect(row('native:todoist')).toMatchObject({status:'disconnected',evidence:'none',setupActionId:'setup:todoist'});
});

test('managed Intercom shows its stored grant and routes setup to its own hosted integration', () => {
  sources.intercom = () => ({configured:true, connected:true, account:{id:'workspace:admin',label:'owner@example.test'}});
  expect(row('native:intercom')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'workspace:admin',setupActionId:'setup:intercom'});
  expect(provider.read().setup.find(s => s.id === 'setup:intercom')?.target).toEqual({kind:'hosted_integration',provider:'intercom'});
  sources.intercom = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:intercom')).toBe(false);
});

test('managed monday.com shows its stored grant, a pending reconnect as disconnected, and routes setup to its own hosted integration', () => {
  sources.monday = () => ({configured:true, connected:true, account:{id:'12:34',label:'owner@example.test'}});
  expect(row('native:monday')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'12:34',label:'monday.com: owner@example.test',setupActionId:'setup:monday'});
  expect(provider.read().setup.find(s => s.id === 'setup:monday')?.target).toEqual({kind:'hosted_integration',provider:'monday'});
  sources.monday = () => ({configured:true, connected:false, account:{id:'12:34',label:'owner@example.test'}});
  expect(row('native:monday')).toMatchObject({status:'disconnected',availability:'unavailable',evidence:'none'});
  sources.monday = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:monday')).toBe(false);
});

test('managed Figma shows its stored grant, a pending reconnect as disconnected, and routes setup to its own hosted integration', () => {
  sources.figma = () => ({configured:true, connected:true, account:{id:'1234567890',label:'owner@example.test'}});
  expect(row('native:figma')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'1234567890',setupActionId:'setup:figma'});
  expect(provider.read().setup.find(s => s.id === 'setup:figma')?.target).toEqual({kind:'hosted_integration',provider:'figma'});
  sources.figma = () => ({configured:true, connected:false, account:{id:'1234567890',label:'owner@example.test'}});
  expect(row('native:figma')).toMatchObject({status:'disconnected',evidence:'none'});
  sources.figma = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:figma')).toBe(false);
});

test('managed Webflow shows its stored grant, a revoked grant as disconnected, and routes setup to its own hosted integration', () => {
  sources.webflow = () => ({configured:true, connected:true, account:{id:'b'.repeat(24),label:'owner@example.test'}});
  expect(row('native:webflow')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'b'.repeat(24),setupActionId:'setup:webflow'});
  expect(provider.read().setup.find(s => s.id === 'setup:webflow')?.target).toEqual({kind:'hosted_integration',provider:'webflow'});
  sources.webflow = () => ({configured:true, connected:false, account:{id:'b'.repeat(24),label:'owner@example.test'}});
  expect(row('native:webflow')).toMatchObject({status:'disconnected',evidence:'none',setupActionId:'setup:webflow'});
  sources.webflow = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:webflow')).toBe(false);
});

const oauthPieces = [
  ['clickup', 'ClickUp'], ['github', 'GitHub'], ['trello', 'Trello'], ['mailchimp', 'Mailchimp'],
  ['slack', 'Slack'], ['dropbox', 'Dropbox'], ['asana', 'Asana'], ['intercom', 'Intercom'],
  ['typeform', 'Typeform'], ['airtable', 'Airtable'], ['notion', 'Notion'], ['calendly', 'Calendly'],
  ['linear', 'Linear'], ['todoist', 'Todoist'], ['monday', 'monday.com'], ['figma', 'Figma'], ['webflow', 'Webflow'], ['pipedrive', 'Pipedrive'], ['zoom', 'Zoom'], ['help-scout', 'Help Scout'], ['gitlab', 'GitLab'],
] as const;
for (const [id] of oauthPieces) test(`${id} library setup uses the hosted connection, while saved manual accounts keep their own edit path`, () => {
  (sources as any)[id] = () => ({ configured: true, connected: false, reconnect: false, account: null });
  const name = `@activepieces/piece-${id}`;
  sources.pieces = () => new PieceCatalog([piece(name)]);
  account('manual', { piece_name: name });
  const snapshot = provider.read();
  const library = snapshot.rows.find(r => r.sourceId === `piece:${name}`)!;
  expect(snapshot.setup.find(a => a.id === library.setupActionId)?.target).toEqual({ kind: 'hosted_integration', provider: id });
  expect(library).toMatchObject({ status: 'installed', authenticated: null });
  const manual = snapshot.rows.find(r => r.sourceId === 'account:manual')!;
  expect(snapshot.setup.find(a => a.id === manual.setupActionId)).toMatchObject({ existingOnly: true, target: { kind: 'piece_credentials', pieceName: name } });
  expect(snapshot.setup.filter(a => !a.existingOnly && a.target.kind === 'piece_credentials')).toEqual([]);
});
// The Jarvis Google grant is read-only Gmail and Calendar, so it cannot replace a Drive, Sheets or send credential.
for (const name of ['gmail', 'google-calendar', 'google-drive', 'google-sheets']) test(`${name} library keeps its own credential setup while Google is set up`, () => {
  sources.pieces = () => new PieceCatalog([piece(`@activepieces/piece-${name}`)]);
  const snapshot = provider.read(), library = snapshot.rows.find(r => r.kind === 'library_piece')!;
  expect(snapshot.setup.some(a => a.id === 'setup:google')).toBe(true);
  expect(snapshot.setup.find(a => a.id === library.setupActionId)?.target).toMatchObject({ kind: 'piece_credentials', pieceName: `@activepieces/piece-${name}` });
});
test('an unavailable hosted provider never falls back to manual token setup', () => {
  sources.hosted = () => true;
  sources.clickup = () => { throw new Error('secret'); };
  sources.pieces = () => new PieceCatalog([piece('@activepieces/piece-clickup')]);
  expect(row('piece:@activepieces/piece-clickup').permissions.canConnect).toBe(false);
  expect(provider.read().setup.some(a => a.target.kind === 'piece_credentials')).toBe(false);
});
test('self-hosted apps without managed configuration retain manual setup', () => {
  sources.clickup = () => ({ configured: false, connected: false, account: null });
  sources.pieces = () => new PieceCatalog([piece('@activepieces/piece-clickup')]);
  expect(provider.read().setup.find(a => a.id === row('piece:@activepieces/piece-clickup').setupActionId)?.target.kind).toBe('piece_credentials');
});

test('managed Wrike shows its stored grant, a pending reconnect as disconnected, and routes setup to its own hosted integration', () => {
  sources.wrike = () => ({configured:true, connected:true, account:{id:'KUAAAAAA',label:'owner@example.test'}});
  expect(row('native:wrike')).toMatchObject({status:'connected',evidence:'stored_grant',accountId:'KUAAAAAA',label:'Wrike: owner@example.test',setupActionId:'setup:wrike'});
  expect(provider.read().setup.find(s => s.id === 'setup:wrike')?.target).toEqual({kind:'hosted_integration',provider:'wrike'});
  sources.wrike = () => ({configured:true, connected:false, account:{id:'KUAAAAAA',label:'owner@example.test'}});
  expect(row('native:wrike')).toMatchObject({status:'disconnected',availability:'unavailable',evidence:'none'});
  sources.wrike = () => ({configured:false,connected:false,account:null});
  expect(provider.read().rows.some(r=>r.sourceId==='native:wrike')).toBe(false);
});
