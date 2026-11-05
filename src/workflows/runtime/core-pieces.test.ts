/**
 * #961: the vendored core pieces. Every one is either governed or acts only
 * inside the run, the ones Jarvis loads are built and listed one by one, and
 * nothing a vendored piece compiles in can change without its build noticing.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from '../runner/engine-runtime/build';
import { LOADED_CORE_PIECES, loadedCorePieceDirs, PIECE_JARVIS_SOURCES } from '../runner/engine-runtime/build-pieces';
import { CORE_PIECES_LEFT_OUT } from '../runner/engine-runtime/build';
import { engineEnv, isEngineEnvName } from '../runner/engine-runtime/spawn';
import { CATALOG } from '../pieces-library/catalog';
import { CORE_PIECE_ADAPTERS, GRAPHQL_PIECE, PIECE_ABOVE_LEVEL_ASKS, resolveGovernedPieceAction, sanitizePieceInput, SFTP_PIECE, SMTP_PIECE, tracksPieceCompletion } from './piece-effects';
import { IN_RUN_STEP_PIECES, isCommunityPiece } from './step-admission';
import { discoverPieces } from './piece-catalog';
import { EGRESS_POLICY_ENV } from './http-egress';

const CORE = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core');
const SRC = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, '../../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === 'i18n') return [];
    return statSync(path).isDirectory() ? walk(path) : /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
  });
}
const packageName = (dir: string) => (JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { name: string }).name;
/** The `name:` of each `createAction(` / `createTrigger(` in a piece's source, as upstream declares them. */
function declared(dir: string, kind: 'Action' | 'Trigger'): string[] {
  return walk(resolve(dir, 'src')).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(new RegExp(`create${kind}\\(\\{[\\s\\S]*?\\bname:\\s*['"]([^'"]+)['"]`, 'g'))].map((m) => m[1]!)).sort();
}
/** The identifiers in the `triggers: [...]` list of a piece's `createPiece` call. */
function exposedTriggers(dir: string): string[] {
  const index = readFileSync(resolve(dir, 'src/index.ts'), 'utf8');
  const lists = [...index.matchAll(/\btriggers:\s*\[([^\]]*)\]/g)];
  expect(lists.length).toBe(1);
  return lists[0]![1]!.split(',').map((x) => x.trim()).filter(Boolean);
}
const vendored = readdirSync(CORE).filter((name) => statSync(resolve(CORE, name)).isDirectory()).sort();

/**
 * Every action of every in-run core piece, reviewed: what it does, and why
 * that is nothing outside Jarvis. An action upstream adds lands here only by a
 * person reading it.
 */
const IN_RUN_ACTIONS: Record<string, Record<string, string>> = {
  '@activepieces/piece-approval': {
    create_approval_links: 'creates a signed-in Needs you request for this run; its links only open that page; sends nothing',
    wait_for_approval: 'parks the run until the signed-in user decides that request in Needs you',
  },
  '@activepieces/piece-crypto': {
    'base64-decode': 'decodes a string', 'base64-encode': 'encodes a string', 'generate-password': 'makes a random string',
    'hash-text': 'hashes a string', 'hmac-signature': 'signs a string with a key from the step', openpgpEncrypt: 'encrypts a file of this run to a key from the step',
  },
  '@activepieces/piece-csv': { convert_csv_to_json: 'parses a string', convert_json_to_csv: 'renders a string' },
  '@activepieces/piece-data-mapper': { advanced_mapping: 'reshapes the step input' },
  '@activepieces/piece-data-summarizer': {
    calculateAverage: 'arithmetic on the step input', calculateSum: 'arithmetic on the step input',
    countUniques: 'counts the step input', getMinMax: 'compares the step input',
  },
  '@activepieces/piece-date-helper': {
    add_subtract_date: 'date arithmetic', date_difference: 'date arithmetic', extract_date_parts: 'date parsing',
    first_day_of_previous_month: 'reads the clock', format_date: 'date formatting', get_current_date: 'reads the clock',
    last_day_of_previous_month: 'reads the clock', next_day_of_week: 'reads the clock', next_day_of_year: 'reads the clock',
  },
  '@activepieces/piece-delay': {
    delayFor: 'waits', delay_until: 'waits',
  },
  '@activepieces/piece-file-helper': {
    change_file_encoding: 'rewrites a file of this run', checkFileType: 'reads a file of this run',
    createFile: 'writes a file into this run', get_file_name: 'reads a file name', read_file: 'reads a file of this run',
    unzipFile: 'unpacks a file of this run', zipFiles: 'packs files of this run',
  },
  '@activepieces/piece-image-helper': {
    compress_image: 'rewrites an image of this run', crop_image: 'rewrites an image of this run', get_meta_data: 'reads an image of this run',
    image_to_base64: 'encodes an image of this run', resize_image: 'rewrites an image of this run', rotate_image: 'rewrites an image of this run',
  },
  '@activepieces/piece-math-helper': {
    addition_math: 'arithmetic', division_math: 'arithmetic', generateRandom_math: 'a random number',
    modulo_math: 'arithmetic', multiplication_math: 'arithmetic', subtraction_math: 'arithmetic',
  },
  '@activepieces/piece-pdf': {
    addTextToPdf: 'writes a PDF into this run', extractPdfPages: 'writes a PDF into this run',
    extractText: 'reads a PDF of this run', imageToPdf: 'writes a PDF into this run', mergePdfs: 'writes a PDF into this run',
    pdfPageCount: 'reads a PDF of this run', textToPdf: 'writes a PDF into this run',
  },
  '@activepieces/piece-qrcode': { text_to_qrcode: 'draws an image into this run' },
  '@activepieces/piece-schedule': {},
  '@activepieces/piece-store': {
    add_to_list: 'the workflow store', append: 'the workflow store', get: 'the workflow store', put: 'the workflow store',
    remove_from_list: 'the workflow store', remove_value: 'the workflow store',
  },
  '@activepieces/piece-text-helper': {
    concat: 'string operation', defaultValue: 'string operation', extract_from_html: 'parses HTML with scripts off and no resource loading',
    find: 'string operation', html_to_markdown: 'string operation', json_to_ascii_table: 'string operation',
    markdown_to_html: 'string operation', replace: 'string operation', slugify: 'string operation', split: 'string operation',
    stripHtml: 'string operation',
  },
  '@activepieces/piece-xml': { 'convert-json-to-xml': 'renders a string' },
};

describe('every vendored core piece is governed or acts only inside the run', () => {
  test('the vendored set is exactly the governed, the in-run and the webhook piece Jarvis does not load', () => {
    const governed = CORE_PIECE_ADAPTERS.map((a) => a.pieceName);
    const names = vendored.map((name) => packageName(resolve(CORE, name)));
    expect(governed.filter((name) => IN_RUN_STEP_PIECES.has(name))).toEqual([]);
    expect(names.filter((name) => !governed.includes(name) && !IN_RUN_STEP_PIECES.has(name))).toEqual(['@activepieces/piece-webhook']);
    expect([...IN_RUN_STEP_PIECES, ...governed].filter((name) => !names.includes(name))).toEqual([]);
    // The one left out is not loaded, so nothing can run it.
    expect(LOADED_CORE_PIECES).not.toContain('webhook');
  });

  test('every upstream core piece at the pin is loaded or left out with a reason, and only the loaded ones and the webhook are vendored', () => {
    // packages/pieces/core at UPSTREAM_PIN_SHA (d04e6807, 0.82.1), listed by hand: a sync that brings a new
    // core piece fails here until someone decides to load it (governed or in-run) or leave it out.
    const upstream = ['approval', 'connections', 'crypto', 'csv', 'data-mapper', 'data-summarizer', 'date-helper', 'delay',
      'file-helper', 'forms', 'graphql', 'http', 'image-helper', 'manual-trigger', 'math-helper', 'pdf', 'qrcode', 'schedule',
      'sftp', 'smtp', 'store', 'subflows', 'tables', 'tags', 'text-helper', 'webhook', 'xml'];
    expect([...LOADED_CORE_PIECES, ...Object.keys(CORE_PIECES_LEFT_OUT)].sort()).toEqual(upstream);
    expect(LOADED_CORE_PIECES.filter((name) => Object.hasOwn(CORE_PIECES_LEFT_OUT, name))).toEqual([]);
    expect(vendored).toEqual([...LOADED_CORE_PIECES, ...Object.entries(CORE_PIECES_LEFT_OUT).filter(([, v]) => v.vendored).map(([k]) => k)].sort());
    for (const [name, { reason }] of Object.entries(CORE_PIECES_LEFT_OUT)) expect({ name, reasoned: reason.length > 20 }).toEqual({ name, reasoned: true });
    // The vendored copies are the ones upstream's sync copies, so a re-sync keeps them.
    const sync = readFileSync(resolve(SRC, '..', 'scripts', 'sync-activepieces.ts'), 'utf8');
    expect([...sync.matchAll(/"packages\/pieces\/core\/([a-z-]+)"/g)].map((m) => m[1]).sort()).toEqual(vendored);
  });

  test('every loaded core piece is governed or in-run, so none is badged or audited as a community piece', () => {
    for (const dir of loadedCorePieceDirs()) expect(`${packageName(dir)}: ${isCommunityPiece(packageName(dir))}`).toBe(`${packageName(dir)}: false`);
  });

  test('every action of an in-run piece has been read and found to act only inside the run', () => {
    for (const name of vendored) {
      const dir = resolve(CORE, name), piece = packageName(dir);
      if (!IN_RUN_STEP_PIECES.has(piece)) continue;
      expect({ piece, actions: declared(dir, 'Action') }).toEqual({ piece, actions: Object.keys(IN_RUN_ACTIONS[piece]!).sort() });
    }
    expect(Object.keys(IN_RUN_ACTIONS).sort()).toEqual([...IN_RUN_STEP_PIECES].sort());
  });

  test('every action of a governed core piece is mapped', () => {
    for (const adapter of CORE_PIECE_ADAPTERS) {
      const actions = declared(resolve(CORE, adapter.catalogId), 'Action');
      expect(actions.length).toBeGreaterThan(0);
      expect({ piece: adapter.pieceName, unmapped: actions.filter((a) => !resolveGovernedPieceAction(adapter.pieceName, a)!.known) })
        .toEqual({ piece: adapter.pieceName, unmapped: [] });
      // A governed core piece exposes no trigger: a trigger would run outside the boundary.
      // Read from its createPiece call, since the SFTP piece's trigger source stays vendored but unlisted.
      expect({ piece: adapter.pieceName, triggers: exposedTriggers(resolve(CORE, adapter.catalogId)) })
        .toEqual({ piece: adapter.pieceName, triggers: [] });
    }
  });
});

describe('the loaded core pieces are built, listed and run from the vendored copy', () => {
  test('each is listed one by one, so the webhook piece next to them is not', () => {
    const { entries } = discoverPieces(loadedCorePieceDirs());
    expect(entries.map((e) => e.name)).toEqual(LOADED_CORE_PIECES.map((name) => `@activepieces/piece-${name}`));
    // The parent, walked as a root, would also list the webhook piece.
    expect(discoverPieces([CORE]).entries.map((e) => e.name)).toContain('@activepieces/piece-webhook');
  });

  test('no catalogue piece shares a loaded core piece\'s short name, which is how the engine picks the vendored copy', () => {
    const short = (npm: string) => npm.replace(/^@[^/]+\//, '').replace(/^piece-/, '');
    expect(CATALOG.filter((entry) => LOADED_CORE_PIECES.includes(short(entry.npmPackage))).map((e) => e.npmPackage)).toEqual([]);
  });

  test('every Jarvis module a vendored piece imports is part of its build hash', () => {
    const roots = [resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/jarvis'), ...loadedCorePieceDirs()];
    const imported = new Set<string>();
    for (const root of roots) {
      for (const file of walk(root)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
          const target = resolve(file, '..', match[1]!);
          if (relative(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, target).startsWith('..')) imported.add(`${relative(SRC, target)}.ts`);
        }
      }
    }
    expect([...imported].sort()).toEqual([...PIECE_JARVIS_SOURCES].sort());
  });
});

describe('the engine is told the install\'s egress policy', () => {
  const base = { bundlePath: '/x/main.js', sandboxId: 's', sandboxWsPort: 1, baseCodeDir: '/x/code' };
  test('set by the daemon, it reaches the engine env; unset, the engine applies the hosted rule', () => {
    expect(isEngineEnvName(EGRESS_POLICY_ENV)).toBe(true);
    expect(engineEnv({ ...base, egressPolicy: 'private-allowed' })[EGRESS_POLICY_ENV]).toBe('private-allowed');
    expect(engineEnv({ ...base, egressPolicy: 'public-only' })[EGRESS_POLICY_ENV]).toBe('public-only');
    expect(EGRESS_POLICY_ENV in engineEnv(base)).toBe(false);
  });
});

describe('#961: the Docker image ships every loaded core piece', () => {
  // The image's read-only install tree cannot build a piece at boot, so a core
  // piece the Dockerfile does not prebuild and copy stops the workflow engine.
  test('the Dockerfile checks and stages exactly LOADED_CORE_PIECES', () => {
    const dockerfile = readFileSync(resolve(import.meta.dir, '..', '..', '..', 'Dockerfile'), 'utf8');
    const checked = [...dockerfile.matchAll(/"\$core\/([a-z-]+)\/"/g)].map((m) => m[1]);
    expect(checked).toEqual([...LOADED_CORE_PIECES]);
    const staged = dockerfile.match(/for name in ([a-z -]+); do/);
    expect(staged?.[1]?.trim().split(/\s+/)).toEqual([...LOADED_CORE_PIECES]);
    expect(dockerfile).toContain('COPY --from=workflows /out/core-pieces/ ./src/workflows/activepieces/packages/pieces/core/');
  });
});

describe('#961: the SMTP, GraphQL and FTP/SFTP pieces are governed at their worst case', () => {
  const category = (piece: string, action: string, input?: Record<string, unknown>) => resolveGovernedPieceAction(piece, action, input)!.category;

  test('an SMTP email is send_email and is tracked, so it asks at the shipped defaults and is never repeated after an unknown outcome', () => {
    expect(category(SMTP_PIECE, 'send-email')).toBe('send_email');
    expect(PIECE_ABOVE_LEVEL_ASKS).toContain('send_email');
    expect(tracksPieceCompletion(SMTP_PIECE, 'send-email')).toBe(true);
    // An action upstream adds later is gated as an email too.
    expect(category(SMTP_PIECE, 'send-bulk')).toBe('send_email');
  });

  test('a GraphQL request always carries its query as a body: a send for GET too, the worst case for DELETE or anything else', () => {
    for (const method of ['GET', 'get', 'HEAD', 'POST', 'PUT', 'PATCH']) expect(`${method}: ${category(GRAPHQL_PIECE, 'send_request', { method })}`).toBe(`${method}: send_message`);
    for (const method of ['DELETE', 'OPTIONS', ' POST', 7, undefined]) expect(`${String(method)}: ${category(GRAPHQL_PIECE, 'send_request', { method })}`).toBe(`${String(method)}: delete_data`);
    // Without an input, the table's worst case.
    expect(category(GRAPHQL_PIECE, 'send_request')).toBe('delete_data');
    for (const method of ['GET', 'POST']) expect(tracksPieceCompletion(GRAPHQL_PIECE, 'send_request', { method })).toBe(true);
  });

  test('GraphQL credentials in headers, query parameters, the URL and variables never reach the card', () => {
    const redacted = sanitizePieceInput({ method: 'POST', url: 'https://u:pw@api.example.com/graphql?api_key=k1&q=1', headers: { Authorization: 'Bearer t1', Accept: 'json' },
      queryParams: { token: 't2', page: '2' }, query: 'mutation { login }', variables: { email: 'a@b.c', password: 'p1', nested: [{ apiKey: 'k2' }] } }, GRAPHQL_PIECE);
    const text = JSON.stringify(redacted);
    for (const secret of ['pw', 'k1', 't1', 't2', 'p1', 'k2']) expect(text).not.toContain(`"${secret}"`);
    expect(text).not.toMatch(/u:pw@|api_key=k1|Bearer t1/);
    expect(redacted).toMatchObject({ headers: { Accept: 'json' }, queryParams: { page: '2' }, variables: { email: 'a@b.c' }, query: 'mutation { login }' });
  });

  test('FTP/SFTP: reads read, a folder is a write, putting content on the server is a send, renames and deletes are the worst case', () => {
    expect(['read_file_content', 'listFolderContents'].map((a) => category(SFTP_PIECE, a))).toEqual(['read_data', 'read_data']);
    expect(category(SFTP_PIECE, 'createFolder')).toBe('write_data');
    expect(['upload_file', 'create_file'].map((a) => category(SFTP_PIECE, a))).toEqual(['send_message', 'send_message']);
    expect(['renameFileOrFolder', 'deleteFile', 'deleteFolder', 'anything_new'].map((a) => category(SFTP_PIECE, a)))
      .toEqual(['delete_data', 'delete_data', 'delete_data', 'delete_data']);
  });
});
