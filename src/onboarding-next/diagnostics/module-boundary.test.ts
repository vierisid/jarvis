import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import manifest from './manifest.json';

test('physically isolated diagnostics imports and constructs with no sibling modules; removal remains safe', async () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-B-12', kind: 'provider', entry: './index.ts', provides: ['diagnostics.v1'], requires: [] });
  const dir = mkdtempSync(join(tmpdir(), 'on-b-12-boundary-'));
  try {
    const module = join(dir, 'diagnostics'); mkdirSync(module);
    for (const file of ['index.ts', 'types.ts', 'normalize.ts', 'observe.ts', 'logger-abort.ts']) cpSync(join(import.meta.dir, file), join(module, file));
    for (const [i, present] of [false, true, false].entries()) {
      if (i === 2) rmSync(module, { recursive: true });
      const entry = join(dir, 'host.ts');
      writeFileSync(entry, present
        ? `import { createDiagnosticsProvider } from './diagnostics/index.ts'; export const registry = { 'diagnostics.v1': createDiagnosticsProvider({authorize(){ throw new Error('Construction must be inert'); }}) };`
        : 'export const registry = {};');
      const built = await Bun.build({ entrypoints: [entry], target: 'bun' });
      expect(built.success).toBe(true);
      const bundle = join(dir, `host-${i}.mjs`); await Bun.write(bundle, built.outputs[0]!);
      const child = Bun.spawn([process.execPath, '-e', `const {registry}=await import(${JSON.stringify(bundle)}); console.log(JSON.stringify(Object.keys(registry)));`], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(JSON.parse(stdout)).toEqual(present ? ['diagnostics.v1'] : []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
