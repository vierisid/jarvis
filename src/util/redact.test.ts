import { describe, expect, test } from 'bun:test';
import { redactSecrets } from './redact.ts';

describe('redactSecrets', () => {
  test('consumes a real-shaped hosted key WHOLE (no surviving suffix)', () => {
    // The platform mints sk-uj-<base64url(24 bytes)> — base64url's charset is
    // exactly [A-Za-z0-9_-], so a partial match would leak the tail.
    const key = `sk-uj-${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')}`;
    const out = redactSecrets(`Authentication Error: bearer ${key} rejected`);
    expect(out).not.toContain(key);
    expect(out).not.toContain(key.slice(-8));
    expect(out).toContain('***redacted***');
  });

  test('covers the upstream prefixes a proxied auth failure can echo', () => {
    const text = [
      'sk-ant-api03-abcdefghijklmnop',
      'gsk_abcdefghijklmnopqrstuvwx',
      'AIzaSyA1234567890abcdefghij',
      'xai-abcdefghijklmnop',
    ].join(' ');
    const out = redactSecrets(text);
    for (const frag of ['ant-api03', 'gsk_abc', 'AIzaSy', 'xai-abc']) expect(out).not.toContain(frag);
  });

  test('leaves ordinary text alone (no mangling of model ids or prose)', () => {
    const text = 'model uj-chat is not included in your plan (sk is not a prefix here)';
    expect(redactSecrets(text)).toBe(text);
  });

  test('Basic auth values are consumed, labelled or bare (pr2 review #8)', () => {
    const b64 = Buffer.from('user:sk_uj-secret-material').toString('base64');
    expect(redactSecrets(`Authorization: Basic ${b64}`)).not.toContain(b64);
    expect(redactSecrets(`rejected credential Basic ${b64} at proxy`)).not.toContain(b64);
  });

  test('bare unlabelled JWTs are consumed (pr2 review #8)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redactSecrets(`upstream said: ${jwt} expired`);
    expect(out).not.toContain(jwt.split('.')[1]);
    expect(out).toContain('***redacted***');
  });
});
