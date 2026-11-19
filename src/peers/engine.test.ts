import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineClient, EngineClosed, EngineRefused, ENGINE_PROTOCOL, readDialogFields } from './engine-client.ts';
import type { EngineDialog, EngineDialogAnswer, EngineTransport } from './engine-client.ts';
import { engineDataDir, engineEnv, startEngine } from './engine-process.ts';
import { EngineReadFailed, readEngine } from './engine-read.ts';
import { PeerEngine } from './engine.ts';
import type { EngineState } from './engine.ts';

const made: string[] = [];
afterAll(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); });

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'peers-engine-'));
  made.push(path);
  return path;
}

/** The stand-in as a program on disk, the way the real engine is one. */
function standIn(): string {
  const path = join(folder(), 'engine');
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'testing', 'stand-in-engine.ts')}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

async function until(done: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Both ends of a line, in memory: the test plays the engine. */
function line(): { transport: EngineTransport; sent: Record<string, unknown>[]; say(message: Record<string, unknown>): void; raw(text: string): void; end(): void } {
  const lines: ((line: string) => void)[] = [];
  const closes: (() => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    transport: {
      send(text) { sent.push(JSON.parse(text) as Record<string, unknown>); },
      onLine(listener) { lines.push(listener); },
      onClose(listener) { closes.push(listener); },
      close() { /* the test ends it */ },
    },
    say(message) { for (const listener of lines) listener(JSON.stringify(message)); },
    raw(text) { for (const listener of lines) listener(text); },
    end() { for (const listener of closes) listener(); },
  };
}

const CHOICE = { type: 'object', properties: { choice: { type: 'string', title: 'Decision', oneOf: [{ const: 'confirm', title: 'Confirm the change' }, { const: 'reject', title: 'Reject' }] } }, required: ['choice'] };

describe('the line to the engine', () => {
  test('says hello with both kinds of dialog and lends it nothing else', async () => {
    const wire = line();
    const client = new EngineClient(wire.transport);
    const hello = client.start();
    const first = wire.sent[0]!;
    expect(first.method).toBe('initialize');
    const params = first.params as { protocolVersion: string; capabilities: Record<string, unknown> };
    expect(params.protocolVersion).toBe(ENGINE_PROTOCOL);
    expect(params.capabilities).toEqual({ elicitation: { form: {}, url: {} }, roots: { listChanged: false } });
    wire.say({ jsonrpc: '2.0', id: first.id, result: { protocolVersion: ENGINE_PROTOCOL, serverInfo: { name: 'collab', version: '0.0.0' } } });
    expect(await hello).toEqual({ name: 'collab', version: '0.0.0', protocol: ENGINE_PROTOCOL });
    expect(wire.sent[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  test('a tool answers in prose, and says when it failed', async () => {
    const wire = line();
    const client = new EngineClient(wire.transport);
    const asked = client.call('account', { action: 'status' });
    const call = wire.sent[0]!;
    expect(call.params).toEqual({ name: 'account', arguments: { action: 'status' } });
    wire.say({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: 'Logged in: no' }, { type: 'image', data: 'x' }, { type: 'text', text: 'Connection: idle' }] } });
    expect(await asked).toEqual({ text: 'Logged in: no\nConnection: idle', failed: false });

    const failing = client.call('inbox', { action: 'read' });
    wire.say({ jsonrpc: '2.0', id: wire.sent[1]!.id, result: { content: [{ type: 'text', text: 'Error (not_found)' }], isError: true } });
    expect(await failing).toEqual({ text: 'Error (not_found)', failed: true });

    const refused = client.call('policy', { nonsense: true });
    wire.say({ jsonrpc: '2.0', id: wire.sent[2]!.id, error: { code: -32602, message: 'Invalid arguments' } });
    await expect(refused).rejects.toBeInstanceOf(EngineRefused);
  });

  test('a dialog goes to whoever answers for the person, with the call it belongs to, and the answer goes back unchanged', async () => {
    const wire = line();
    const seen: EngineDialog[] = [];
    const client = new EngineClient(wire.transport, {
      onDialog: async (dialog) => { seen.push(dialog); return { action: 'accept', content: { choice: 'reject' } }; },
    });
    void client.call('policy', { action: 'set', kind: 'task', effect: 'allow' });
    wire.say({ jsonrpc: '2.0', id: 'd1', method: 'elicitation/create', params: { mode: 'form', message: 'collab: change a permission?', requestedSchema: CHOICE } });
    await until(() => wire.sent.length === 2);
    expect(wire.sent[1]).toEqual({ jsonrpc: '2.0', id: 'd1', result: { action: 'accept', content: { choice: 'reject' } } });
    expect(seen[0]).toEqual({
      mode: 'form', message: 'collab: change a permission?', required: ['choice'],
      fields: { choice: { type: 'string', title: 'Decision', options: [{ value: 'confirm', title: 'Confirm the change' }, { value: 'reject', title: 'Reject' }] } },
      during: { tool: 'policy', args: { action: 'set', kind: 'task', effect: 'allow' } },
    });
  });

  test('a dialog that is a web page carries the page', async () => {
    const wire = line();
    const seen: EngineDialog[] = [];
    new EngineClient(wire.transport, { onDialog: async (dialog) => { seen.push(dialog); return { action: 'accept' }; } });
    wire.say({ jsonrpc: '2.0', id: 9, method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', url: 'https://collab.invalid/a', elicitationId: 'e1' } });
    await until(() => wire.sent.length === 1);
    expect(seen[0]).toMatchObject({ mode: 'url', url: 'https://collab.invalid/a', elicitationId: 'e1', during: null });
    expect(wire.sent[0]).toEqual({ jsonrpc: '2.0', id: 9, result: { action: 'accept' } });
  });

  test('with nobody to ask, a dialog is closed and never answered', async () => {
    const wire = line();
    new EngineClient(wire.transport);
    wire.say({ jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: { mode: 'form', message: 'Approve?', requestedSchema: CHOICE } });
    await until(() => wire.sent.length === 1);
    expect(wire.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { action: 'cancel' } });
  });

  test('when asking the person fails, the dialog is closed', async () => {
    const wire = line();
    new EngineClient(wire.transport, { onDialog: async () => { throw new Error('the notch is gone'); } });
    wire.say({ jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: { mode: 'form', message: 'Approve?', requestedSchema: CHOICE } });
    await until(() => wire.sent.length === 1);
    expect(wire.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { action: 'cancel' } });
  });

  test('an answer that is not one of the three is a closed dialog', async () => {
    const wire = line();
    new EngineClient(wire.transport, { onDialog: async () => ({ action: 'yes' } as unknown as EngineDialogAnswer) });
    wire.say({ jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: { mode: 'form', message: 'Approve?', requestedSchema: CHOICE } });
    await until(() => wire.sent.length === 1);
    expect(wire.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { action: 'cancel' } });
  });

  test('the engine is lent no model: anything but a dialog, the folders and a ping is refused', async () => {
    const wire = line();
    new EngineClient(wire.transport, { onDialog: async () => ({ action: 'accept', content: {} }) });
    wire.say({ jsonrpc: '2.0', id: 4, method: 'sampling/createMessage', params: { messages: [] } });
    wire.say({ jsonrpc: '2.0', id: 5, method: 'roots/list' });
    wire.say({ jsonrpc: '2.0', id: 6, method: 'ping' });
    await until(() => wire.sent.length === 3);
    expect(wire.sent[0]).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'not supported' } });
    expect(wire.sent[1]).toEqual({ jsonrpc: '2.0', id: 5, result: { roots: [] } });
    expect(wire.sent[2]).toEqual({ jsonrpc: '2.0', id: 6, result: {} });
  });

  test('a notice is heard, and a line that is not a message is passed over', async () => {
    const wire = line();
    const notices: [string, Record<string, unknown>][] = [];
    new EngineClient(wire.transport, { onNotice: (method, params) => notices.push([method, params]) });
    wire.raw('not json at all');
    wire.raw('');
    wire.raw('[1,2,3]');
    wire.say({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'arrived', meta: { kind: 'message', item_id: 'i1' } } });
    expect(notices).toEqual([['notifications/claude/channel', { content: 'arrived', meta: { kind: 'message', item_id: 'i1' } }]]);
  });

  test('when the engine goes away, what was waiting fails and later calls fail at once', async () => {
    const wire = line();
    const client = new EngineClient(wire.transport);
    const waiting = client.call('inbox', { action: 'list' });
    let told = 0;
    client.onClosed(() => { told++; });
    wire.end();
    await expect(waiting).rejects.toBeInstanceOf(EngineClosed);
    await expect(client.call('inbox')).rejects.toBeInstanceOf(EngineClosed);
    expect(told).toBe(1);
  });

  test('a call that is not answered in its time fails', async () => {
    const wire = line();
    const client = new EngineClient(wire.transport);
    await expect(client.call('connect', { action: 'wait' }, 20)).rejects.toBeInstanceOf(EngineClosed);
  });

  test('the fields of a form are read whatever shape they come in', () => {
    expect(readDialogFields(null)).toEqual({ fields: {}, required: [] });
    expect(readDialogFields({ properties: { name: { type: 'string', maxLength: 64, default: 'Leo' }, sure: { type: 'boolean', default: true }, pick: { type: 'string', enum: ['a', 'b'], enumNames: ['One'] } }, required: ['name', 7] })).toEqual({
      fields: {
        name: { type: 'string', default: 'Leo', maxLength: 64 },
        sure: { type: 'boolean', default: true },
        pick: { type: 'string', options: [{ value: 'a', title: 'One' }, { value: 'b', title: 'b' }] },
      },
      required: ['name'],
    });
  });
});

describe('the environment the engine runs in', () => {
  const base = {
    PATH: '/usr/bin', HOME: '/home/sam', LANG: 'en_GB.UTF-8',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDECODE: '1', AI_AGENT: 'claude-code/2.1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PROJECT_DIR: '/p',
    COLLAB_INTERACTIVE: '0', COLLAB_UNATTENDED_TASKS: '1', COLLAB_DATA_DIR: '/elsewhere', COLLAB_CHANNELS: '0', COLLAB_DESKTOP_NOTIFY: '1',
    COLLAB_SERVER_URL: 'https://collab.invalid', COLLAB_KEYSTORE: 'file', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    JARVIS_NOTCH: '1', JARVIS_DEBUG_RPC: 'secret', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y',
  };

  test('nothing of a coding agent reaches it: the engine would take itself for a session nobody watches', () => {
    const env = engineEnv(base, '/data/peers');
    for (const name of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'COLLAB_INTERACTIVE']) expect(env[name]).toBeUndefined();
  });

  test('nothing of the brain reaches it', () => {
    const env = engineEnv(base, '/data/peers');
    for (const name of ['JARVIS_NOTCH', 'JARVIS_DEBUG_RPC', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) expect(env[name]).toBeUndefined();
  });

  test('its folder, its notices and its silence are set here, whatever was set outside', () => {
    const env = engineEnv(base, '/data/peers');
    expect(env.COLLAB_DATA_DIR).toBe('/data/peers');
    expect(env.COLLAB_CHANNELS).toBe('1');
    expect(env.COLLAB_DESKTOP_NOTIFY).toBe('0');
    expect(env.COLLAB_UNATTENDED_TASKS).toBe('0');
  });

  test('the server and the place of its key are the person\'s to set, and what it needs to run is there', () => {
    const env = engineEnv(base, '/data/peers');
    expect(env.COLLAB_SERVER_URL).toBe('https://collab.invalid');
    expect(env.COLLAB_KEYSTORE).toBe('file');
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/sam');
  });
});

describe('the engine as a program', () => {
  test('is started in a folder of its own that nobody else can read, and answers', async () => {
    const brain = folder();
    const child = startEngine({ path: standIn(), brainDataDir: brain, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } });
    const client = new EngineClient(child.transport);
    expect(await client.start()).toEqual({ name: 'collab', version: '0.0.0', protocol: ENGINE_PROTOCOL });
    expect(await client.tools()).toContain('send_message');
    expect(statSync(engineDataDir(brain)).mode & 0o777).toBe(0o700);
    child.stop();
    expect(await child.ended).toBe(0);
  });

  test('a dialog of the program is answered by the person and by nothing else', async () => {
    const brain = folder();
    const answers: EngineDialogAnswer[] = [{ action: 'cancel' }, { action: 'accept', content: { choice: 'confirm' } }];
    const child = startEngine({ path: standIn(), brainDataDir: brain });
    const client = new EngineClient(child.transport, { onDialog: async () => answers.shift()! });
    await client.start();
    expect((await client.call('policy', { action: 'set', kind: 'task', effect: 'allow' })).text).toBe('The user closed the dialog; nothing changed.');
    expect((await client.call('policy', { action: 'show' })).text).toContain('default task: ask');
    expect((await client.call('policy', { action: 'set', kind: 'task', effect: 'allow' })).text).toBe('The policy was changed.');
    expect((await client.call('policy', { action: 'show' })).text).toContain('default task: allow');
    child.stop();
    await child.ended;
  });

  test('without anybody to ask, the program is told the dialog was closed and changes nothing', async () => {
    const child = startEngine({ path: standIn(), brainDataDir: folder() });
    const client = new EngineClient(child.transport);
    await client.start();
    expect((await client.call('policy', { action: 'set', kind: 'task', effect: 'allow' })).text).toBe('The user closed the dialog; nothing changed.');
    expect((await client.call('policy', { action: 'show' })).text).toContain('default task: ask');
    expect((await client.call('_model')).text).toContain('-32601');
    child.stop();
    await child.ended;
  });
});

describe('reading what the engine stored', () => {
  test('a read is a fixed command that opens no line, and gives the document', async () => {
    const brain = folder();
    const options = { path: standIn(), brainDataDir: brain, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } };
    const status = await readEngine('status', options);
    expect(status.words).toEqual(['status', '--json']);
    expect(status.env).toEqual({ dataDir: engineDataDir(brain), channels: '1', entrypoint: null });
    expect((await readEngine('inbox', options)).words).toEqual(['inbox', '--offline', '--json']);
    expect((await readEngine('tasks', options)).words).toEqual(['tasks', 'list', '--offline', '--json']);
    expect(await readEngine('contacts', options)).toEqual({ contacts: [], trustControlPlaneVouches: false });
  });

  test('only the flags it knows are added, and nothing a contact wrote can become one', async () => {
    const options = { path: standIn(), brainDataDir: folder() };
    expect((await readEngine('inbox', options, { unread: true, limit: 20, from: 'Jh4HNausI3xIVTI3yF7MgA' })).words).toEqual(['inbox', '--offline', '--unread', '--limit', '20', '--from', 'Jh4HNausI3xIVTI3yF7MgA', '--json']);
    expect((await readEngine('inbox', options, { limit: 5000, from: '--watch' })).words).toEqual(['inbox', '--offline', '--json']);
    expect((await readEngine('inbox', options, { from: 'leo; rm -rf /' })).words).toEqual(['inbox', '--offline', '--json']);
    expect((await readEngine('tasks', options, { active: true })).words).toEqual(['tasks', 'list', '--offline', '--active', '--json']);
    expect((await readEngine('status', options, { unread: true })).words).toEqual(['status', '--json']);
  });

  test('a program that prints no document fails the read', async () => {
    const path = join(folder(), 'engine');
    writeFileSync(path, '#!/bin/sh\necho "Usage: collab"\n');
    chmodSync(path, 0o755);
    await expect(readEngine('status', { path, brainDataDir: folder() })).rejects.toBeInstanceOf(EngineReadFailed);
    writeFileSync(path, '#!/bin/sh\necho \'{"error":{"code":"usage","message":"missing"}}\'\n');
    await expect(readEngine('status', { path, brainDataDir: folder() })).rejects.toThrow('usage');
  });
});

describe('the engine, kept up', () => {
  test('comes up, answers, and is started again when it falls', async () => {
    const states: EngineState[] = [];
    const engine = new PeerEngine({ path: standIn(), brainDataDir: folder(), onState: (state) => states.push(state), restartFirstMs: 20, restartMaxMs: 80 });
    engine.start();
    await until(() => engine.state() === 'up');
    expect((await engine.call('account', { action: 'status' })).text).toContain('Dialogs: available');
    // It falls in the middle of a call.
    await expect(engine.call('_fall')).rejects.toBeInstanceOf(EngineClosed);
    await until(() => states.includes('down'));
    await expect(engine.call('account')).rejects.toThrow('not up');
    await until(() => engine.state() === 'up' && states.filter((state) => state === 'up').length === 2);
    expect((await engine.call('account', { action: 'status' })).text).toContain('Logged in: no');
    expect(states).toEqual(['starting', 'up', 'down', 'starting', 'up']);
    engine.stop();
    expect(engine.state()).toBe('stopped');
  });

  test('a dialog and a notice of the engine reach whoever listens', async () => {
    const dialogs: string[] = [];
    const notices: string[] = [];
    const engine = new PeerEngine({
      path: standIn(), brainDataDir: folder(),
      onDialog: async (dialog) => { dialogs.push(`${dialog.mode}:${dialog.during?.tool}`); return { action: 'cancel' }; },
      onNotice: (method, params) => notices.push(`${method}:${(params.meta as { item_id: string }).item_id}`),
    });
    engine.start();
    await until(() => engine.state() === 'up');
    await engine.call('policy', { action: 'set', kind: 'message', effect: 'ask' });
    await engine.call('_arrive', { item: 'i7' });
    expect(dialogs).toEqual(['form:policy']);
    expect(notices).toEqual(['notifications/claude/channel:i7']);
    engine.stop();
  });

  test('a program that is not there is tried again, slowly, and stopping ends the trying', async () => {
    const states: EngineState[] = [];
    const lines: string[] = [];
    const engine = new PeerEngine({ path: join(folder(), 'no-such-engine'), brainDataDir: folder(), onState: (state) => states.push(state), log: (line) => lines.push(line), restartFirstMs: 10, restartMaxMs: 40 });
    engine.start();
    await until(() => states.filter((state) => state === 'down').length >= 2);
    engine.stop();
    const after = states.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(states.length).toBe(after);
    expect(states[states.length - 1]).toBe('stopped');
    expect(lines.some((line) => line.includes('40 s') || line.includes('0 s'))).toBe(true);
  });

  test('each fall waits longer than the last, up to the longest wait', async () => {
    const waits: string[] = [];
    let starts = 0;
    const engine = new PeerEngine({
      path: 'unused', brainDataDir: folder(), restartFirstMs: 1000, restartMaxMs: 3000, log: (line) => { if (line.includes('again in')) waits.push(line.replace(/.*again in /, '')); },
      // An engine that ends the moment it is started.
      spawn: () => { starts++; return { transport: { send() {}, onLine() {}, onClose(listener) { queueMicrotask(listener); }, close() {} }, ended: Promise.resolve(1), stop() {} }; },
    });
    // Its own clock would make this test take seconds: the waits are read from what it says it will do.
    const real = globalThis.setTimeout;
    (globalThis as { setTimeout: unknown }).setTimeout = ((run: () => void) => real(run, 1)) as unknown as typeof setTimeout;
    try {
      engine.start();
      await until(() => waits.length >= 4);
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = real;
      engine.stop();
    }
    expect(waits.slice(0, 4)).toEqual(['1 s', '2 s', '3 s', '3 s']);
    expect(starts).toBeGreaterThanOrEqual(4);
  });
});
