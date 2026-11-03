import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTED_CONNECTION_PROVIDERS, connectionProviderForPiece, isHostedConnectionProvider } from './connection-providers';
import { JARVIS_GOOGLE_PIECES } from '../workflows/credentials/google-source';

const hosted = Object.keys(HOSTED_CONNECTION_PROVIDERS).sort();
test('every implemented provider status has a public setup mapping', () => {
  const providers = readdirSync(import.meta.dir).filter(name => name.endsWith('-connection.ts'))
    .filter(name => /export function \w+Status\(/.test(readFileSync(join(import.meta.dir, name), 'utf8')))
    .map(name => name.replace('-connection.ts', '')).sort();
  expect(hosted).toEqual(providers);
  for (const id of providers) {
    if (!isHostedConnectionProvider(id)) throw new Error(`Missing provider mapping: ${id}`);
    expect(connectionProviderForPiece(`@activepieces/piece-${id}`)).toBe(id);
  }
});
test('the mapping matches the managed credential sources and their pieces', () => {
  const dir = join(import.meta.dir, '../workflows/credentials');
  const sources = readdirSync(dir).filter(name => name.endsWith('-source.ts')).map(name => {
    const text = readFileSync(join(dir, name), 'utf8');
    return { id: /readonly id ?= ?"([\w-]+)"/.exec(text)?.[1], text };
  }).filter(s => s.id && s.id !== 'google' && s.id !== 'telegram');
  expect(sources.map(s => s.id).sort()).toEqual(hosted);
  for (const id of hosted) {
    const piece = new RegExp(`_PIECE = "(@activepieces/piece-[\\w-]+)"`).exec(readFileSync(join(import.meta.dir, `${id}-connection.ts`), 'utf8'))?.[1];
    expect(piece ? connectionProviderForPiece(piece) as string | null : undefined).toBe(id);
  }
});
test('the daemon registers every provider status for the connected workspace', () => {
  const daemon = readFileSync(join(import.meta.dir, '../daemon/index.ts'), 'utf8');
  const block = /new ConnectedWorkspace\(getDb\(\), \{([\s\S]*?)\n    \}\);/.exec(daemon)?.[1] ?? '';
  const registered = [...block.matchAll(/^\s+(\w+): \(\) => \w+Status\(jarvisConfig\),$/gm)].map(m => m[1]).sort();
  expect(registered).toEqual(hosted);
});
test('Google workflow pieces keep manual setup: the Jarvis Google grant is read-only Gmail and Calendar', () => {
  for (const name of JARVIS_GOOGLE_PIECES) expect(connectionProviderForPiece(name)).toBeNull();
  expect(connectionProviderForPiece('@activepieces/piece-google-docs')).toBeNull();
  expect(connectionProviderForPiece('@other/piece-clickup')).toBeNull();
});
