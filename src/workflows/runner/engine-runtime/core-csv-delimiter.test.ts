/**
 * F-05: the CSV piece's own "Tab" delimiter option is the value "\t". Readiness
 * used to read that whitespace-only choice as an empty required input, so a
 * flow that picked Tab could not be published. This proves, on the compiled
 * piece, that the declared choice is ready and that a tab-delimited CSV converts.
 *
 * Needs the compiled piece. Like the other engine suites it skips without one,
 * and CI builds it because its bun test run sets `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';
import { PieceCatalog, propsToInputSchema } from '../../runtime/piece-catalog';
import { compileWorkflow } from '../../runtime/workflow-readiness';

const pieceDir = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/csv');
const bundle = resolve(pieceDir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(bundle);
const require = createRequire(import.meta.url);

type Action = { props: Record<string, never>; run: (context: { propsValue: Record<string, unknown> }) => Promise<unknown> };
let action: Action;

const flow = (delimiter: string): any => ({
  name: 'trigger', type: 'EMPTY',
  nextAction: { name: 'step_1', type: 'PIECE', settings: { pieceName: 'csv', actionName: 'convert_csv_to_json', input: { csv_text: 'a\tb\n1\t2', has_headers: true, delimiter_type: delimiter } } },
});
const ready = (delimiter: string) => {
  const catalog = new PieceCatalog([{ name: 'csv', displayName: 'CSV', description: '', actions: {
    convert_csv_to_json: { name: 'convert_csv_to_json', displayName: '', description: '', inputSchema: propsToInputSchema(action.props) },
  } }]);
  return compileWorkflow(flow(delimiter), { pieces: catalog });
};

describe.skipIf(skip)('the compiled core CSV piece, Tab delimiter', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(pieceDir);
    const mod = require(bundle) as { csv: { getAction(name: string): Action | undefined } };
    action = mod.csv.getAction('convert_csv_to_json')!;
  });

  test('the Tab delimiter the piece offers is a ready input, and a tab-delimited CSV converts', async () => {
    const tab = ready('\t');
    expect(tab.issues).toEqual([]);
    expect(tab.ready).toBe(true);
    expect(await action.run({ propsValue: { csv_text: 'a\tb\n1\t2', has_headers: true, delimiter_type: '\t' } })).toEqual([{ a: '1', b: '2' }]);
  });

  test('a blank delimiter that is not one of the piece choices is still a missing input', () => {
    for (const blank of ['', '  ', ' \t ']) {
      expect(ready(blank).issues).toContainEqual(expect.objectContaining({ path: 'settings.input.delimiter_type' }));
    }
    expect(ready(',').ready).toBe(true);
  });
});
