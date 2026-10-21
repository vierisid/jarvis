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
import { engineEnv, isEngineEnvName } from '../runner/engine-runtime/spawn';
import { CATALOG } from '../pieces-library/catalog';
import { CORE_PIECE_ADAPTERS, resolveGovernedPieceAction } from './piece-effects';
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
const vendored = readdirSync(CORE).filter((name) => statSync(resolve(CORE, name)).isDirectory()).sort();

/**
 * Every action of every in-run core piece, reviewed: what it does, and why
 * that is nothing outside Jarvis. An action upstream adds lands here only by a
 * person reading it.
 */
const IN_RUN_ACTIONS: Record<string, Record<string, string>> = {
  '@activepieces/piece-approval': {
    create_approval_links: 'makes resume links for this run; sends them nowhere',
    wait_for_approval: 'parks the run until a resume link is opened',
  },
  '@activepieces/piece-delay': {
    delayFor: 'waits', delay_until: 'waits',
  },
  '@activepieces/piece-file-helper': {
    change_file_encoding: 'rewrites a file of this run', checkFileType: 'reads a file of this run',
    createFile: 'writes a file into this run', get_file_name: 'reads a file name', read_file: 'reads a file of this run',
    unzipFile: 'unpacks a file of this run', zipFiles: 'packs files of this run',
  },
  '@activepieces/piece-schedule': {},
  '@activepieces/piece-store': {
    add_to_list: 'the workflow store', append: 'the workflow store', get: 'the workflow store', put: 'the workflow store',
    remove_from_list: 'the workflow store', remove_value: 'the workflow store',
  },
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
      // A governed core piece has no trigger: a trigger would run outside the boundary.
      expect(declared(resolve(CORE, adapter.catalogId), 'Trigger')).toEqual([]);
    }
  });
});

describe('the loaded core pieces are built, listed and run from the vendored copy', () => {
  test('each is listed one by one, so the webhook piece next to them is not', () => {
    const { entries } = discoverPieces(loadedCorePieceDirs());
    expect(entries.map((e) => e.name)).toEqual(['@activepieces/piece-approval', '@activepieces/piece-delay',
      '@activepieces/piece-http', '@activepieces/piece-schedule']);
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
