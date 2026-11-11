import { test, expect } from 'bun:test';
import { governedActionReview } from './governed-review';

test('a piece with no adapter table still lists its scalar fields, primary target first, never auth or headers', () => {
  const review = governedActionReview('unknown-piece', { auth: { token: 'x' }, headers: { A: 'b' }, zeta: 'z', url: 'https://x.test/a', channel: '#ops' })!;
  expect(review.fields).toEqual([{ label: 'URL', value: 'https://x.test/a' }, { label: 'Channel', value: '#ops' }, { label: 'Zeta', value: 'z' }]);
});

test('fields beyond the card limit are counted, and an engine omittedFields count is added', () => {
  const input: Record<string, unknown> = { omittedFields: 3 };
  for (let i = 0; i < 15; i++) input[`field${String(i).padStart(2, '0')}`] = `v${i}`;
  const review = governedActionReview('unknown-piece', input)!;
  expect(review.fields).toHaveLength(12);
  expect(review.more).toBe(3 + 3);
});

test('long text is an excerpt, bidi and format characters are removed, and nothing renders for an empty input', () => {
  const review = governedActionReview('smtp', { to: ['a@example.test'], body: `${'a'.repeat(900)}‮` })!;
  expect(review.fields[1]!.value).toBe(`${'a'.repeat(500)}...`);
  expect(governedActionReview('smtp', {})).toBeNull();
  expect(governedActionReview('smtp', null)).toBeNull();
});
