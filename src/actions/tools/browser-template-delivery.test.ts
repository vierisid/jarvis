/**
 * Integration test: webapp templates are delivered by the URL the browser
 * actually lands on — through the real browser_navigate / browser_snapshot
 * tools (createBrowserTools) against a live headless Chromium, with pages
 * served over HTTP so the template domain matching sees real hostnames.
 * Skipped when no Chromium executable is available.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserController } from '../browser/session.ts';
import { createBrowserTools } from './builtin.ts';
import { initDatabase } from '../../vault/schema.ts';
import { upsertWebappTemplate } from '../../vault/webapp-templates.ts';

const TEST_CDP_PORT = 9778;

const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  '/snap/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean) as string[];

const chromiumExe = CHROMIUM_CANDIDATES.find(p => existsSync(p));

function toolMap(ctrl: BrowserController) {
  return new Map(createBrowserTools(ctrl).map(t => [t.name, t.execute]));
}

describe.skipIf(!chromiumExe)('webapp template delivery via browser tools (integration)', () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let profileDir: string;
  let server: ReturnType<typeof Bun.serve>;
  let ctrl: BrowserController;
  let tools: Map<string, (params: Record<string, unknown>) => Promise<unknown>>;

  beforeAll(async () => {
    initDatabase(':memory:');

    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new Response(
          `<!DOCTYPE html><html><head><title>Fixture</title></head><body>
             <p>fixture page at ${new URL(req.url).pathname}</p>
             <a href="/next" style="display:block;width:100px;height:20px">Next page</a>
           </body></html>`,
          { headers: { 'content-type': 'text/html' } },
        ),
    });

    upsertWebappTemplate({
      app_name: 'LoopbackApp',
      domains: ['127.0.0.1'],
      description: '',
      instructions: 'LoopbackApp playbook: verify before clicking.',
    });
    upsertWebappTemplate({
      app_name: 'LocalhostApp',
      domains: ['localhost'],
      description: '',
      instructions: 'LocalhostApp playbook: URL-first.',
    });

    profileDir = mkdtempSync(join(tmpdir(), 'jarvis-template-delivery-'));
    proc = Bun.spawn([
      chromiumExe!,
      '--headless=new',
      `--remote-debugging-port=${TEST_CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-sandbox',
      '--no-first-run',
      '--disable-dev-shm-usage',
      'about:blank',
    ], { stdout: 'ignore', stderr: 'ignore' });

    // Generous deadline: on loaded CI runners a headless Chromium can take
    // well over 15s to start (see the flaky hook-timeout failures on
    // ubuntu-latest).
    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_CDP_PORT}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) { up = true; break; }
      } catch { /* not up yet */ }
      await Bun.sleep(250);
    }
    if (!up) throw new Error(`Chromium CDP did not come up on port ${TEST_CDP_PORT}`);

    ctrl = new BrowserController(TEST_CDP_PORT);
    tools = toolMap(ctrl);
  }, 60_000);

  afterAll(async () => {
    proc?.kill();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    server?.stop(true);
  });

  test('navigate delivers the site template exactly once', async () => {
    const navigate = tools.get('browser_navigate')!;
    const snapshot = tools.get('browser_snapshot')!;

    const first = await navigate({ url: `http://127.0.0.1:${server.port}/inbox` }) as string;
    expect(first).toContain('Page: Fixture');
    expect(first).toContain('You are now on LoopbackApp');
    expect(first).toContain('LoopbackApp playbook: verify before clicking.');

    // Same site again — snapshot and navigate both stay clean
    const snap = await snapshot({}) as string;
    expect(snap).not.toContain('You are now on LoopbackApp');
    const second = await navigate({ url: `http://127.0.0.1:${server.port}/other` }) as string;
    expect(second).not.toContain('You are now on LoopbackApp');
  }, 30_000);

  test('moving to a different known site delivers that site template', async () => {
    const navigate = tools.get('browser_navigate')!;
    const result = await navigate({ url: `http://localhost:${server.port}/` }) as string;
    expect(result).toContain('You are now on LocalhostApp');
    expect(result).toContain('LocalhostApp playbook: URL-first.');
    expect(result).not.toContain('LoopbackApp');
  }, 30_000);

  test('snapshot after a link click delivers the template when the domain is new to the conversation', async () => {
    // Get on the page with the already-delivered tool set, then act through a
    // FRESH tool set (a new conversation): its first sight of the domain is
    // the snapshot after the click, which must deliver.
    const nav = await tools.get('browser_navigate')!({ url: `http://127.0.0.1:${server.port}/start` }) as string;
    const linkId = nav.match(/\[(\d+)\] a "Next page"/)?.[1];
    expect(linkId).toBeTruthy();

    const freshTools = toolMap(ctrl);
    await freshTools.get('browser_click')!({ element_id: Number(linkId) });
    const snap = await freshTools.get('browser_snapshot')!({}) as string;
    expect(snap).toContain('You are now on LoopbackApp');
  }, 30_000);

  test('separate tool sets deliver independently (main vs background agent)', async () => {
    // `tools` delivered LoopbackApp long ago in this file; a brand-new tool
    // set navigating to the same site must still get its own copy.
    const other = toolMap(ctrl);
    const result = await other.get('browser_navigate')!({ url: `http://127.0.0.1:${server.port}/again` }) as string;
    expect(result).toContain('You are now on LoopbackApp');
  }, 30_000);
});
