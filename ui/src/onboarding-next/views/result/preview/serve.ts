import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BunPlugin } from 'bun';
// Local review-only extraction. No fetch, cherry-pick, installation or production import.
export const CANVAS_SHA = '85b3c554d276677b63918d8c9fee22dc4675ad03';
const root = resolve(import.meta.dir, '../../../../../..');
const cache = mkdtempSync(join(tmpdir(), 'jarvis-on-u-09-'));
process.on('exit', () => rmSync(cache, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
symlinkSync(join(root, 'node_modules'), join(cache, 'node_modules'), 'dir');
let available = process.env.ON_U_09_MISSING_CANVAS !== '1';
if (available) {
  try {
    const archive = execFileSync('git', ['archive', CANVAS_SHA, 'ui/src', 'src'], { cwd: root, maxBuffer: 100_000_000, stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync('tar', ['-x', '-C', cache], { input: archive });
  } catch { available = false; }
}
const path = (p: string) => JSON.stringify(join(cache, p));
const plugin: BunPlugin = { name: 'on-u-09-existing-canvas', setup(build) {
  build.onResolve({ filter: /^on-u-09-canvas-fixture$/ }, () => ({ path: 'canvas', namespace: 'on-u-09' }));
  build.onLoad({ filter: /.*/, namespace: 'on-u-09' }, () => ({ loader: 'tsx', contents: available
    ? `export { WorkflowEditor } from ${path('ui/src/v2/rooms/workflows/WorkflowEditor.tsx')};
       export { WorkflowEditorEnvironment } from ${path('ui/src/v2/rooms/workflows/WorkflowEditorEnvironment.tsx')};
       export { versionBoundRequest } from ${path('ui/src/brief/workflows/canvas/request.ts')};
       export { NavigationShell } from ${path('ui/src/brief/shell/navigation/NavigationShell.tsx')};
       export { UNKNOWN_NAVIGATION } from ${path('ui/src/brief/shell/navigation/model.ts')};
       export { CANVAS_CATALOG } from ${path('ui/src/brief/workflows/canvas/fixtures.ts')};
       import ${path('ui/src/brief/styles/index.css')};
       import ${path('ui/src/brief/workflows/canvas/canvas.css')}; export const available = true;`
    : `import React from 'react'; export const available = false; export const CANVAS_CATALOG = []; export const UNKNOWN_NAVIGATION = {};
       export const WorkflowEditorEnvironment = React.createContext({}); export function WorkflowEditor(){return null}
       export const versionBoundRequest = r => r; export function NavigationShell({children}){return children}` }));
} };
const output = join(cache, 'dist'); mkdirSync(output);
const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'preview.tsx')], outdir: output, plugins: [plugin], target: 'browser', sourcemap: 'linked', naming: '[dir]/[name].[ext]' });
if (!build.success) { console.error(build.logs); process.exit(1); }
console.log(`ON-U-09 preview build passed. D18: ${available ? CANVAS_SHA : 'unavailable'}.`);
if (!process.argv.includes('--build')) {
  const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ON-U-09 · First draft reveal</title><link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet"><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>';
  const assets = new Map(build.outputs.map(asset => ['/' + asset.path.slice(output.length + 1), asset]));
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4429), fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
    const asset = assets.get(url.pathname); return asset ? new Response(asset) : new Response('Not found', { status: 404 });
  } }); console.log('ON-U-09 preview: ' + server.url);
}
