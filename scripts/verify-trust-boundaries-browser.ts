/** Local-only synthetic probe. No daemon, credentials, provider or live effects.
 * bun scripts/verify-trust-boundaries-browser.ts; open the printed URL and click
 * Check boundaries. Expect zero image requests/active elements/executable links,
 * three image links/tables, scriptExecuted false. Ctrl-C stops the fixture.
 */
import { richAttack } from '../src/trust-boundaries/fixtures';
const build = await Bun.build({ entrypoints: [new URL('./fixtures/q21-render.tsx', import.meta.url).pathname],
  target: 'browser', minify: false });
if (!build.success) throw new Error('Synthetic renderer build failed');
const js = build.outputs.find(output => output.path.endsWith('.js'))!;
const css = build.outputs.find(output => output.path.endsWith('.css'));
let imageRequests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/probe.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
  if (path === '/probe.css') return new Response(css ?? '', { headers: { 'content-type': 'text/css' } });
  if (path === '/metrics') return Response.json({ imageRequests });
  if (path === '/q21-image-probe') { imageRequests++; return new Response('Synthetic image request'); }
  if (path === '/api/pebble/answers/q21') return Response.json({ id: 'q21', prompt: 'Synthetic answer', response: richAttack, created_at: 1 });
  if (path === '/api/agents/tasks/q21') return Response.json({ id: 'q21', agent_id: 'fixture', agent_name: 'Fixture', specialist: 'fixture',
    task: 'Synthetic completed task', status: 'completed', started_at: 1, completed_at: 2, elapsed_seconds: 1,
    response: richAttack, summary: null, tools_used: [], tokens_used: null });
  if (path !== '/') return new Response('Not found', { status: 404 });
  return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Q-21 boundary probe</title>'
    + '<link rel="stylesheet" href="/probe.css"><style>body{font:16px sans-serif;margin:24px;color:#222;background:#fff}section{margin:24px 0;padding:16px;border:1px solid #aaa}a{color:#1463c0}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:5px}</style>'
    + '</head><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
} });
console.log(`Q-21 synthetic probe: ${server.url}`);
