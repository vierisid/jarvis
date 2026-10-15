import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAcyclic, CATALOG_PATH, catalogIsCurrent, generateRuntimeManifest, writeRuntimeManifest } from './onboarding-next-runtime-manifest.ts';
import { PROVIDERS } from '../src/onboarding-next/runtime/contract.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  const r = mkdtempSync(join(tmpdir(), 'on-b-11-discovery-')); roots.push(r);
  mkdirSync(join(r, 'src/onboarding-next/runtime'), { recursive: true });
  cpSync(join(import.meta.dir, '../src/onboarding-next/runtime/contract.ts'), join(r, 'src/onboarding-next/runtime/contract.ts'));
  return r;
}
function module(r: string, i: number) {
  const p = PROVIDERS[i]!; const dir = join(r, 'src/onboarding-next', p.directory); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: p.id, kind: 'provider', entry: './index.ts', provides: [p.capability], requires: p.requires }));
  writeFileSync(join(dir, 'index.ts'), 'throw new Error("Module must not run during discovery"); export const marker = 1;');
  if ('companions' in p) for (const file of p.companions) writeFileSync(join(dir, file), 'export const persistence = true;');
  return dir;
}
async function compile(r: string) {
  await writeRuntimeManifest(r);
  const result = await Bun.build({ entrypoints: [join(r, 'src/onboarding-next/runtime/generated/catalog.ts')], target: 'bun' });
  expect(result.success).toBe(true);
}
test('empty, single, partial, full and removed module registries build without executing modules', async () => {
  const r = root();
  await compile(r); expect(await generateRuntimeManifest(r)).not.toContain('load:');
  module(r, 0); await compile(r);
  module(r, 3); await compile(r); // profile requirement absent: import still optional
  for (let i = 0; i < PROVIDERS.length; i++) module(r, i);
  await compile(r);
  const all = await generateRuntimeManifest(r); expect(all.match(/load:/g)).toHaveLength(11);
  expect(await generateRuntimeManifest(r)).toBe(all);
  rmSync(join(r, 'src/onboarding-next/journey'), { recursive: true });
  await compile(r); expect(await generateRuntimeManifest(r)).not.toContain('../../journey/');
});
test('ignores unapproved directories and cannot import a URL or sibling path', async () => {
  const r = root(); const dir = module(r, 0); const path = join(dir, 'manifest.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  for (const entry of ['https://example.test/code.ts', '/tmp/code.ts', '../setup/index.ts', './sub/../../index.ts', './index.js']) {
    writeFileSync(path, JSON.stringify({ ...original, entry })); await expect(generateRuntimeManifest(r)).rejects.toThrow('Invalid manifest');
  }
  rmSync(dir, { recursive: true }); mkdirSync(join(r, 'src/onboarding-next/arbitrary'));
  writeFileSync(join(r, 'src/onboarding-next/arbitrary/manifest.json'), '{"entry":"https://example.test"}');
  expect(await generateRuntimeManifest(r)).not.toContain('arbitrary');
});
test('rejects invalid versions, keys, IDs, duplicate capabilities and dependency drift', async () => {
  const r = root(); const dir = module(r, 0), path = join(dir, 'manifest.json'); const original = JSON.parse(readFileSync(path, 'utf8'));
  for (const patch of [{ schemaVersion: 2 }, { id: 'ON-B-02' }, { extra: true }, { provides: ['setup.v1'] }, { provides: ['journey.v1', 'journey.v1'] }, { requires: ['setup.v1'] }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...patch })); await expect(generateRuntimeManifest(r)).rejects.toThrow();
  }
});
test('refuses symlink manifests, module directories and entries', async () => {
  for (const file of ['manifest.json', 'index.ts', 'settings.ts']) {
    const r = root(), dir = module(r, 0), path = join(dir, file), outside = join(r, 'outside');
    cpSync(path, outside); rmSync(path); symlinkSync(outside, path);
    await expect(generateRuntimeManifest(r)).rejects.toThrow('Symlink');
  }
  const r = root(), dir = module(r, 0), outside = join(r, 'external');
  cpSync(dir, outside, { recursive: true }); rmSync(dir, { recursive: true }); symlinkSync(outside, dir);
  await expect(generateRuntimeManifest(r)).rejects.toThrow('Symlink');
});
test('refuses missing entries and oversized manifests', async () => {
  const r = root(), dir = module(r, 0); rmSync(join(dir, 'index.ts'));
  await expect(generateRuntimeManifest(r)).rejects.toThrow();
  writeFileSync(join(dir, 'manifest.json'), ' '.repeat(5000)); await expect(generateRuntimeManifest(r)).rejects.toThrow('Oversized');
});
test('refuses dangling symlinks instead of silently treating them as absent', async () => {
  for (const which of ['manifest', 'directory']) {
    const r = root(), dir = module(r, 0);
    const path = which === 'manifest' ? join(dir, 'manifest.json') : dir;
    rmSync(path, { recursive: true }); symlinkSync(join(r, 'missing'), path);
    await expect(generateRuntimeManifest(r)).rejects.toThrow('Symlink');
  }
});
test('graph validator rejects cycles and duplicate providers but permits absent dependencies', () => {
  expect(() => assertAcyclic([{ provides: ['a'], requires: ['b'] }])).not.toThrow();
  expect(() => assertAcyclic([{ provides: ['a'], requires: ['b'] }, { provides: ['b'], requires: ['a'] }])).toThrow('Cyclic');
  expect(() => assertAcyclic([{ provides: ['a'], requires: [] }, { provides: ['a'], requires: [] }])).toThrow('Duplicate');
});
test('the committed catalog equals the generator output for this checkout', async () => {
  // Installs and builds never regenerate it, so a stale commit would ship.
  expect(readFileSync(join(import.meta.dir, '..', CATALOG_PATH), 'utf8')).toBe(await generateRuntimeManifest(join(import.meta.dir, '..')));
});
test('the freshness check fails on a stale or missing catalog', async () => {
  const r = root(); module(r, 0);
  expect(await catalogIsCurrent(r)).toBe(false);
  await writeRuntimeManifest(r); expect(await catalogIsCurrent(r)).toBe(true);
  module(r, 1); expect(await catalogIsCurrent(r)).toBe(false);
});
