import { describe, expect, test } from 'bun:test';
import { discordAllowList, isDiscordSnowflake, telegramAllowList } from './allow-list.ts';

/**
 * #883. `allowed_users` reached the adapters in any shape, and `.includes` on
 * a string is a substring test.
 */
describe('#883: telegramAllowList', () => {
  test('absent or empty does not restrict, and has nothing to report', () => {
    for (const raw of [undefined, null, []]) {
      expect(telegramAllowList(raw)).toEqual({ ids: [], restricted: false, problems: [], rejected: [] });
    }
  });

  test('a list of user ids is read as it is, duplicates once', () => {
    expect(telegramAllowList([42, 7, 42])).toEqual({ ids: [42, 7], restricted: true, problems: [], rejected: [] });
  });

  test('a string restricts the channel to nobody instead of matching substrings, and says so', () => {
    const list = telegramAllowList('12345');
    expect(list.ids).toEqual([]);
    expect(list.restricted).toBe(true);
    expect(list.rejected).toEqual(['12345']);
    expect(list.problems).toEqual(['allowed_users must be a list of IDs, but it is "12345". Nobody may use the channel until it is fixed.']);
  });

  test('entries that name nobody are ignored with a reason, and the rest still count', () => {
    const list = telegramAllowList([42, '042', 1.5, -1001234, 2 ** 60, true]);
    expect(list.ids).toEqual([42]);
    expect(list.restricted).toBe(true);
    expect(list.rejected).toEqual(['042', '1.5', '-1001234', String(2 ** 60), 'true']);
    expect(list.problems).toHaveLength(5);
    expect(list.problems[0]).toBe('"042" is ignored: a Telegram ID is a number; write it without quotes or leading zeros.');
    expect(list.problems[1]).toBe('1.5 is ignored: a Telegram ID is a whole number.');
    expect(list.problems[2]).toContain('a negative ID is a group or channel');
    expect(list.problems[3]).toContain('too large');
  });

  test('a list made only of bad entries still restricts: it never fails open', () => {
    expect(telegramAllowList(['042'])).toMatchObject({ ids: [], restricted: true });
  });
});

describe('#883: discordAllowList', () => {
  test('snowflake strings are ids', () => {
    expect(discordAllowList(['123456789012345678'])).toEqual({ ids: ['123456789012345678'], restricted: true, problems: [], rejected: [] });
  });

  test('a YAML number has lost its last digits, so it is ignored and named', () => {
    // What `allowed_users: [123456789012345678]` parses to.
    const list = discordAllowList([123456789012345678]);
    expect(list.ids).toEqual([]);
    expect(list.restricted).toBe(true);
    expect(list.rejected).toEqual(['123456789012345680']);
    expect(list.problems[0]).toContain('loses its last digits');
  });

  test('a string is not a list, and a short or padded id is not a snowflake', () => {
    expect(discordAllowList('123456789012345678')).toMatchObject({ ids: [], restricted: true });
    expect(discordAllowList(['u1', '0123456789012345678', '12345'])).toMatchObject({ ids: [], restricted: true });
  });

  test('isDiscordSnowflake bounds the value to 64 bits', () => {
    expect(isDiscordSnowflake('18446744073709551615')).toBe(true);
    expect(isDiscordSnowflake('18446744073709551616')).toBe(false);
    expect(isDiscordSnowflake('10000000000000000')).toBe(true);
    expect(isDiscordSnowflake('1000000000000000')).toBe(false);
  });
});
