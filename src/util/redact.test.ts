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

  // The shapes below reached the redactor untouched until this became the
  // filter in front of the log file (src/util/log-file.ts). A log file is a
  // durable artifact an operator hands around, so "no call site demonstrably
  // logs one today" is not good enough for any of them.
  test('Telegram bot tokens, with and without the `bot` path prefix', () => {
    // The exact shape src/comms/channels/telegram.ts puts in EVERY request
    // URL, so anything that logs a failing URL logs the token.
    const token = '7123456789:AAHfK3n2xYz-QwErTyUiOpAsDfGhJkLzXcV';
    const url = redactSecrets(`GET https://api.telegram.org/bot${token}/getMe failed`);
    expect(url).not.toContain('AAHfK3n2xYz');
    expect(url).toContain('***redacted***');
    expect(url).toContain('api.telegram.org');
    expect(redactSecrets(`configured bot ${token}`)).not.toContain('AAHfK3n2xYz');
  });

  test('GitHub tokens, classic and fine-grained', () => {
    const classic = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB';
    const pat = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    expect(redactSecrets(`gh auth ${classic}`)).not.toContain('AbCdEfGh');
    // `github_pat_` must not be left behind by the short-prefix pattern.
    const out = redactSecrets(`using ${pat}`);
    expect(out).not.toContain('abcdefghij');
    expect(out).not.toContain('github_pat_11');
  });

  test('labelled key=value / key: value secrets keep the label, lose the value', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['GET /cb?token=Zk9vQmFyQmF6UXV4MTIzNDU2Nzg5MA&state=x', 'Zk9vQmFyQmF6'],
      ['refresh_token=1//0gAbCdEfGhIjKlMnOpQrStUvWxYz', '0gAbCdEfGh'],
      ['google client_secret: GOCSPX-AbCdEfGhIjKlMnOpQrStUvWxYz', 'GOCSPX-AbCd'],
      ['postgres connect password=SuperSecretPassw0rd', 'SuperSecretPassw0rd'],
    ];
    for (const [text, secret] of cases) {
      const out = redactSecrets(text);
      expect(out).not.toContain(secret);
      expect(out).toContain('***redacted***');
    }
    // The label survives, so the line still says what failed.
    expect(redactSecrets('client_secret: GOCSPX-AbCdEfGhIjKlMnOpQrStUvWxYz')).toContain('client_secret');
  });

  test('credentials in a URL userinfo, and a Cookie header end to end', () => {
    const url = redactSecrets('fetch https://dbuser:hunter2hunter2@db.example.com/health');
    expect(url).not.toContain('hunter2');
    expect(url).toContain('db.example.com');
    const cookie = redactSecrets('Cookie: session=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789; theme=dark');
    expect(cookie).not.toContain('AbCdEfGh');
    expect(cookie).toContain('Cookie:');
  });

  test('webhook signing secrets', () => {
    const out = redactSecrets('verify against whsec_AbCdEfGhIjKlMnOpQrStUvWxYz0123');
    expect(out).not.toContain('AbCdEfGh');
    expect(out).toContain('***redacted***');
  });

  test('the widened patterns still leave ordinary URLs and prose alone', () => {
    // A plain https URL with a port looks like `scheme://host:port` - the
    // userinfo pattern must not read that as user:password.
    for (const text of [
      'GET https://api.example.com:8443/v1/models returned 502',
      'no cookie: found in the response',
      'bot 7 is not a token',
      'model uj-chat is not included in your plan (sk is not a prefix here)',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});
