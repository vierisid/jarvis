import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from './manifest.json';

test('manifest is optional and owns no runtime registration or sibling import', () => {
  expect(manifest.provides).toEqual(['interview-session.v1']);
  expect(manifest.requires).toEqual(['interview-profile.v1']);
  const dir = import.meta.dir;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/(journey|setup|google|interview-profile|tour)\//);
    expect(source).not.toMatch(/console\.(log|warn|error)|new WebSocket\(|getUserProfile\(|appendUserProfileFact\(/);
  }
});
test('client and transport bundle for the browser without server runtime modules', async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'client.ts'), join(import.meta.dir, 'transport.ts')], target: 'browser' });
  expect(result.success).toBe(true);
  expect(result.logs).toHaveLength(0);
});
