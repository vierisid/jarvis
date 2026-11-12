import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALLBACK_HOSTNAME,
  echoForHtml,
  echoForTerminal,
  handleOAuthCallback,
  savedTokensReport,
  type CallbackDeps,
} from './google-setup.ts';

describe('google-setup token output', () => {
  test('says the tokens were saved and where', () => {
    const lines = savedTokensReport('/home/someone/.jarvis/google-tokens.json');
    expect(lines.join('\n')).toContain('saved to /home/someone/.jarvis/google-tokens.json');
  });

  // The script's success path runs a live OAuth exchange, so what it prints is
  // pinned at the source: it has no reason to touch a token's fields at all
  // now. It printed the first 20 characters of both tokens before.
  test('never reads a token field, so it cannot print one', () => {
    const source = readFileSync(join(import.meta.dir, 'google-setup.ts'), 'utf-8');
    expect(source).not.toMatch(/access_token|refresh_token|id_token/);
    expect(source).toContain('savedTokensReport(deps.tokensPath)');
  });
});

const STATE = 'the-real-state';
const CALLBACK = 'http://127.0.0.1:3142/api/auth/google/callback';

function harness(exchange: CallbackDeps['exchange'] = async () => {}) {
  const calls = { consumed: [] as string[], exchanged: [] as string[], finished: [] as number[], log: [] as string[], error: [] as string[] };
  let pending = true;
  const deps: CallbackDeps = {
    tokensPath: '/home/someone/.jarvis/google-tokens.json',
    consume: (state) => {
      calls.consumed.push(state);
      if (state !== STATE || !pending) return null;
      pending = false;
      return { codeVerifier: 'verifier' };
    },
    exchange: async (code, verifier) => { calls.exchanged.push(`${code}:${verifier}`); await exchange(code, verifier); },
    finish: (code) => { calls.finished.push(code); },
    log: (line) => { calls.log.push(line); },
    error: (line) => { calls.error.push(line); },
  };
  return { deps, calls };
}

const at = (query: string) => new URL(`${CALLBACK}?${query}`);

describe('google-setup callback server', () => {
  test('binds loopback only', () => {
    expect(CALLBACK_HOSTNAME).toBe('127.0.0.1');
    const source = readFileSync(join(import.meta.dir, 'google-setup.ts'), 'utf-8');
    expect(source).toMatch(/Bun\.serve\(\{\s*hostname: CALLBACK_HOSTNAME,/);
  });

  test('an ?error= without the flow state neither ends the setup nor is echoed', async () => {
    const { deps, calls } = harness();
    for (const query of ['error=access_denied', 'error=x&state=forged']) {
      const response = await handleOAuthCallback(at(query), deps);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid or expired OAuth state');
    }
    expect(calls.finished).toEqual([]);
    expect(calls.error).toEqual([]);

    // The real redirect still completes afterwards.
    const ok = await handleOAuthCallback(at(`code=c&state=${STATE}`), deps);
    expect(ok.status).toBe(200);
    expect(calls.finished).toEqual([0]);
  });

  test('a denial with the right state ends the setup, echoed escaped and without control characters', async () => {
    const { deps, calls } = harness();
    const error = '<script>alert(1)</script>\u001b[2J\nFAKE: tokens saved';
    const response = await handleOAuthCallback(at(`error=${encodeURIComponent(error)}&state=${STATE}`), deps);
    const html = await response.text();

    expect(calls.finished).toEqual([1]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('\u001b');
    expect(calls.error).toEqual(['Authorization denied: <script>alert(1)</script>[2JFAKE: tokens saved']);
    expect(calls.exchanged).toEqual([]);
  });

  test('a code is exchanged only with the flow state, once', async () => {
    const { deps, calls } = harness();
    expect((await handleOAuthCallback(at('code=c'), deps)).status).toBe(400);
    expect((await handleOAuthCallback(at('code=c&state=forged'), deps)).status).toBe(400);
    expect(calls.exchanged).toEqual([]);

    const response = await handleOAuthCallback(at(`code=c&state=${STATE}`), deps);
    expect(response.status).toBe(200);
    expect(calls.exchanged).toEqual(['c:verifier']);
    expect(calls.log.join('\n')).toContain('saved to /home/someone/.jarvis/google-tokens.json');

    expect((await handleOAuthCallback(at(`code=c&state=${STATE}`), deps)).status).toBe(400);
    expect(calls.exchanged).toEqual(['c:verifier']);
  });

  test('a failed exchange echoes the provider text escaped', async () => {
    const { deps, calls } = harness(async () => { throw new Error('Token exchange failed: <img src=x onerror=alert(1)>\u0007'); });
    const response = await handleOAuthCallback(at(`code=c&state=${STATE}`), deps);
    const html = await response.text();

    expect(response.status).toBe(500);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('\u0007');
    expect(calls.finished).toEqual([1]);
    expect(calls.error[0]).not.toContain('\u0007');
  });

  test('other paths are not found', async () => {
    const { deps, calls } = harness();
    expect((await handleOAuthCallback(new URL('http://127.0.0.1:3142/?state=x'), deps)).status).toBe(404);
    expect(calls.consumed).toEqual([]);
  });
});

describe('echo helpers', () => {
  test('strip C0 and C1 controls and DEL, and escape HTML', () => {
    expect(echoForTerminal('a\u0000b\u001b[31mc\u007fd\u009be\r\nf')).toBe('ab[31mcdef');
    expect(echoForHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  test('cap what they echo', () => {
    expect(echoForTerminal('x'.repeat(5000)).length).toBe(2000);
  });
});

// The prompt is interactive, so it is pinned at the source: the secret is read
// through the muted prompt, never through readline's echoing question().
test('the client secret is read without echo', () => {
  const source = readFileSync(join(import.meta.dir, 'google-setup.ts'), 'utf-8');
  expect(source).toMatch(/clientSecret = \(await askHidden\(/);
  expect(source).not.toMatch(/clientSecret = \(await ask\(/);
});
