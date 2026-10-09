/**
 * The Channels tab's "Allowed user IDs" field, read and written (#883).
 *
 * The Save button used to keep whatever `Number()` accepted and drop the rest
 * without a word, so a typo like `12345x` vanished and, if it was the only id,
 * saved an EMPTY list -- which lets anyone who finds the bot chat. Now a field
 * with anything that is not an id refuses to save and says which entry.
 */

/** Same rule as the daemon: a Telegram user id is a positive safe integer. */
const TELEGRAM_ID = /^[1-9][0-9]*$/;
/** Same rule as the daemon: a Discord user id is a 17 to 20 digit snowflake. */
const DISCORD_ID = /^[1-9][0-9]{16,19}$/;

export type ParsedIds<T> = { ok: true; ids: T[] } | { ok: false; message: string };

function entries(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

function refusal(bad: string[], rule: string): { ok: false; message: string } {
  const list = bad.map((b) => `"${b}"`).join(", ");
  return { ok: false, message: `Not saved: ${list} ${bad.length === 1 ? "is" : "are"} not ${rule}. Nothing was changed.` };
}

export function parseTelegramIds(text: string): ParsedIds<number> {
  const all = entries(text);
  const bad = all.filter((s) => !TELEGRAM_ID.test(s) || !Number.isSafeInteger(Number(s)));
  if (bad.length) return refusal(bad, "a Telegram user ID (a positive whole number)");
  return { ok: true, ids: [...new Set(all.map(Number))] };
}

export function parseDiscordIds(text: string): ParsedIds<string> {
  const all = entries(text);
  const bad = all.filter((s) => !DISCORD_ID.test(s));
  if (bad.length) return refusal(bad, "a Discord user ID (17 to 20 digits)");
  return { ok: true, ids: [...new Set(all)] };
}

/**
 * What the field starts as: the ids the daemon reads, and after them what it
 * ignored, so the owner sees and can correct a bad entry rather than having it
 * silently dropped from the field and then from the list on the next save.
 */
export function allowedFieldText(list: { allowed_users: Array<number | string>; allowed_users_rejected?: string[] } | undefined): string {
  if (!list) return "";
  return [...list.allowed_users.map(String), ...(list.allowed_users_rejected ?? [])].join(", ");
}
