import { expect, test } from 'bun:test';
import { channelThreadTitle, conversationTitle } from './conversation-title';

test('an empty or whitespace-only first message keeps the default title', () => {
  for (const text of ['', '   ', '\n\t', '\u0000\u001f\u007f']) expect(conversationTitle(text)).toBe('New chat');
});
test('control characters and runs of whitespace collapse to single spaces', () => {
  expect(conversationTitle('plan\nthe\u0000launch\t\tdate')).toBe('Plan the launch date');
});
test('a polite request prefix is dropped and the topic is capitalised', () => {
  expect(conversationTitle('can you tell me a cool fact')).toBe('A cool fact');
  expect(conversationTitle('Please could you help me with my taxes?')).toBe('My taxes');
  expect(conversationTitle("I'd like to book a table.")).toBe('Book a table');
  // A prefix with nothing after it is not stripped to an empty title.
  expect(conversationTitle('tell me')).toBe('Tell me');
});
test('trailing sentence punctuation is dropped from a short topic', () => {
  expect(conversationTitle('what is the weather?!')).toBe('What is the weather');
});
test('a long topic is cut at a word boundary within 60 characters', () => {
  const title = conversationTitle('Plan our autumn launch ' + 'alongside everyone '.repeat(10));
  expect(title).toBe('Plan our autumn launch alongside everyone alongside\u2026');
  expect(title.length).toBeLessThanOrEqual(60);
  expect(conversationTitle('x'.repeat(100))).toBe('X' + 'x'.repeat(56) + '\u2026');
});
test('a topic of 61 characters is shortened', () => {
  expect(conversationTitle('a'.repeat(61))).toBe('A' + 'a'.repeat(56) + '\u2026');
});
test('a topic of exactly 60 characters is kept whole', () => {
  const text = 'a'.repeat(60);
  expect(conversationTitle(text)).toBe('A' + 'a'.repeat(59));
});

// #1313 follow-up: Telegram and Discord threads were all "Chat history".
test('a guest thread is titled with its channel and sender name', () => {
  expect(channelThreadTitle('telegram', 'alice_b', 'guest')).toBe('Telegram guest - alice_b');
  expect(channelThreadTitle('discord', 'Bob', 'guest')).toBe('Discord guest - Bob');
});
test('the owner\'s threads are named by role, so no chosen name can pass for them', () => {
  expect(channelThreadTitle('telegram', 'kuroi', 'owner')).toBe('Telegram - you');
  expect(channelThreadTitle('telegram', 'kuroi', 'shared')).toBe('Telegram group - you');
  // A guest who copies the owner's name, or the owner's whole title, still reads as a guest.
  for (const name of ['kuroi', 'you', 'Telegram - you']) expect(channelThreadTitle('telegram', name, 'guest')!.startsWith('Telegram guest - ')).toBe(true);
});
test('a sender name is untrusted: format, control and invisible characters go, marks do not stack, and it is capped', () => {
  // A right-to-left override would reorder what follows it in the tab strip.
  expect(channelThreadTitle('telegram', `ali\u202Ece\u0000\n\u200Bx`, 'guest')).toBe('Telegram guest - alice x');
  expect(channelThreadTitle('telegram', 'x'.repeat(500), 'guest')).toBe(`Telegram guest - ${'x'.repeat(40)}...`);
  expect(channelThreadTitle('telegram', `a${'\u0301'.repeat(60)}b`, 'guest')).toBe('Telegram guest - \u00E1\u0301\u0301b'); // NFKC composes the first mark; two more at most stay
  expect(channelThreadTitle('telegram', '\uFF41\uFF4C\uFF49', 'guest')).toBe('Telegram guest - ali');
  expect(channelThreadTitle('telegram', '<img src=x onerror=alert(1)>', 'guest')).toBe('Telegram guest - <img src=x onerror=alert(1)>');
});
test('no visible name, or a channel without a label, keeps the default title', () => {
  for (const name of ['', '   ', '\u202E\u200B', '\u3164\u2800\u115F', '\u0301\u0301', undefined, 42, null]) {
    expect(channelThreadTitle('telegram', name, 'guest')).toBeUndefined();
  }
  expect(channelThreadTitle('websocket', 'alice', 'guest')).toBeUndefined();
  expect(channelThreadTitle('websocket', 'alice', 'owner')).toBeUndefined();
});
