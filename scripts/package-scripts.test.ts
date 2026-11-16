import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A package script that runs a deleted file fails only when someone types it.
// Removing a script's target (as examples/llm-integration.ts was) must take
// the script with it; this keeps every bun/node file target real.

const root = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** File targets of `bun|node [flags] [run] <file>` inside one script command. */
function runTargets(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;&|(])(?:bun|node)(?:\s+--\S+)*\s+(?:run\s+)?["']?([^\s"';&|]+\.[cm]?[jt]sx?)\b/g;
  for (const m of command.matchAll(re)) out.push(m[1]!);
  return out;
}

describe('package.json scripts', () => {
  test('the target parser sees file targets and skips script names', () => {
    expect(runTargets('bun run src/daemon/index.ts')).toEqual(['src/daemon/index.ts']);
    expect(runTargets('bun --no-env-file run scripts/integration/dev.ts')).toEqual(['scripts/integration/dev.ts']);
    expect(runTargets('bun run copy:models && bun run build:ui')).toEqual([]);
    expect(runTargets('node scripts/ensure-bun.cjs && (bun run copy:models 2>/dev/null || true)')).toEqual(['scripts/ensure-bun.cjs']);
    expect(runTargets('bun --env-file=.env scripts/x.tsx')).toEqual(['scripts/x.tsx']);
    expect(runTargets("bun run 'scripts/y.ts'")).toEqual(['scripts/y.ts']);
    expect(runTargets('bun test --preload ./src/test-preload.ts')).toEqual([]);
    expect(runTargets('bunx tsc -p .')).toEqual([]);
  });

  test('every bun run file target exists', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const [name, command] of Object.entries(pkg.scripts)) {
      for (const target of runTargets(command)) {
        checked++;
        if (!existsSync(join(root, target))) missing.push(`${name}: ${target}`);
      }
    }
    // Guards against the parser silently matching nothing.
    expect(checked).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
