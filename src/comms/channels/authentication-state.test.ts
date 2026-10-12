import { expect, test } from 'bun:test';
import { TelegramAdapter } from './telegram';
import { DiscordAdapter } from './discord';
import { Client } from 'discord.js';

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
