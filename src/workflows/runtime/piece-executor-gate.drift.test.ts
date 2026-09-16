/**
 * Drift test for the engine-side half of the governed-piece adapters.
 *
 * The admission call lives in a VENDORED file,
 * `activepieces/packages/server/engine/src/lib/handler/piece-executor.ts`.
 * Two ways it can disappear without anyone noticing:
 *
 *   1. `scripts/sync-activepieces.ts` re-vendors upstream and the patch is not
 *      re-applied. Every verified piece then runs ungoverned, and no unit test
 *      that stubs the guard would catch it.
 *   2. The patch survives but is not registered in `PATCHED_VENDOR_SOURCES`,
 *      so its content stays out of the engine bundle hash and a cached bundle
 *      keeps shipping the OLD engine. That is how a fix ships as a no-op.
 *
 * Both are source-level facts, so this checks them at source level. It is
 * deliberately literal: re-applying the patch after a sync is the intended
 * work, and this test is what says it has not been done yet.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENGINE_DIR = resolve(__dirname, '../activepieces/packages/server/engine/src/lib/handler');
const PIECE_EXECUTOR = resolve(ENGINE_DIR, 'piece-executor.ts');
const BUILD_FILE = resolve(__dirname, '../runner/engine-runtime/build.ts');

const squash = (text: string): string => text.replace(/\s+/gu, ' ');

describe('engine piece-executor admission gate', () => {
  const source = readFileSync(PIECE_EXECUTOR, 'utf8');

  test('imports the guard from the daemon runtime, by a path that exists', () => {
    const match = /import \{ authorizePieceDispatch \} from '([^']+)'/u.exec(source);
    expect(match).not.toBeNull();
    const target = resolve(dirname(PIECE_EXECUTOR), `${match![1]!}.ts`);
    expect(target).toBe(resolve(__dirname, 'piece-effect-guard.ts'));
    expect(existsSync(target)).toBe(true);
  });

  test('authorizes before the piece action runs, never after', () => {
    const flat = squash(source);
    const authorizeAt = flat.indexOf('await authorizePieceDispatch({');
    const runAt = flat.indexOf('runMethodToExecute(backwardCompatibleContext)');
    expect(authorizeAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(authorizeAt).toBeLessThan(runAt);
    // The resolved input is what gets authorized: authorizing the unresolved
    // settings would review `{{ ... }}` sources rather than real recipients.
    expect(flat).toContain('input: processedInput,');
  });

  test('an approval-required verdict parks the step instead of running it', () => {
    const flat = squash(source);
    expect(flat).toContain("params.hookResponse = { ...params.hookResponse, type: 'paused' }");
    expect(flat).toContain(
      "const output = (governance.governed && governance.dispatch === 'approval_required') "
      + "? { approval: governance.approval } : await runMethodToExecute(backwardCompatibleContext)",
    );
    // One call site only: a second, ungoverned one would be a bypass.
    expect(flat.split('runMethodToExecute(backwardCompatibleContext)')).toHaveLength(2);
  });

  test('every patched source feeding the gate invalidates the engine bundle', () => {
    const build = readFileSync(BUILD_FILE, 'utf8');
    const block = /const PATCHED_VENDOR_SOURCES = \[([\s\S]*?)\n\] as const;/u.exec(build);
    expect(block).not.toBeNull();
    // Paths are relative to VENDOR_PACKAGES; each must resolve to a real file.
    const vendorPackages = resolve(__dirname, '../activepieces/packages');
    for (const rel of ['../../runtime/piece-effects.ts', '../../runtime/piece-effect-guard.ts',
      'server/engine/src/lib/handler/piece-executor.ts']) {
      expect(block![1]!).toContain(`'${rel}'`);
      expect(existsSync(resolve(vendorPackages, rel))).toBe(true);
    }
  });
});
