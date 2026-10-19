import { expect, test } from 'bun:test';
import { TelegramAdapter } from './telegram';
import { DiscordAdapter } from './discord';
import { EventEmitter } from 'node:events';
import { Client, Status } from 'discord.js';

test('Telegram send rejection is retained and contains no provider error or token', async () => {
  const original = globalThis.fetch, adapter = new TelegramAdapter('fixture-secret');
  try {
    globalThis.fetch = (async () => Response.json({ ok: false, error_code: 401, description: 'fixture error' }, { status: 401 })) as unknown as typeof fetch;
    await expect(adapter.sendMessage('fixture', 'message')).rejects.toThrow();
    expect(adapter.authenticationState()).toBe('rejected');
  } finally { globalThis.fetch = original; }
});
test('Discord uses current SDK readiness, reports token rejection and does not trust its stale connected flag', async () => {
  const login = Client.prototype.login;
  let client: Client | undefined;
  Client.prototype.login = async function () { client = this; this.emit('ready', this as any); return 'fixture'; };
  const adapter = new DiscordAdapter('fixture-token');
  try {
    await adapter.connect(); expect(adapter.isConnected()).toBe(true);
    expect(adapter.authenticationState()).toBe('unknown'); // SDK has no live socket
    client!.emit('shardDisconnect', { code: 4004 } as any, 0);
    expect(adapter.authenticationState()).toBe('rejected');
  } finally { Client.prototype.login = login; await adapter.disconnect(); }
});
test('Discord login token errors remain visible after failed adapter startup', async () => {
  const login = Client.prototype.login;
  Client.prototype.login = async () => { throw Object.assign(new Error('fixture'), { code: 'TokenInvalid' }); };
  const adapter = new DiscordAdapter('fixture-token');
  try {
    await expect(adapter.connect()).rejects.toThrow('fixture'); expect(adapter.authenticationState()).toBe('rejected');
  } finally { Client.prototype.login = login; await adapter.disconnect(); }
});

test('actual Discord SDK gateway close/resume handlers override latched manager readiness', async () => {
  const login = Client.prototype.login;
  let client: Client;
  let transport: EventEmitter;
  Client.prototype.login = async function () {
    client = this;
    transport = Object.assign(new EventEmitter(), { destroy: async () => {} });
    (this.ws as any)._ws = transport;
    this.ws.status = Status.Ready;
    this.ws.shards.set(0, Object.assign(new EventEmitter(), { status: Status.Ready }) as any);
    (this.ws as any).attachEvents();
    this.emit('ready', this as any);
    return 'fixture';
  };
  const adapter = new DiscordAdapter('fixture-token');
  try {
    await adapter.connect(); expect(adapter.authenticationState()).toBe('verified');
    for (const code of [1006, 4014]) {
      transport!.emit('closed', { code, shardId: 0 });
      expect(client!.isReady()).toBe(true); expect(adapter.isConnected()).toBe(true);
      expect(adapter.authenticationState()).toBe('unknown');
      transport!.emit('resumed', { shardId: 0 });
      expect(adapter.authenticationState()).toBe('verified');
    }
    client!.ws.shards.set(1, { status: Status.Connecting } as any);
    expect(adapter.authenticationState()).toBe('unknown'); client!.ws.shards.delete(1);
    transport!.emit('closed', { code: 4004, shardId: 0 });
    expect(adapter.authenticationState()).toBe('rejected');
    transport!.emit('resumed', { shardId: 0 }); expect(adapter.authenticationState()).toBe('rejected');
  } finally { Client.prototype.login = login; await adapter.disconnect(); }
});

test('Telegram poll that disconnect() aborted cannot mark the adapter verified when its body lands later', async () => {
  const original = globalThis.fetch, adapter = new TelegramAdapter('fixture-token');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    globalThis.fetch = (async () => ({ status: 200, json: async () => { await gate; return { ok: true, result: [] }; } })) as unknown as typeof fetch;
    const poll = (adapter as any).getUpdates().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    await adapter.disconnect();
    release(); await poll; await new Promise(resolve => setTimeout(resolve, 0));
    expect(adapter.authenticationState()).toBe('unknown');
  } finally { globalThis.fetch = original; }
});
