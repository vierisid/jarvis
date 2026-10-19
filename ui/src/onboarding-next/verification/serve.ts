import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildPreview } from './build';

const output = await mkdtemp(resolve(tmpdir(), 'on-u-11-'));
const result = await buildPreview(output);
if (!result.success) { console.error(result.logs); await rm(output, { recursive: true, force: true }); process.exit(1); }
if (process.argv.includes('--build')) {
  console.log(`ON-U-11 fixture build: ${output}`);
} else {
  const csp = "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'none'; object-src 'none'; base-uri 'none'";
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.ON_U_11_PORT ?? 4431), async fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Read-only fixture', { status: 405 });
    const name = new URL(request.url).pathname;
    const file = resolve(output, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(output + '/') || !await Bun.file(file).exists()) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(file), { headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': csp } });
  } });
  const stop = async () => { server.stop(true); await rm(output, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`ON-U-11 fixture preview: ${server.url}`);
}
