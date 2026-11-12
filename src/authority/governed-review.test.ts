import { test, expect } from 'bun:test';
import { governedActionReview } from './governed-review';

test('a piece with no adapter table still lists its scalar fields, primary target first, never auth or headers', () => {
  const review = governedActionReview('unknown-piece', { auth: { token: 'x' }, headers: { A: 'b' }, zeta: 'z', url: 'https://x.test/a', channel: '#ops' })!;
  expect(review.fields).toEqual([{ label: 'URL', value: 'https://x.test/a' }, { label: 'Channel', value: '#ops' }, { label: 'Zeta', value: 'z' }]);
});

test('fields beyond the card limit are counted, and the record\'s omittedFields count is added', () => {
  const input: Record<string, unknown> = { omittedFields: 3 };
  for (let i = 0; i < 15; i++) input[`field${String(i).padStart(2, '0')}`] = `v${i}`;
  const review = governedActionReview('unknown-piece', input)!;
  expect(review.fields).toHaveLength(12);
  expect(review.more).toBe(3 + 3);
});

test('a real field spelled like the count marker (escaped by the record, #722) is shown, not counted', () => {
  const review = governedActionReview('unknown-piece', { '~omittedFields': 7, to: 'a@example.test' })!;
  expect(review.more).toBe(0);
  expect(review.fields.map(f => f.value)).toEqual(['a@example.test', '7']);
});

test('a body is a framed excerpt; bidi and format characters are removed; nothing renders for an empty input', () => {
  const review = governedActionReview('smtp', { to: ['a@example.test'], body: `${'a'.repeat(900)}\u202e` })!;
  expect(review.fields[1]).toEqual({ label: 'Body', value: `${'a'.repeat(500)}...`, text: true, cut: true });
  expect(governedActionReview('smtp', { body: 'one\n\n\n\u202etwo\u200b' })!.fields[0]).toEqual({ label: 'Body', value: 'one\n\ntwo', text: true });
  expect(governedActionReview('smtp', {})).toBeNull();
  expect(governedActionReview('smtp', null)).toBeNull();
});

test('a one-line value keeps what follows a line break instead of cutting at it', () => {
  const review = governedActionReview('smtp', { subject: 'Invoice\r\nBcc: attacker@example.test' })!;
  expect(review.fields).toEqual([{ label: 'Subject', value: 'Invoice Bcc: attacker@example.test' }]);
});

test('every recipient the record holds is shown, the last of a long list included', () => {
  const bcc = Array.from({ length: 24 }, (_, i) => `someone-with-a-long-address-${i}@example.test`).concat('attacker@evil.test');
  const review = governedActionReview('smtp', { to: ['a@example.test'], bcc: [...bcc, '[3 more items]'] })!;
  const shown = review.fields.find(f => f.label === 'Bcc')!;
  expect(shown.value).toContain('attacker@evil.test');
  expect(shown.value.endsWith('[3 more items]')).toBe(true);
  expect(shown.cut).toBeUndefined();
});

test('a value the record cut says so, and the record note is shown whole', () => {
  const subject = `${'s'.repeat(512)}... [88 more characters]`;
  expect(governedActionReview('smtp', { subject })!.fields[0]).toEqual({ label: 'Subject', value: subject, cut: true });
});

test('URLs are redacted with the shared HTTP rules whichever piece holds them, and the adapter\'s own redaction runs again', () => {
  const other = governedActionReview('unknown-piece', { webhook_url: 'https://user:pw@hooks.slack.com/services/T0/B0/abcdefSECRET' })!;
  expect(other.fields[0]!.value).toBe('https://[redacted]@hooks.slack.com/services/T0/B0/[redacted]');
  const http = governedActionReview('http', { url: 'https://x.test/a?api_key=live123', queryParams: { api_key: 'live123' } })!;
  expect(JSON.stringify(http)).not.toContain('live123');
});
