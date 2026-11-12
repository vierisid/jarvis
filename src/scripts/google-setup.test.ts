import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { savedTokensReport } from './google-setup.ts';

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
    expect(source).toContain('savedTokensReport(tokensPath)');
  });
});
