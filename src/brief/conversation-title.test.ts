import { expect, test } from 'bun:test';
import { conversationTitle } from './conversation-title';

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
