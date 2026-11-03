import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTED_CONNECTION_PROVIDERS, connectionProviderForPiece, isHostedConnectionProvider } from './connection-providers';
import { JARVIS_GOOGLE_PIECES } from '../workflows/credentials/google-source';

test('every implemented provider status has a public setup mapping', () => {
  const providers = readdirSync(import.meta.dir).filter(name => name.endsWith('-connection.ts'))
    .filter(name => /export function \w+Status\(/.test(readFileSync(join(import.meta.dir, name), 'utf8')))
    .map(name => name.replace('-connection.ts', '')).sort();
  expect(Object.keys(HOSTED_CONNECTION_PROVIDERS).sort()).toEqual(providers);
  for (const id of providers) {
    if (!isHostedConnectionProvider(id)) throw new Error(`Missing provider mapping: ${id}`);
    expect(connectionProviderForPiece(`@activepieces/piece-${id}`)).toBe(id);
  }
});
test('Google setup maps only the workflow pieces allowed by its credential source', () => {
  for (const name of JARVIS_GOOGLE_PIECES) expect(connectionProviderForPiece(name)).toBe('google');
  expect(connectionProviderForPiece('@activepieces/piece-google-docs')).toBeNull();
  expect(connectionProviderForPiece('@other/piece-clickup')).toBeNull();
});
