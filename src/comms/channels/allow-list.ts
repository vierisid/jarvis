/**
 * What a channel's `allowed_users` setting means, read from whatever shape it
 * arrived in (#883).
 *
 * The setting reaches the adapters from three places: the dashboard's POST
 * (validated since #883), a settings row an older version saved without any
 * validation, and a hand-edited config.yaml. Before this, each adapter took it
 * as given and tested it with `.includes`, so a STRING turned the chat gate
 * into a substring match: `"12345".includes(123)` is true, and
 * `allowed_users: "12345"` let in user 123, 234, 1234 and so on.
 *
 * So the value is parsed here, once, and every gate reads the result:
 *   - `ids` are the entries that name exactly one user;
 *   - `restricted` says whether the owner tried to restrict the channel at
 *     all. Anything other than an absent or empty list restricts it, so a
 *     value that names nobody (a string, `["042"]`, a YAML float) locks the
 *     channel rather than opening it to everyone. Failing open here would turn
 *     a typo into "anyone may chat".
 *   - `problems` say, in words, which entries were ignored and why, for the
 *     startup log and the Channels settings page.
 */
export type AllowList<T extends number | string> = {
  ids: T[];
  restricted: boolean;
  problems: string[];
  /** Each ignored entry as text, so the settings page can show what was there. */
  rejected: string[];
};

/** Largest Discord snowflake: an unsigned 64-bit integer. */
const MAX_SNOWFLAKE = (1n << 64n) - 1n;

/**
 * A Discord snowflake as Discord writes it: a decimal string of 17 to 20
 * digits with no leading zero. Every Discord user id is one; anything shorter
 * is not an id Discord has issued to a user since 2015.
 */
export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{16,19}$/.test(value) && BigInt(value) <= MAX_SNOWFLAKE;
}

/** A Telegram user id: a positive integer a JavaScript number holds exactly. */
export function isTelegramUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'an object' : typeof value;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parse<T extends number | string>(
  raw: unknown,
  valid: (v: unknown) => v is T,
  why: (v: unknown) => string,
): AllowList<T> {
  if (raw === undefined || raw === null) return { ids: [], restricted: false, problems: [], rejected: [] };
  if (!Array.isArray(raw)) {
    return {
      ids: [],
      restricted: true,
      problems: [`allowed_users must be a list of IDs, but it is ${describe(raw)}. Nobody may use the channel until it is fixed.`],
      rejected: typeof raw === 'string'
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : [asText(raw)],
    };
  }
  const ids: T[] = [];
  const problems: string[] = [];
  const rejected: string[] = [];
  for (const entry of raw) {
    if (valid(entry)) {
      if (!ids.includes(entry)) ids.push(entry);
      continue;
    }
    problems.push(`${describe(entry)} is ignored: ${why(entry)}`);
    rejected.push(asText(entry));
  }
  return { ids, restricted: raw.length > 0, problems, rejected };
}

/** `allowed_users` for Telegram: positive integer user ids. */
export function telegramAllowList(raw: unknown): AllowList<number> {
  return parse(raw, isTelegramUserId, (v) => {
    if (typeof v === 'string') return 'a Telegram ID is a number; write it without quotes or leading zeros.';
    if (typeof v === 'number' && Number.isInteger(v) && v <= 0) return 'a user ID is positive (a negative ID is a group or channel, not a person).';
    if (typeof v === 'number' && Number.isInteger(v)) return 'it is too large to be held exactly, so it cannot match a user.';
    if (typeof v === 'number') return 'a Telegram ID is a whole number.';
    return 'a Telegram ID is a number.';
  });
}

/** `allowed_users` for Discord: snowflake user ids, as strings. */
export function discordAllowList(raw: unknown): AllowList<string> {
  return parse(raw, isDiscordSnowflake, (v) => {
    if (typeof v === 'number') return 'a Discord ID must be quoted text. Written as a number it loses its last digits and matches nobody.';
    if (typeof v === 'string') return 'a Discord user ID is 17 to 20 digits.';
    return 'a Discord ID is quoted text.';
  });
}

/** The allow-list for a channel by name, or null for a channel that has none. */
export function channelAllowList(channel: string, raw: unknown): AllowList<number | string> | null {
  if (channel === 'telegram') return telegramAllowList(raw);
  if (channel === 'discord') return discordAllowList(raw);
  return null;
}
