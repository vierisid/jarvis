import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import manifest from './manifest.json';

test('contract fixture host bundles with zero modules, journey only, and journey removed', async () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-B-01', kind: 'provider', entry: './index.ts', provides: ['journey.v1'], requires: [] });
  const dir = mkdtempSync(join(tmpdir(), 'on-b-01-boundary-'));
  try {
    const modulePath = new URL('./index.ts', import.meta.url).pathname;
    // This is a host CONTRACT FIXTURE, not the absent ON-B-11 implementation.
    // An absent module generates zero imports. Presence alone never starts it.
    for (const present of [false, true, false]) {
      const entry = join(dir, 'host.ts');
      writeFileSync(entry, present
        ? `import { createJourneyProvider } from ${JSON.stringify(modulePath)}; export const registry = { 'journey.v1': createJourneyProvider };`
        : 'export const registry = {};');
      const result = await Bun.build({ entrypoints: [entry], target: 'bun' });
      expect(result.success).toBe(true);
      expect(result.logs.filter(l => l.level === 'error')).toHaveLength(0);
      const bundle = join(dir, `host-${present}.mjs`);
      await Bun.write(bundle, result.outputs[0]!);
      const probe = Bun.spawn([process.execPath, '-e', `const {registry}=await import(${JSON.stringify(bundle)}); console.log(JSON.stringify(Object.keys(registry)));`], { stdout: 'pipe', stderr: 'pipe' });
      const [text, err, code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
      expect({ code, err }).toEqual({ code: 0, err: '' });
      expect(JSON.parse(text)).toEqual(present ? ['journey.v1'] : []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
