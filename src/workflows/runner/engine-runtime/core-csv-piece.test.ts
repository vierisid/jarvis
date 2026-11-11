/**
 * The vendored CSV piece as the engine runs it (its compiled `dist/`): JSON to
 * CSV keeps a column that only a later row has. Skips without a compiled piece;
 * CI builds it because its bun test run sets `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';

const pieceDir = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/csv');
const bundle = resolve(pieceDir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(bundle);
const require = createRequire(import.meta.url);

type Run = (context: { propsValue: Record<string, unknown> }) => Promise<unknown>;
let run: Run;

describe.skipIf(skip)('the compiled core CSV piece, JSON to CSV', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(pieceDir);
    const mod = require(bundle) as { csv: { getAction(name: string): { run: Run } | undefined } };
    run = mod.csv.getAction('convert_json_to_csv')!.run;
  });
  const convert = (json_array: unknown, delimiter_type = ',') => run({ propsValue: { json_array, delimiter_type } });

  test('the header is the union of keys in first-seen order, a missing cell is empty and quoting holds', async () => {
    expect(await convert([{ a: 1, b: 'x,y' }, { a: 2, c: 'q"uote' }])).toBe('a,b,c\n1,"x,y",\n2,,"q""uote"\n');
  });

  test('a key only the last row has still gets a column, and a tab delimiter is kept', async () => {
    expect(await convert([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }], '\t')).toBe('a\tb\tc\n1\t\t\n\t2\t\n3\t\t4\n');
  });

  test('nested objects and arrays are flattened as before', async () => {
    expect(await convert([{ n: 'John', address: { city: 'LA' }, tags: ['x', 'y'] }, { n: 'Jane', address: { city: 'SF' }, tags: ['z'] }]))
      .toBe('n,address.city,tags.0,tags.1\nJohn,LA,x,y\nJane,SF,z,\n');
  });

  test('a cell is read as the row\'s own key, never as a path into another of its values', async () => {
    // `tags.0` from the second row must not read "f" out of the first row's string `tags`.
    expect(await convert([{ tags: 'foo' }, { tags: ['x', 'y'] }])).toBe('tags,tags.0,tags.1\nfoo,,\n,x,y\n');
    expect(await convert([{ tags: ['x'] }, { tags: 'foo' }])).toBe('tags.0,tags\nx,\n,foo\n');
  });

  test('a key named like an Object.prototype member gets a column and does not fail the step', async () => {
    expect(await convert([{ a: 1 }, { toString: 'x', constructor: 'y' }])).toBe('a,toString,constructor\n1,,\n,x,y\n');
  });

  test('rows with no keys and a non-object row behave as before', async () => {
    expect(await convert([{}, {}])).toBe('\n\n\n');
    await expect(convert([{ a: 1 }, 5])).rejects.toThrow('Invalid Record');
  });

  test('an empty array and a non-array input behave as before', async () => {
    expect(await convert([])).toBe('');
    await expect(convert({ a: 1 })).rejects.toThrow('The input should be a JSON array');
  });
});
