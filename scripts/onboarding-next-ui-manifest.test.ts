import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CATALOG_PATH, catalogIsCurrent, generateUIManifest, writeUIManifest } from './onboarding-next-ui-manifest.ts';
import { VIEWS } from '../ui/src/onboarding-next/host/contract.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(count: number) {
  const root = mkdtempSync(join(tmpdir(), 'on-u-10-manifest-')); roots.push(root);
  for (const spec of VIEWS.slice(0, count)) {
    const folder = join(root, 'ui/src/onboarding-next/views', spec.directory); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: spec.id, kind: 'view', entry: './index.tsx', provides: [spec.capability], requires: [...spec.requires] }));
    writeFileSync(join(folder, 'index.tsx'), 'throw new Error("Discovery executed a view");');
  }
  return root;
}
test('committed catalog matches current manifests (CI drift guard)', async () => {
  expect(await catalogIsCurrent(resolve(import.meta.dir, '..'))).toBe(true);
});
test('catalog check refuses absent and stale output without changing it', async () => {
  const root = fixture(1);
  expect(await catalogIsCurrent(root)).toBe(false);
  await writeUIManifest(root); expect(await catalogIsCurrent(root)).toBe(true);
  rmSync(join(root, 'ui/src/onboarding-next/views/welcome'), { recursive: true });
  expect(await catalogIsCurrent(root)).toBe(false);
  await writeUIManifest(root); expect(await catalogIsCurrent(root)).toBe(true);
});
for (const count of [0, 1, 4, 9]) test(`generates deterministic imports for ${count} present views without executing them`, async () => {
  const root = fixture(count), output = await generateUIManifest(root);
  expect(output.match(/load: /g)?.length ?? 0).toBe(count); expect(await generateUIManifest(root)).toBe(output);
  await writeUIManifest(root);
  expect((await Bun.build({ entrypoints: [join(root, CATALOG_PATH)], target: 'browser' })).success).toBe(true);
});
test('removing each view regenerates without a dangling import', async () => {
  for (const spec of VIEWS) {
    const root = fixture(9); rmSync(join(root, 'ui/src/onboarding-next/views', spec.directory), { recursive: true });
    expect(await generateUIManifest(root)).not.toContain(`../../views/${spec.directory}/index.tsx`);
  }
});
for (const change of [{ entry: '../escape.tsx' }, { entry: '/tmp/view.tsx' }, { entry: 'https://example.test/view.tsx' }, { schemaVersion: 2 }, { id: 'ON-U-02' }, { provides: ['google-view.v1'] }, { requires: ['welcome-view.v1'] }, { surprise: true }]) test(`rejects invalid manifest ${JSON.stringify(change)}`, async () => {
  const root = fixture(1), path = join(root, 'ui/src/onboarding-next/views/welcome/manifest.json');
  const original = await Bun.file(path).json(); writeFileSync(path, JSON.stringify({ ...original, ...change }));
  await expect(generateUIManifest(root)).rejects.toThrow();
});
test('rejects broken entry, oversized manifest, and file/directory/dangling symlinks', async () => {
  for (const kind of ['missing', 'oversized', 'entry-link', 'manifest-link', 'folder-link', 'dangling']) {
    const root = fixture(1), folder = join(root, 'ui/src/onboarding-next/views/welcome');
    if (kind === 'missing') rmSync(join(folder, 'index.tsx'));
    if (kind === 'oversized') writeFileSync(join(folder, 'manifest.json'), ' '.repeat(4097));
    if (kind === 'entry-link') { rmSync(join(folder, 'index.tsx')); symlinkSync(join(folder, 'manifest.json'), join(folder, 'index.tsx')); }
    if (kind === 'manifest-link' || kind === 'dangling') { rmSync(join(folder, 'manifest.json')); symlinkSync(kind === 'dangling' ? join(root, 'absent') : join(folder, 'index.tsx'), join(folder, 'manifest.json')); }
    if (kind === 'folder-link') { rmSync(folder, { recursive: true }); symlinkSync(root, folder); }
    await expect(generateUIManifest(root)).rejects.toThrow();
  }
});
