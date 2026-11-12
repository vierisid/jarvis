import { describe, expect, test } from 'bun:test';
import { findNewSecretLiterals, findSecretLiterals, redactSecretLiterals, redactSecretText, secretLiteralFeedback, secretLiteralWarnings } from './secret-literals';

const step = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ name, type: 'PIECE', settings: { pieceName: '@x/piece-y', actionName: 'send', input }, ...extra });
const graph = (...inputs: Array<[string, Record<string, unknown>]>) => {
  const [first, ...rest] = inputs;
  const build = (i: number): unknown => i >= rest.length ? undefined : { ...step(rest[i]![0], rest[i]![1]), nextAction: build(i + 1) };
  return { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: first![1] }, nextAction: build(0) };
};

describe('secret-shaped literals are found', () => {
  const canary = 'sk-qa4-canary-SECRET-9911';
  test('the key that was published in a notify message', () => {
    const found = findSecretLiterals(graph(['t', {}], ['notify', { message: `token ${canary} and more` }]));
    expect(found).toEqual([{ path: 'step "notify" settings.input.message', kind: 'an API key' }]);
    expect(JSON.stringify(found)).not.toContain(canary);
  });

  for (const [name, value] of [
    ['an Anthropic key', 'sk-ant-api03-AbCdEf0123456789abcdefXYZ'],
    ['a GitHub token', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
    ['an AWS access key', 'AKIAQ3EGTUV7WXYZ2ABC'],
    ['a Slack token', 'xoxb-1234567890-abcdefghij'],
    ['a Stripe key', 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
    ['a bearer token', 'Bearer a8Fk29sLq0Zr7TnV4bXc1Wd5'],
    ['a password in a URL', 'https://admin:hunter2pass@db.example.com/x'],
  ] as const) {
    test(`${name}, wherever it sits in a string`, () => {
      expect(findSecretLiterals(graph(['t', {}], ['s', { body: `prefix ${value} suffix` }]))).toHaveLength(1);
    });
  }

  test('a long random value in a field that is named like a credential', () => {
    const found = findSecretLiterals(graph(['t', {}], ['call', { apiKey: 'Zk93Lq0TnV4bXc1Wd5Fk29sLr7' }]));
    expect(found).toEqual([{ path: 'step "call" settings.input.apiKey', kind: 'a secret typed into a credential field' }]);
    expect(findSecretLiterals(graph(['t', {}], ['call', { headers: { Authorization: 'Zk93Lq0TnV4bXc1Wd5Fk29sLr7' } }]))).toHaveLength(1);
  });

  test('a secret next to an expression is still a literal, and a branch step is named', () => {
    const tree = { name: 'trigger', type: 'PIECE_TRIGGER', settings: {}, nextAction: { name: 'route', type: 'ROUTER', settings: {}, children: [
      step('inside', { message: `{{trigger.body.name}} ${canary}` }) ] } };
    expect(findSecretLiterals(tree)[0]!.path).toContain('step "inside"');
  });
});

describe('normal workflows are left alone', () => {
  test.each([
    ['plain messages', { message: 'Your invoice is ready. Task force sk-learn is not a key.' }],
    ['words that merely contain sk', { message: 'risk-assessment-framework-2026 and desk-organization-plan-2026-final' }],
    ['a reference to a connection', { auth: "{{connections['gmail']}}", message: 'Hello' }],
    ['an expression in a credential field', { apiKey: '{{trigger.body.apiKey}}', token: "{{connections['x'].value}}" }],
    ['a long id in a field not named like a credential', { flowId: 'ZlsMhRLU0AK5y7hPdyZkc3', uuid: '0f8fad5b-d9cb-469f-a165-70867728950e' }],
    ['a credential field holding a short or plain word', { password: 'changeme', token: 'abc', secret: 'the-shared-meeting-room-code' }],
    ['a URL without a password', { url: 'https://user@example.com/path?x=1', link: 'https://example.com:8080/a' }],
    ['a bearer word in prose', { message: 'Bearer of bad news: the meeting moved to Thursday afternoon' }],
    ['an email and a phone number', { to: 'ana.rossi@example.com', phone: '+39 333 123 4567' }],
    ['a sentence under a field called token', { token: 'this is a sentence that is quite long indeed' }],
    ['documentation placeholders', { message: 'Set AKIAIOSFODNN7EXAMPLE and sk-your-key-here-123456', apiKey: 'YOUR_API_KEY_HERE_0123456789' }],
    ['the markers a redacted value reads as', { token: '[redacted]', message: 'Bearer [secret removed]' }],
  ])('%s', (_name, input) => {
    expect(findSecretLiterals(graph(['t', {}], ['s', input as Record<string, unknown>]))).toEqual([]);
  });
});

describe('what is kept in composition history', () => {
  const canary = 'sk-qa4-canary-SECRET-9911';
  test('text and graphs lose the secret and keep everything else', () => {
    expect(redactSecretText(`please use ${canary} now`)).toBe('please use [secret removed] now');
    const cleaned = redactSecretLiterals(graph(['t', {}], ['s', { message: `k ${canary}`, apiKey: 'Zk93Lq0TnV4bXc1Wd5Fk29sLr7', to: 'ana@example.com' }]));
    expect(JSON.stringify(cleaned)).not.toContain(canary);
    expect(JSON.stringify(cleaned)).not.toContain('Zk93Lq0TnV4bXc1Wd5Fk29sLr7');
    expect(JSON.stringify(cleaned)).toContain('ana@example.com');
  });
  test('a raw reply loses a value in a field named like a credential, and keeps references and plain values', () => {
    const raw = 'Here: {"apiKey": "Zk93Lq0TnV4bXc1Wd5Fk29sLr7", "token": "{{connections.x}}", "password": "changeme", "flowId": "ZlsMhRLU0AK5y7hPdyZkc3"}';
    expect(redactSecretText(raw)).toBe('Here: {"apiKey": "[secret removed]", "token": "{{connections.x}}", "password": "changeme", "flowId": "ZlsMhRLU0AK5y7hPdyZkc3"}');
  });
  test('feedback says where and what to do, never the value', () => {
    const lines = secretLiteralFeedback(findSecretLiterals(graph(['t', {}], ['notify', { message: canary }])));
    expect(lines[0]).toContain('step "notify" settings.input.message');
    expect(lines[0]).toContain('use a connection');
    expect(lines.join('')).not.toContain(canary);
  });
});

describe('designed secrets, positions and cost', () => {
  const webhook = (secret: string) => ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: { secret, signature_scheme: 'timestamped' } } });
  test('the Webhook trigger signing secret is not refused or warned about, but stays out of history', () => {
    const secret = 'q8Zr2Lk9Vb4Nx7Wm1Pt6Yh3Jc5Df0Gs8';
    expect(findSecretLiterals(webhook(secret))).toEqual([]);
    expect(findSecretLiterals({ displayName: 'Hook', trigger: webhook(secret) })).toEqual([]);
    expect(secretLiteralWarnings(webhook(secret))).toEqual([]);
    expect(JSON.stringify(redactSecretLiterals(webhook(secret)))).not.toContain(secret);
    // Only the webhook piece's own field: a `secret` field on another step is still one.
    expect(findSecretLiterals(graph(['t', {}], ['s', { secret }]))).toHaveLength(1);
  });
  test('a real key next to a placeholder is still found', () => {
    expect(findSecretLiterals(graph(['t', {}], ['s', { message: 'AKIAIOSFODNN7EXAMPLE then AKIAQ3EGTUV7WXYZ2ABC' }]))).toHaveLength(1);
  });
  test('an input object with name and type keys is not taken for a step', () => {
    const found = findSecretLiterals(graph(['t', {}], ['call', { field: { name: 'x', type: 'text', apiKey: 'Zk93Lq0TnV4bXc1Wd5Fk29sLr7' } }]));
    expect(found).toEqual([{ path: 'step "call" settings.input.field.apiKey', kind: 'a secret typed into a credential field' }]);
  });
  test('a composed plan names its steps under the trigger', () => {
    const plan = { displayName: 'p', trigger: graph(['t', {}], ['notify', { message: 'sk-qa4-canary-SECRET-9911' }]) };
    expect(findSecretLiterals(plan)[0]!.path).toBe('step "notify" settings.input.message');
  });
  test('an edit is judged on what it adds', () => {
    const key = 'sk-qa4-canary-SECRET-9911';
    const saved = graph(['t', {}], ['s', { message: key }]);
    expect(findNewSecretLiterals(saved, graph(['t', {}], ['renamed', { message: key }]))).toEqual([]);
    expect(findNewSecretLiterals(saved, graph(['t', {}], ['s', { message: key, body: 'sk-ant-api03-AbCdEf0123456789abcdefXYZ' }]))).toHaveLength(1);
  });
  test('a long dotted or repeated string is scanned in linear time', () => {
    const start = performance.now();
    findSecretLiterals(graph(['t', {}], ['s', { a: 'a.'.repeat(200_000), b: 'sk-'.repeat(100_000) }]));
    redactSecretText('a.'.repeat(200_000) + '"'.repeat(100_000));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
