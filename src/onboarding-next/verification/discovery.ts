import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { PROVIDERS, VIEWS } from './matrix';
export interface Inventory { present: string[]; missing: string[]; }
export const ROOT = resolve(import.meta.dir, '../../..');
export async function containedFile(root: string, relative: string) {
  if (!/^[\w./-]+$/.test(relative) || relative.split('/').some(s => !s || s === '..' || s === '.')) throw Error('Invalid relative file');
  const base = await realpath(root); let current = base;
  for (const segment of relative.split('/')) { current = resolve(current, segment); if ((await lstat(current)).isSymbolicLink()) throw Error('Symlink is not evidence/source'); }
  if (!current.startsWith(base + sep) || !(await lstat(current)).isFile()) throw Error('Not a contained regular file');
  return current;
}
async function optional(root: string, file: string) {
  try { return await containedFile(root, file); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function discover(root = ROOT): Promise<Inventory> {
  const present: string[] = [], missing: string[] = [];
  for (const [id, directory, capability, requirements] of PROVIDERS) {
    const folder = `src/onboarding-next/${directory}`, file = await optional(root, `${folder}/manifest.json`);
    if (!file) { missing.push(id); continue; }
    if ((await lstat(file)).size > 4096) throw Error(`Oversized manifest: ${id}`);
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const expected = { schemaVersion: 1, id, kind: 'provider', entry: './index.ts', provides: [capability], requires: [...requirements] };
    if (Object.keys(manifest).sort().join() !== Object.keys(expected).sort().join() || Object.entries(expected).some(([key, value]) => JSON.stringify(manifest[key]) !== JSON.stringify(value))) throw Error(`Invalid manifest: ${id}`);
    await containedFile(root, `${folder}/index.ts`); present.push(id);
  }
  for (const [id, file] of [
    ...VIEWS.map((name, n) => [`ON-U-${String(n + 1).padStart(2, '0')}`, `ui/src/onboarding-next/views/${name}/index.tsx`]),
    ['ON-U-10', 'ui/src/onboarding-next/host/Entry.tsx'], ['ON-U-11', 'ui/src/onboarding-next/verification/report.ts'],
    ['ON-B-11', 'src/onboarding-next/runtime/runtime.ts'],
  ]) (await optional(root, file!) ? present : missing).push(id!);
  return { present, missing };
}
export async function loadProvider(id: string, root = ROOT) {
  const definition = PROVIDERS.find(p => p[0] === id);
  if (!definition || !(await discover(root)).present.includes(id)) throw Error(`Unavailable provider: ${id}`);
  return import(await containedFile(root, `src/onboarding-next/${definition[1]}/index.ts`));
}
