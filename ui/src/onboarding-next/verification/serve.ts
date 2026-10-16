import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { catalogSource, discover, hostCatalogSource } from './discovery';
const root = resolve(import.meta.dir, '../../../..');
const inventory = await discover(root);
const git = (...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd: root }); if (result.exitCode) throw Error('Cannot identify candidate'); return result.stdout.toString().trim(); };
const candidate = { revision: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), dirty: !!git('status', '--porcelain', '--untracked-files=normal') };
const output = await mkdtemp(resolve(tmpdir(), 'on-u-11-'));
const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'index.html')], outdir: output, target: 'browser', plugins: [{ name: 'on-u-11-discovery', setup(build) {
  build.onLoad({ filter: /verification\/catalog\.ts$/ }, () => ({ contents: catalogSource(root, inventory) + `\nexport const candidate = ${JSON.stringify(candidate)};`, loader: 'tsx' }));
  build.onLoad({ filter: /host\/generated\/catalog\.ts$/ }, () => ({ contents: hostCatalogSource(root, inventory), loader: 'tsx' }));
} }] });
if (!result.success) { console.error(result.logs); process.exit(1); }
await writeFile(resolve(output, 'candidate.json'), JSON.stringify({ candidate, inventory }, null, 2));
console.log(JSON.stringify({ output, candidate, inventory }));
if (!process.argv.includes('--build')) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.ON_U_11_PORT ?? 4431), async fetch(request) {
    if (!['GET','HEAD'].includes(request.method)) return new Response('Read-only fixture', { status: 405 });
    const name = new URL(request.url).pathname;
    if (name.startsWith('/api/')) return new Response('No live APIs', { status: 404 });
    const file = resolve(output, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(output + '/') || !await Bun.file(file).exists()) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(file), { headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'none'; object-src 'none'; base-uri 'none'" } });
  } }); console.log(`ON-U-11 fixture: ${server.url}`);
}
