/**
 * #883. `POST /api/config/channels` spread the body over the saved section
 * with `as any`, so `allowed_users` could be any shape and any key was saved.
 *
 * The keychain writes to `~/.jarvis`, so every test redirects it to a
 * throwaway dir via JARVIS_SECRETS_DIR, never the developer's real store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { getSetting } from '../vault/settings.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { validateChannelsPatch } from './channels-config-patch.ts';
import { ChannelService } from './channel-service.ts';
import type { ChannelAdapter } from '../comms/channels/telegram.ts';

const SNOWFLAKE = '123456789012345678';

describe('#883: POST /api/config/channels validates what it saves', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;
  let config: JarvisConfig;
  let applied: string[];
  let route: { GET: () => Response; POST: (req: Request) => Promise<Response> };

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-channels-route-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    initDatabase(':memory:');
    config = structuredClone(DEFAULT_CONFIG);
    applied = [];
    const ctx = {
      daemonStartedAt: Date.now(),
      healthMonitor: {},
      config,
      settingsReload: { applyNow: async (section: string) => { applied.push(section); return null; } },
    } as unknown as ApiContext;
    route = createApiRoutes(ctx)['/api/config/channels'] as typeof route;
  });

  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  const post = (body: unknown) => route.POST(new Request('http://x/api/config/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

  const refused = async (body: unknown, message: string | RegExp) => {
    const before = structuredClone(config.channels);
    const res = await post(body);
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    if (typeof message === 'string') expect(error).toBe(message);
    else expect(error).toMatch(message);
    // Nothing saved, nothing applied, the live config untouched.
    expect(getSetting('cfg.channels')).toBeNull();
    expect(applied).toEqual([]);
    expect(config.channels).toEqual(before);
  };

  test('a string allowed_users, the substring-match shape, is refused', async () => {
    await refused({ telegram: { allowed_users: '12345' } }, 'telegram.allowed_users must be a list of numeric user IDs.');
    await refused({ discord: { allowed_users: SNOWFLAKE } }, 'discord.allowed_users must be a list of user IDs.');
  });

  test('entries that are not ids for the channel are refused, by name', async () => {
    await refused({ telegram: { allowed_users: [42, '042'] } }, 'Not a Telegram user ID: "042". A user ID is a positive whole number.');
    await refused({ telegram: { allowed_users: [1.5, -100, null] } }, 'Not a Telegram user ID: 1.5, -100, null. A user ID is a positive whole number.');
    await refused({ discord: { allowed_users: [123456789012345678] } }, /^Not a Discord user ID: 123456789012345680\./);
    await refused({ discord: { allowed_users: ['u1'] } }, /^Not a Discord user ID: "u1"\./);
  });

  test('unknown keys are refused rather than merged', async () => {
    await refused({ telegram: { allowed_users: [42], allowedUsers: [1] } }, 'Unknown Telegram settings: allowedUsers.');
    await refused({ discord: { admin: true } }, 'Unknown Discord settings: admin.');
    await refused({ slack: { enabled: true } }, 'Unknown channel settings: slack.');
  });

  test('wrongly typed scalars and non-object bodies are refused', async () => {
    await refused({ telegram: { enabled: 'yes' } }, 'telegram.enabled must be true or false.');
    await refused({ telegram: { bot_token: 5 } }, 'telegram.bot_token must be text.');
    await refused({ discord: { guild_id: 5 } }, /^discord\.guild_id must be a server ID/);
    await refused({ telegram: [] }, 'telegram must be an object.');
    await refused([], 'Expected a JSON object with telegram and/or discord settings.');
    await refused('not json', 'Expected a JSON body');
  });

  test('a valid body is saved and applied as before', async () => {
    const res = await post({ telegram: { enabled: true, bot_token: 'tg', allowed_users: [42, 42, 7] }, discord: { allowed_users: [SNOWFLAKE], guild_id: SNOWFLAKE } });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(applied).toEqual(['channels']);
    expect(config.channels?.telegram).toEqual({ enabled: true, bot_token: 'tg', allowed_users: [42, 7] });
    expect(config.channels?.discord).toMatchObject({ allowed_users: [SNOWFLAKE], guild_id: SNOWFLAKE });

    // null clears the guild restriction.
    await post({ discord: { guild_id: null } });
    expect(config.channels?.discord?.guild_id).toBeUndefined();
  });

  test('GET reports a hand-edited value as the adapters read it, and says what was ignored', async () => {
    (config.channels!.telegram as { allowed_users: unknown }).allowed_users = '12345';
    (config.channels!.discord as { allowed_users: unknown }).allowed_users = [SNOWFLAKE, 123456789012345678];
    const got = await route.GET().json() as {
      telegram: { allowed_users: unknown; allowed_users_rejected: unknown; allowed_users_problems: string[] };
      discord: { allowed_users: unknown; allowed_users_rejected: unknown; allowed_users_problems: string[] };
    };
    expect(got.telegram.allowed_users).toEqual([]);
    expect(got.telegram.allowed_users_rejected).toEqual(['12345']);
    expect(got.telegram.allowed_users_problems).toHaveLength(1);
    expect(got.discord.allowed_users).toEqual([SNOWFLAKE]);
    expect(got.discord.allowed_users_rejected).toEqual(['123456789012345680']);
    expect(got.discord.allowed_users_problems[0]).toContain('loses its last digits');
  });
});

describe('#883: validateChannelsPatch', () => {
  test('an empty patch and an empty list are valid', () => {
    expect(validateChannelsPatch({})).toEqual({ ok: true, patch: {} });
    expect(validateChannelsPatch({ telegram: { allowed_users: [] } })).toEqual({ ok: true, patch: { telegram: { allowed_users: [] } } });
  });
});

/**
 * #890. A save that leaves a channel with nowhere to send approval requests,
 * such as removing the user they went to, now says so, and the status route
 * reports it for the settings page.
 */
describe('#890: the routes say when a channel has no recipient', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;
  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-channels-route-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  const connected = (name: string): ChannelAdapter => ({
    name, connect: async () => {}, disconnect: async () => {}, sendMessage: async () => {},
    onMessage: () => {}, isConnected: () => true,
  });

  test('removing the recipient: the save says Telegram now has nobody, and status reports why', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.channels!.telegram = { enabled: true, bot_token: 'tg', allowed_users: [42] };
    const svc = new ChannelService(config, { handleThreadMessage: async () => 'ok' } as never);
    svc.getManager().register(connected('telegram'));
    await (svc as unknown as { handleChannelMessage(m: unknown): Promise<string> }).handleChannelMessage({
      id: 'm', channel: 'telegram', from: 'owner', text: 'hi', timestamp: 0,
      metadata: { chatId: 42, userId: 42, chatType: 'private' }, senderAllowListed: true,
    });
    const ctx = {
      daemonStartedAt: Date.now(), healthMonitor: {}, config, channelService: svc,
      settingsReload: { applyNow: async () => null },
    } as unknown as ApiContext;
    const routes = createApiRoutes(ctx);
    const status = routes['/api/channels/status'] as { GET: () => Response };
    const channels = routes['/api/config/channels'] as { POST: (req: Request) => Promise<Response> };
    const save = async (body: unknown) => (await channels.POST(new Request('http://x/api/config/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))).json() as Promise<{ ok: boolean; message: string }>;

    expect(((await status.GET().json()) as { recipients: unknown }).recipients).toEqual({ telegram: { hasRecipient: true } });
    expect(await save({ telegram: { allowed_users: [42, 7] } })).toEqual({ ok: true, message: 'Channel config saved and applied.' });

    expect(await save({ telegram: { allowed_users: [7] } })).toEqual({
      ok: true,
      message: 'Channel config saved and applied. Telegram will not receive approval requests or notifications until a listed user sends the bot a direct message (again, if they did before).',
    });
    expect(((await status.GET().json()) as { recipients: unknown }).recipients).toEqual({ telegram: { hasRecipient: false, reason: 'no_direct_message' } });

    expect((await save({ telegram: { allowed_users: [] } })).message).toBe('Channel config saved and applied. Telegram will not receive approval requests or notifications: no user ID is listed for it.');
    // A save of another channel says nothing about this one.
    expect((await save({ discord: { enabled: false } })).message).toBe('Channel config saved and applied.');
  });
});
