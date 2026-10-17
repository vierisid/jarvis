import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '../../../../..');
const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'index.html')], outdir: resolve(root, 'ui/dist-on-u-10'), target: 'browser', minify: false });
if (!result.success) { console.error(result.logs); process.exit(1); }
if (!process.argv.includes('--build')) {
  const output = resolve(root, 'ui/dist-on-u-10');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 4420, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(Bun.file(resolve(output, 'index.html')));
    const file = resolve(output, '.' + path);
    return file.startsWith(output + '/') && await Bun.file(file).exists() ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 });
  } });
  console.log(`ON-U-10 fixture preview: ${server.url}`);
}
