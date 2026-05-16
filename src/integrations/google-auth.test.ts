import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from './google-auth.ts';

describe('GoogleAuth token storage', () => {
  test('saves OAuth tokens with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-auth-'));
    const tokensPath = join(dir, 'google-tokens.json');
    const auth = new GoogleAuth('client-id', 'client-secret', { tokensPath });

    await auth.saveTokens({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() + 60_000,
      token_type: 'Bearer',
    });

    expect(existsSync(tokensPath)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(tokensPath).mode & 0o777).toBe(0o600);
  });

  test('does not chmod cwd for bare relative token paths', async () => {
    const originalCwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-google-auth-cwd-'));
    await chmod(dir, 0o755);

    try {
      process.chdir(dir);
      const auth = new GoogleAuth('client-id', 'client-secret', {
        tokensPath: 'google-tokens.json',
      });

      await auth.saveTokens({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() + 60_000,
        token_type: 'Bearer',
      });

      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(statSync(join(dir, 'google-tokens.json')).mode & 0o777).toBe(0o600);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
