/**
 * The body `POST /api/config/channels` accepts (#883).
 *
 * The route used to spread the body over the saved section with `as any`, so
 * any key was saved and `allowed_users` could be any shape. A string there
 * made the adapter's chat gate a substring match. Now every key is checked,
 * an unknown key is refused rather than merged, and nothing is saved unless
 * the whole body is valid.
 */

import { isDiscordSnowflake, isTelegramUserId } from '../comms/channels/allow-list.ts';

export type TelegramPatch = { enabled?: boolean; bot_token?: string; allowed_users?: number[] };
export type DiscordPatch = { enabled?: boolean; bot_token?: string; allowed_users?: string[]; guild_id?: string | null };
export type ChannelsPatch = { telegram?: TelegramPatch; discord?: DiscordPatch };

type Result = { ok: true; patch: ChannelsPatch } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

function badIds(list: unknown[], valid: (v: unknown) => boolean): string {
  return list.filter((v) => !valid(v)).map((v) => JSON.stringify(v) ?? String(v)).join(', ');
}

export function validateChannelsPatch(body: unknown): Result {
  if (!isPlainObject(body)) return { ok: false, error: 'Expected a JSON object with telegram and/or discord settings.' };
  const extra = unknownKeys(body, ['telegram', 'discord']);
  if (extra.length) return { ok: false, error: `Unknown channel settings: ${extra.join(', ')}.` };

  const patch: ChannelsPatch = {};

  if (body.telegram !== undefined) {
    const tg = body.telegram;
    if (!isPlainObject(tg)) return { ok: false, error: 'telegram must be an object.' };
    const tgExtra = unknownKeys(tg, ['enabled', 'bot_token', 'allowed_users']);
    if (tgExtra.length) return { ok: false, error: `Unknown Telegram settings: ${tgExtra.join(', ')}.` };
    const out: TelegramPatch = {};
    if (tg.enabled !== undefined) {
      if (typeof tg.enabled !== 'boolean') return { ok: false, error: 'telegram.enabled must be true or false.' };
      out.enabled = tg.enabled;
    }
    if (tg.bot_token !== undefined) {
      if (typeof tg.bot_token !== 'string') return { ok: false, error: 'telegram.bot_token must be text.' };
      out.bot_token = tg.bot_token;
    }
    if (tg.allowed_users !== undefined) {
      if (!Array.isArray(tg.allowed_users)) return { ok: false, error: 'telegram.allowed_users must be a list of numeric user IDs.' };
      const bad = badIds(tg.allowed_users, isTelegramUserId);
      if (bad) return { ok: false, error: `Not a Telegram user ID: ${bad}. A user ID is a positive whole number.` };
      out.allowed_users = [...new Set(tg.allowed_users as number[])];
    }
    patch.telegram = out;
  }

  if (body.discord !== undefined) {
    const dc = body.discord;
    if (!isPlainObject(dc)) return { ok: false, error: 'discord must be an object.' };
    const dcExtra = unknownKeys(dc, ['enabled', 'bot_token', 'allowed_users', 'guild_id']);
    if (dcExtra.length) return { ok: false, error: `Unknown Discord settings: ${dcExtra.join(', ')}.` };
    const out: DiscordPatch = {};
    if (dc.enabled !== undefined) {
      if (typeof dc.enabled !== 'boolean') return { ok: false, error: 'discord.enabled must be true or false.' };
      out.enabled = dc.enabled;
    }
    if (dc.bot_token !== undefined) {
      if (typeof dc.bot_token !== 'string') return { ok: false, error: 'discord.bot_token must be text.' };
      out.bot_token = dc.bot_token;
    }
    if (dc.allowed_users !== undefined) {
      if (!Array.isArray(dc.allowed_users)) return { ok: false, error: 'discord.allowed_users must be a list of user IDs.' };
      const bad = badIds(dc.allowed_users, isDiscordSnowflake);
      if (bad) return { ok: false, error: `Not a Discord user ID: ${bad}. A user ID is 17 to 20 digits, sent as text.` };
      out.allowed_users = [...new Set(dc.allowed_users as string[])];
    }
    if (dc.guild_id !== undefined) {
      if (dc.guild_id !== null && !isDiscordSnowflake(dc.guild_id)) {
        return { ok: false, error: 'discord.guild_id must be a server ID (17 to 20 digits, as text), or null to clear it.' };
      }
      out.guild_id = dc.guild_id;
    }
    patch.discord = out;
  }

  return { ok: true, patch };
}
