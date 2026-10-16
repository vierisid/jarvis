import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { VIEWS } from './matrix';
export interface Inventory { views: string[]; host: boolean; pebble: boolean; missing: string[]; }
async function regular(root: string, relative: string) {
  const path = resolve(root, relative);
  try {
    if (!(await lstat(path)).isFile() || (await realpath(path)) !== path || !path.startsWith(root + sep)) throw Error(`Unsafe fixture source: ${relative}`);
    return path;
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function discover(root: string): Promise<Inventory> {
  root = await realpath(root);
  const views: string[] = [], missing: string[] = [];
  for (const view of VIEWS) {
    const folder = `ui/src/onboarding-next/views/${view.name}`;
    const manifest = await regular(root, `${folder}/manifest.json`);
    if (!manifest) { missing.push(view.id); continue; }
    const raw = await readFile(manifest, 'utf8');
    if (Buffer.byteLength(raw) > 4096) throw Error(`Oversized manifest: ${view.id}`);
    const value = JSON.parse(raw);
    const expected = { schemaVersion: 1, id: view.id, kind: 'view', entry: './index.tsx', provides: [view.capability], requires: [...view.requires] };
    if (!value || Object.keys(value).sort().join() !== Object.keys(expected).sort().join()
      || Object.entries(expected).some(([key, content]) => JSON.stringify(value[key]) !== JSON.stringify(content))) throw Error(`Invalid manifest: ${view.id}`);
    if (!await regular(root, `${folder}/index.tsx`)) throw Error(`Missing entry: ${view.id}`);
    views.push(view.name);
  }
  const host = !!await regular(root, 'ui/src/onboarding-next/host/Entry.tsx')
    && !!await regular(root, 'ui/src/onboarding-next/host/preview/fixture.tsx');
  const pebble = !!await regular(root, 'ui/src/brief/shell/pebble-layout/PebbleLayout.tsx');
  return { views, host, pebble, missing };
}
/** Called only by the isolated build; no generated imports are committed. */
export function catalogSource(root: string, inventory: Inventory) {
  const path = (relative: string) => JSON.stringify(resolve(root, relative));
  const lines = VIEWS.filter(v => inventory.views.includes(v.name)).map((v, i) => `import { ${v.export} as V${i} } from ${path(`ui/src/onboarding-next/views/${v.name}/index.tsx`)};`);
  lines.push(`export const views = { ${VIEWS.filter(v => inventory.views.includes(v.name)).map((v, i) => `${JSON.stringify(v.name)}: V${i}`).join(', ')} };`);
  if (inventory.host) lines.push(`import { OptionalOnboardingEntry as Entry } from ${path('ui/src/onboarding-next/host/Entry.tsx')};`, `import { previewConfiguration } from ${path('ui/src/onboarding-next/host/preview/fixture.tsx')};`, 'export const host = { Entry, previewConfiguration };');
  else lines.push('export const host = null;');
  lines.push(inventory.pebble ? `export { PebbleLayout } from ${path('ui/src/brief/shell/pebble-layout/PebbleLayout.tsx')};` : 'export const PebbleLayout = null;');
  lines.push(`export const inventory = ${JSON.stringify(inventory)};`);
  return lines.join('\n');
}
