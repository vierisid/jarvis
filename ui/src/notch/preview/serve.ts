import page from './index.html';

// The notch in a browser, with no brain and no desktop app. See preview.ts.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.NOTCH_PREVIEW_PORT ?? 4420),
  routes: { '/': page },
  fetch: () => new Response('Not found', { status: 404 }),
  development: true,
});
console.log(`Notch preview: ${server.url}`);
