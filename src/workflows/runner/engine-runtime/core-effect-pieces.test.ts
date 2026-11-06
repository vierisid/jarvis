/**
 * #961: the vendored SMTP, GraphQL and FTP/SFTP pieces as the engine runs them
 * -- their compiled `dist/` -- connect only through the egress guard.
 * `http-egress.test.ts` covers the guard itself; this proves each piece is
 * wired to it, so a vendor sync that dropped a patch would fail here.
 *
 * Needs the compiled pieces. Like `core-http-piece.test.ts` it skips without
 * them, and builds them under `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';
import { EGRESS_POLICY_ENV } from '../../runtime/http-egress';

const dir = (name: string) => resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core', name);
const bundle = (name: string) => resolve(dir(name), 'dist/src/index.js');
const NAMES = ['smtp', 'graphql', 'sftp'] as const;
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !NAMES.every((name) => existsSync(bundle(name)));
const require = createRequire(import.meta.url);

type Run = (context: Record<string, unknown>) => Promise<unknown>;
interface LoadedPiece {
  getAction(name: string): { run: Run } | undefined;
  triggers(): Record<string, unknown>;
  auth?: { validate?: (args: { auth: Record<string, unknown> }) => Promise<{ valid: boolean; error?: string }> };
}
const pieces: Record<string, LoadedPiece> = {};
const dns = require('node:dns') as { lookup: (...args: unknown[]) => void };
const realLookup = dns.lookup;
let lookups: string[] = [];

/** Every name resolves to `address`, and each lookup is counted. */
function resolveTo(address: string): void {
  lookups = [];
  dns.lookup = ((host: string, _opts: unknown, cb: (e: null, a: unknown) => void) => {
    lookups.push(host);
    cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
  }) as never;
}

const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '169.254.169.254', '[::1]', '::1'];

describe.skipIf(skip)('the compiled core SMTP, GraphQL and FTP/SFTP pieces', () => {
  beforeAll(async () => {
    for (const name of NAMES) {
      if (buildOptIn) await buildPiece(dir(name));
      const mod = require(bundle(name)) as Record<string, LoadedPiece>;
      pieces[name] = mod[name === 'sftp' ? 'ftpSftp' : name]!;
      expect(pieces[name]).toBeDefined();
    }
  });
  afterEach(() => {
    dns.lookup = realLookup;
    delete process.env[EGRESS_POLICY_ENV];
  });

  const smtpAuth = (host: string) => ({ host, port: 587, TLS: false, email: 'me@example.com', password: 'app-password' });
  const smtpProps = { from: 'me@example.com', to: ['you@example.com'], subject: 's', body_type: 'plain_text', body: 'b', attachments: [] };

  test('SMTP: loopback and metadata are refused by name or literal, under either policy, before any connection', async () => {
    const send = pieces.smtp!.getAction('send-email')!.run;
    for (const policy of [undefined, 'private-allowed']) {
      if (policy) process.env[EGRESS_POLICY_ENV] = policy; else delete process.env[EGRESS_POLICY_ENV];
      for (const host of BLOCKED_HOSTS) {
        await expect(send({ auth: { props: smtpAuth(host) }, propsValue: smtpProps })).rejects.toThrow(/SMTP connection to .* refused/);
      }
    }
  });

  test('SMTP: a mail server that resolves to a private address is refused on a hosted engine, and the name is resolved once', async () => {
    resolveTo('10.20.30.40');
    const send = pieces.smtp!.getAction('send-email')!.run;
    await expect(send({ auth: { props: smtpAuth('mail.internal') }, propsValue: smtpProps })).rejects.toThrow(/reach only public addresses/);
    expect(lookups).toEqual(['mail.internal']);
  });

  test('SMTP: validating a connection to a refused server says so instead of connecting', async () => {
    const result = await pieces.smtp!.auth!.validate!({ auth: smtpAuth('127.0.0.1') });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/SMTP connection to 127\.0\.0\.1 refused/);
  });

  const graphqlProps = (extra: Record<string, unknown> = {}) => ({ method: 'POST', url: 'http://localhost:9/graphql', queryParams: {}, headers: {},
    query: '{ a }', timeout: 3, failsafe: false, ...extra });

  test('GraphQL: loopback and metadata are refused, and "No Error on Failure" does not turn a refusal into output', async () => {
    const send = pieces.graphql!.getAction('send_request')!.run;
    for (const url of ['http://localhost:9/graphql', 'http://127.0.0.1:9/graphql', 'http://169.254.169.254/graphql', 'http://[::1]:9/graphql']) {
      await expect(send({ propsValue: graphqlProps({ url }) })).rejects.toThrow(/refused/);
      await expect(send({ propsValue: graphqlProps({ url, failsafe: true }) })).rejects.toThrow(/refused/);
    }
  });

  test('GraphQL: a name resolving to a private address is refused on a hosted engine, once', async () => {
    resolveTo('192.168.1.20');
    const send = pieces.graphql!.getAction('send_request')!.run;
    await expect(send({ propsValue: graphqlProps({ url: 'http://api.internal/graphql' }) })).rejects.toThrow(/reach only public addresses/);
    expect(lookups).toEqual(['api.internal']);
  });

  test('GraphQL: a proxy is refused rather than used without the check', async () => {
    const send = pieces.graphql!.getAction('send_request')!.run;
    await expect(send({ propsValue: graphqlProps({ url: 'https://api.example.com/graphql', use_proxy: true,
      proxy_settings: { proxy_host: '127.0.0.1', proxy_port: 3128 } }) })).rejects.toThrow(/does not send GraphQL steps through a proxy/);
  });

  const sftpAuth = (protocol: string, host: string) => ({ protocol, host, port: protocol === 'sftp' ? 22 : 21, username: 'u', password: 'p' });

  test('FTP/SFTP: loopback and metadata are refused for every protocol, under either policy', async () => {
    const list = pieces.sftp!.getAction('listFolderContents')!.run;
    for (const policy of [undefined, 'private-allowed']) {
      if (policy) process.env[EGRESS_POLICY_ENV] = policy; else delete process.env[EGRESS_POLICY_ENV];
      for (const protocol of ['sftp', 'ftp', 'ftps']) {
        for (const host of BLOCKED_HOSTS) {
          await expect(list({ auth: { props: sftpAuth(protocol, host) }, propsValue: { directoryPath: '/' } }))
            .rejects.toThrow(new RegExp(`${protocol.toUpperCase()} connection to .* refused`));
        }
      }
    }
  });

  test('FTP/SFTP: a server resolving to a private address is refused on a hosted engine, once', async () => {
    resolveTo('172.16.5.5');
    const list = pieces.sftp!.getAction('listFolderContents')!.run;
    await expect(list({ auth: { props: sftpAuth('sftp', 'files.internal') }, propsValue: { directoryPath: '/' } }))
      .rejects.toThrow(/reach only public addresses/);
    expect(lookups).toEqual(['files.internal']);
  });

  test('FTP/SFTP: the piece exposes no trigger, so its polling trigger cannot run outside the boundary', () => {
    expect(Object.keys(pieces.sftp!.triggers())).toEqual([]);
  });
});
