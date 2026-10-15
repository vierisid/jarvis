import { describe, expect, test } from 'bun:test';
import { allowedFieldText, parseDiscordIds, parseTelegramIds } from './channel-ids.ts';

/**
 * #883. Save kept whatever `Number()` accepted and dropped the rest silently,
 * so a typo could save an empty list, which lets anyone chat.
 */
describe('#883: the Allowed user IDs field', () => {
  test('a typo refuses to save and names the entry, instead of being dropped', () => {
    expect(parseTelegramIds('12345x')).toEqual({ ok: false, message: 'Not saved: "12345x" is not a Telegram user ID (a positive whole number). Nothing was changed.' });
    expect(parseTelegramIds('42, 1.5, 042')).toEqual({ ok: false, message: 'Not saved: "1.5", "042" are not a Telegram user ID (a positive whole number). Nothing was changed.' });
    expect(parseTelegramIds('9007199254740993')).toMatchObject({ ok: false });
    expect(parseDiscordIds('owner, 123456789012345678')).toEqual({ ok: false, message: 'Not saved: "owner" is not a Discord user ID (17 to 20 digits). Nothing was changed.' });
  });

  test('valid ids parse to what the daemon accepts, and an empty field is an empty list', () => {
    expect(parseTelegramIds(' 42 , 7,42 ')).toEqual({ ok: true, ids: [42, 7] });
    expect(parseDiscordIds('123456789012345678')).toEqual({ ok: true, ids: ['123456789012345678'] });
    expect(parseTelegramIds('')).toEqual({ ok: true, ids: [] });
  });

  test('the field shows what the daemon ignored, so a re-save does not quietly drop it', () => {
    expect(allowedFieldText({ allowed_users: [42], allowed_users_rejected: ['042'] })).toBe('42, 042');
    expect(allowedFieldText({ allowed_users: [42] })).toBe('42');
    expect(allowedFieldText(undefined)).toBe('');
  });
});
