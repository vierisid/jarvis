/**
 * Integration tests for #521: the model-driven browser must not load local
 * files, whichever way it is pointed at one, and must still load the web.
 *
 * Spawns its own headless Chromium on a random port with a throwaway profile,
 * like browser-primitives.test.ts, and is skipped when no Chromium exists.
 * `--no-sandbox` here only keeps the test runnable on CI hosts without user
 * namespaces; the sandbox itself is covered by chrome-sandbox.test.ts.
 *
 * Leak assertions look for a random marker written into a temp file, not for
 * /etc/hostname's contents, which are a few common letters that any error
 * page could contain.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserController } from './session.ts';
import { CDPClient } from './cdp.ts';

const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  '/snap/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean) as string[];

const chromiumExe = CHROMIUM_CANDIDATES.find(p => existsSync(p));

// Not 9222/9223 (the daemon's) nor 9777/9778 (the other browser suites).
// Asked of the kernel rather than picked at random, so it cannot land on a
// port another test's server already holds (Chrome would then start without
// its DevTools endpoint).
const TEST_PORT = (() => {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
})();
const MARKER = `local-file-marker-${crypto.randomUUID()}`;

/**
 * afterAll cannot run when the test process is SIGKILLed (the pre-commit
 * cap's escalation, a developer's kill -9), and a detached Chromium would
 * then be orphaned to PID 1. Where util-linux's setpriv exists, have the
 * kernel kill it with its parent instead; setpriv execs Chromium in place, so
 * the pid stays Chromium's, and Chromium's children exit with it (verified).
 * The signal fires when the spawning THREAD exits, not the process; that is
 * the same thing here because Bun.spawn runs on the JS thread.
 * TODO: switch to the shared watchdog fixture from fix/524-review-followups
 * (src/actions/browser/fixtures/headless-chromium.ts) once that lands.
 */
function parentDeathWrapper(): string[] {
  if (process.platform !== 'linux') return [];
  const setpriv = ['/usr/bin/setpriv', '/bin/setpriv'].find(p => existsSync(p));
  return setpriv ? [setpriv, '--pdeathsig', 'KILL'] : [];
}

/** Pids of processes whose command line names `profile` (Linux only; [] elsewhere). */
function profileProcesses(profile: string): number[] {
  if (process.platform !== 'linux') return [];
  return readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes(profile); } catch { return false; }
  });
}

/** Poll until `probe` returns a truthy value, or give up after `ms`. */
async function until<T>(probe: () => Promise<T> | T, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await probe();
  while (!last && Date.now() < deadline) {
    await Bun.sleep(100);
    last = await probe();
  }
  return last;
}

describe.skipIf(!chromiumExe)('browser local-file lockdown (integration, #521)', () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let profileDir: string;
  let fixtureDir: string;
  let markerUrl: string;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let browser: BrowserController;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'jarvis-local-files-'));
    const markerPath = join(fixtureDir, 'secret.txt');
    writeFileSync(markerPath, MARKER);
    markerUrl = pathToFileURL(markerPath).href;

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        const html = (body: string) => new Response(`<!DOCTYPE html><html><body>${body}</body></html>`, {
          headers: { 'content-type': 'text/html' },
        });
        if (pathname === '/redirect') return new Response(null, { status: 302, headers: { location: markerUrl } });
        if (pathname === '/redirect-devtools') {
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${TEST_PORT}/json/version` } });
        }
        if (pathname === '/iframe') return html(`<p>outer page</p><iframe id="f" src="${markerUrl}"></iframe>`);
        if (pathname === '/upload') return html('<input id="up" type="file">');
        return html('<p>hello over http</p>');
      },
    });
    base = `http://127.0.0.1:${server.port}`;

    profileDir = mkdtempSync(join(tmpdir(), 'jarvis-local-files-profile-'));
    proc = Bun.spawn([
      ...parentDeathWrapper(),
      chromiumExe!,
      '--headless=new',
      `--remote-debugging-port=${TEST_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-sandbox',
      '--no-first-run',
      '--disable-dev-shm-usage',
      'about:blank',
    // Own process group, so afterAll can kill the zygote and renderers too.
    ], { stdout: 'ignore', stderr: 'ignore', detached: true });

    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) { up = true; break; }
      } catch { /* not up yet */ }
      await Bun.sleep(250);
    }
    if (!up) throw new Error(`Chromium CDP did not come up on port ${TEST_PORT}`);

    browser = new BrowserController(TEST_PORT);
    await browser.navigate(`${base}/`);
  }, 90_000);

  afterAll(async () => {
    try { await browser?.disconnect(); } catch { /* already gone */ }
    if (proc) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* group gone */ }
      proc.kill(9);
      await proc.exited;
    }
    server?.stop(true);
    if (profileDir) {
      // A child still shutting down recreates files in the profile; wait for
      // every process naming it to be gone before removing it.
      await until(() => profileProcesses(profileDir).length === 0, 5000);
      rmSync(profileDir, { recursive: true, force: true });
    }
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  /** Everything the model could read from the current tab, as one string. */
  async function visible(): Promise<string> {
    const snap = await browser.snapshot();
    const frames = await browser.evaluate(`(() => {
      const out = [];
      for (const f of document.querySelectorAll('iframe')) {
        try { out.push(f.contentDocument ? f.contentDocument.documentElement.outerHTML : 'no-doc'); }
        catch (e) { out.push('cross-origin'); }
      }
      return out.join('\\n');
    })()`) as string;
    return JSON.stringify(snap) + frames;
  }

  /** Open a raw CDP session on the tab the controller drives, bypassing navigate(). */
  async function rawPageSession(): Promise<CDPClient> {
    const targets = await (await fetch(`http://127.0.0.1:${TEST_PORT}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(t => t.type === 'page' && t.url.startsWith(base));
    if (!page) throw new Error('no page on the fixture server');
    const cdp = new CDPClient();
    await cdp.connect(page.webSocketDebuggerUrl);
    return cdp;
  }

  test('http still works', async () => {
    const snap = await browser.navigate(`${base}/`);
    expect(snap.text).toContain('hello over http');
    expect(snap.url).toStartWith(base);
  }, 30_000);

  test('navigate refuses file:///etc/hostname with a clear error, before touching Chrome', async () => {
    await browser.navigate(`${base}/`);
    await expect(browser.navigate('file:///etc/hostname')).rejects.toThrow(/Refusing to open file:\/\/\/etc\/hostname: the browser does not open local files/);
    // Spelling variants the WHATWG parser folds into file:.
    for (const url of ['FILE:///etc/hostname', '  file:///etc/hostname', 'file:/etc/hostname', 'view-source:file:///etc/hostname', 'filesystem:file:///x']) {
      await expect(browser.navigate(url)).rejects.toThrow(/Refusing to open/);
    }
    await expect(browser.navigate(markerUrl)).rejects.toThrow(/Refusing to open/);
    expect(await browser.evaluate('location.href')).toStartWith(base);
  }, 30_000);

  test('an http redirect to a local file does not load it', async () => {
    let text = '';
    try {
      text = JSON.stringify(await browser.navigate(`${base}/redirect`));
    } catch (err) {
      text = String(err);
    }
    expect(text.includes(MARKER)).toBe(false);
    expect(await browser.evaluate('location.protocol')).not.toBe('file:');
    expect((await visible()).includes(MARKER)).toBe(false);
  }, 30_000);

  test('window.location from page script does not load a local file', async () => {
    await browser.navigate(`${base}/`);
    await browser.evaluate(`location.href = ${JSON.stringify(markerUrl)}`);
    await Bun.sleep(1000);
    expect(await browser.evaluate('location.protocol')).not.toBe('file:');
    expect((await visible()).includes(MARKER)).toBe(false);
  }, 30_000);

  test('an iframe pointing at a local file does not load it', async () => {
    const snap = await browser.navigate(`${base}/iframe`);
    expect(snap.text).toContain('outer page');
    expect((await visible()).includes(MARKER)).toBe(false);
  }, 30_000);

  test('the in-browser guard blocks file: even when Page.navigate skips the URL check', async () => {
    // Simulates any path around checkNavigationUrl: a future caller that
    // forgets it, a parser disagreement. Only the guard stands here.
    await browser.navigate(`${base}/`);
    const cdp = await rawPageSession();
    try {
      const result = await cdp.send('Page.navigate', { url: markerUrl });
      expect(result.errorText).toBe('net::ERR_BLOCKED_BY_CLIENT');
      await Bun.sleep(500);
      const body = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
      expect(String(body.result?.value).includes(MARKER)).toBe(false);
    } finally {
      await cdp.close();
    }
  }, 30_000);

  test('a tab opened through the DevTools endpoint cannot load a local file either', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/json/new?${markerUrl}`, { method: 'PUT' });
    expect(res.ok).toBe(true);
    const tab = await res.json() as { id: string; webSocketDebuggerUrl: string };
    const cdp = new CDPClient();
    try {
      await cdp.connect(tab.webSocketDebuggerUrl);
      // Wait for the tab to settle on SOMETHING other than its initial blank
      // page, so the assertion below is about a load that happened.
      const settled = await until(async () => {
        const tree = await cdp.send('Page.getFrameTree');
        const url = String(tree.frameTree?.frame?.url ?? '');
        return url && url !== 'about:blank' ? url : '';
      });
      expect(settled).toStartWith('chrome-error://');
      const body = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
      expect(String(body.result?.value).includes(MARKER)).toBe(false);
    } finally {
      await cdp.close();
      await fetch(`http://127.0.0.1:${TEST_PORT}/json/close/${tab.id}`).catch(() => {});
    }
  }, 30_000);

  test("the browser's DevTools endpoint is refused at navigate time and blocked in the browser", async () => {
    await browser.navigate(`${base}/`);
    await expect(browser.navigate(`http://127.0.0.1:${TEST_PORT}/json/version`)).rejects.toThrow(/DevTools endpoint/);
    await expect(browser.navigate(`http://localhost:${TEST_PORT}/json/list`)).rejects.toThrow(/DevTools endpoint/);

    const cdp = await rawPageSession();
    try {
      const result = await cdp.send('Page.navigate', { url: `http://127.0.0.1:${TEST_PORT}/json/version` });
      expect(result.errorText).toBe('net::ERR_BLOCKED_BY_CLIENT');
    } finally {
      await cdp.close();
    }
  }, 30_000);

  test('a tab that reached a local file while the guard was down is never read', async () => {
    // Simulate the gap: drop the guard's socket, and load the file with a raw
    // CDP call. (Chrome continues paused requests when the guard's socket
    // closes, so this is also what a guard dying mid-request looks like.)
    await browser.navigate(`${base}/`);
    await (browser as unknown as { requestGuard: { close(): Promise<void> } }).requestGuard.close();
    const cdp = await rawPageSession();
    try {
      await cdp.send('Page.navigate', { url: markerUrl });
      // The file really loaded, so the refusals below are the backstop working.
      const loaded = await until(async () => {
        const r = await cdp.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
        return String(r.result?.value).includes(MARKER);
      });
      expect(loaded).toBe(true);
    } finally {
      await cdp.close();
    }

    // Every read reconnects first (the guard is gone) and re-arms the guard.
    // The file tab is then the only page, so connect() adopts and blanks it:
    // what this pins is the reconnect path, not the per-read frame check,
    // which the fake-Chrome suite (session-guards.test.ts) covers directly.
    for (const read of [() => browser.snapshot(), () => browser.evaluate('document.body.innerText'), () => browser.screenshotBuffer()]) {
      let out = '';
      try { out = JSON.stringify(await read()); } catch (err) { out = String(err); }
      expect(out.includes(MARKER)).toBe(false);
    }
    expect(await browser.evaluate('location.protocol')).not.toBe('file:');

    // History still holds the file entry. Going back to it must not expose
    // it either. Best effort: whether Chrome restores the entry from the
    // back/forward cache (no request, so only the read check stands) or
    // reloads it (the re-armed guard blocks it) is Chrome's choice, and this
    // does not assert which happened -- only that nothing leaked.
    await browser.navigate(`${base}/`);
    await browser.evaluate('history.go(-2)').catch(() => {});
    await Bun.sleep(1000);
    for (const read of [() => browser.snapshot(), () => browser.evaluate('document.body.innerText'), () => browser.screenshotBuffer()]) {
      let out = '';
      try { out = JSON.stringify(await read()); } catch (err) { out = String(err); }
      expect(out.includes(MARKER)).toBe(false);
    }
  }, 45_000);

  test('connect() passes over a tab already showing a local file for a drivable one', async () => {
    // Build the state a fresh daemon can inherit: a Chrome with a web tab and
    // a tab that loaded a local file while no guard was armed.
    await browser.navigate(`${base}/`);
    await browser.disconnect(); // closes the guard; this Chrome is not ours to stop
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/json/new?${markerUrl}`, { method: 'PUT' });
    const fileTab = await res.json() as { id: string; webSocketDebuggerUrl: string };
    const raw = new CDPClient();
    try {
      await raw.connect(fileTab.webSocketDebuggerUrl);
      const loaded = await until(async () => {
        const r = await raw.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
        return String(r.result?.value).includes(MARKER);
      });
      expect(loaded).toBe(true);
    } finally {
      await raw.close();
    }

    const fresh = new BrowserController(TEST_PORT);
    try {
      const snap = await fresh.snapshot();
      expect(snap.url).toStartWith(base);
      expect(JSON.stringify(snap).includes(MARKER)).toBe(false);
      // The file tab was left alone, not driven.
      const tabs = await (await fetch(`http://127.0.0.1:${TEST_PORT}/json/list`)).json() as Array<{ id: string; url: string }>;
      expect(tabs.find(t => t.id === fileTab.id)?.url).toBe(markerUrl);
    } finally {
      await fresh.disconnect();
      await fetch(`http://127.0.0.1:${TEST_PORT}/json/close/${fileTab.id}`).catch(() => {});
    }
  }, 45_000);

  test('a redirect into the DevTools endpoint is blocked in the browser and reported', async () => {
    // Chrome allows http -> http redirects, so this one is the guard's alone.
    await expect(browser.navigate(`${base}/redirect-devtools`)).rejects.toThrow(
      new RegExp(`was blocked: it led to http://127\\.0\\.0\\.1:${TEST_PORT}/json/version`),
    );
  }, 30_000);

  test('page script cannot reach the DevTools endpoint either', async () => {
    await browser.navigate(`${base}/`);
    const out = await browser.evaluate(
      // no-cors: without the guard this resolves (opaque, status 0), so a
      // rejection here is the guard and not CORS.
      `fetch('http://127.0.0.1:${TEST_PORT}/json/list', { mode: 'no-cors' }).then(r => 'status ' + r.status).catch(e => 'blocked: ' + e.message)`,
    );
    expect(String(out)).toStartWith('blocked:');
  }, 30_000);

  test('other browser-internal schemes are refused', async () => {
    for (const url of ['chrome://settings/passwords', 'about:settings', 'about:version', 'javascript:alert(1)', 'devtools://devtools/bundled/inspector.html']) {
      await expect(browser.navigate(url)).rejects.toThrow(/Refusing to open/);
    }
    // about:blank and data: stay available.
    await browser.navigate('about:blank');
    const snap = await browser.navigate(`data:text/html,${encodeURIComponent('<p>inline page</p>')}`);
    expect(snap.text).toContain('inline page');
  }, 30_000);

  test('uploadFile sends an ordinary file and refuses a sensitive one', async () => {
    await browser.navigate(`${base}/upload`);
    await expect(browser.uploadFile('/proc/self/environ', '#up')).rejects.toThrow(/Refusing to upload \/proc\/self\/environ/);
    expect(await browser.evaluate('document.getElementById("up").files.length')).toBe(0);

    const ok = join(fixtureDir, 'report.txt');
    writeFileSync(ok, 'an ordinary file');
    expect(await browser.uploadFile(ok, '#up')).toContain('Uploaded file');
    expect(await browser.evaluate('document.getElementById("up").files[0].name')).toBe('report.txt');
  }, 30_000);
});
