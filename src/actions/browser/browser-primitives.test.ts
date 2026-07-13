/**
 * Integration tests for the browser interaction primitives:
 * hover, press_key, right/double click, and browser_type append mode.
 *
 * Spawns its own headless Chromium on a test port (BrowserController attaches
 * to it instead of launching a headed window via WSLg). Skipped entirely when
 * no Chromium executable is available.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserController } from './session.ts';

const TEST_PORT = 9777;

const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  '/snap/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean) as string[];

const chromiumExe = CHROMIUM_CANDIDATES.find(p => existsSync(p));

const TEST_PAGE = `<!DOCTYPE html>
<html><body>
  <div id="message" role="row" style="width:200px;height:40px;background:#eee">A message row</div>
  <button id="reaction" style="display:none">Add reaction</button>
  <input id="field" type="text" value="hello">
  <div id="editor" contenteditable="true" role="textbox" style="width:200px;height:40px">first line</div>
  <button id="clickme" style="width:100px;height:30px">Click target</button>
  <script>
    window.__events = [];
    const msg = document.getElementById('message');
    msg.addEventListener('mouseenter', () => {
      document.getElementById('reaction').style.display = 'block';
    });
    document.addEventListener('keydown', (e) => {
      window.__events.push('key:' + (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key);
    });
    const btn = document.getElementById('clickme');
    btn.addEventListener('dblclick', () => window.__events.push('dblclick'));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); window.__events.push('contextmenu'); });
  </script>
</body></html>`;

describe.skipIf(!chromiumExe)('browser primitives (integration)', () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let profileDir: string;
  let browser: BrowserController;

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'jarvis-browser-test-'));
    proc = Bun.spawn([
      chromiumExe!,
      '--headless=new',
      `--remote-debugging-port=${TEST_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-sandbox',
      '--no-first-run',
      '--disable-dev-shm-usage',
      'about:blank',
    ], { stdout: 'ignore', stderr: 'ignore' });

    // Wait for CDP to come up
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) break;
      } catch { /* not up yet */ }
      await Bun.sleep(250);
    }

    browser = new BrowserController(TEST_PORT);
    await browser.navigate(`data:text/html,${encodeURIComponent(TEST_PAGE)}`);
  }, 30_000);

  afterAll(async () => {
    try { await browser?.disconnect(); } catch { /* already gone */ }
    proc?.kill();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  });

  async function events(): Promise<string[]> {
    return await browser.evaluate('window.__events') as string[];
  }

  function findId(snap: Awaited<ReturnType<BrowserController['snapshot']>>, attrId: string): number | undefined {
    return snap.elements.find(e => e.attrs.id === attrId)?.id;
  }

  test('hover reveals hover-only elements in the next snapshot', async () => {
    let snap = await browser.snapshot();
    expect(findId(snap, 'reaction')).toBeUndefined(); // hidden before hover

    const msgId = findId(snap, 'message');
    expect(msgId).toBeDefined();
    const result = await browser.hover(msgId!);
    expect(result).toContain('Hovering');

    snap = await browser.snapshot();
    const reactionId = findId(snap, 'reaction');
    expect(reactionId).toBeDefined(); // revealed by hover

    // The revealed element is clickable
    const clickResult = await browser.click(reactionId!);
    expect(clickResult).toContain('Clicked');
  }, 20_000);

  test('pressKey sends plain and modified keys to the page', async () => {
    expect(await browser.pressKey('Escape')).toBe('Pressed Escape');
    expect(await browser.pressKey('Ctrl+K')).toBe('Pressed Ctrl+K');
    expect(await browser.pressKey('Shift+Enter')).toBe('Pressed Shift+Enter');

    const evts = await events();
    expect(evts).toContain('key:Escape');
    expect(evts).toContain('key:Ctrl+k');
    expect(evts).toContain('key:Shift+Enter');
  }, 20_000);

  test('pressKey rejects unsupported combos with a helpful error', async () => {
    const result = await browser.pressKey('Hyper+Q');
    expect(result).toStartWith('Error: Unsupported key');
  }, 10_000);

  test('type replaces by default and appends with append=true', async () => {
    const snap = await browser.snapshot();
    const fieldId = findId(snap, 'field');
    expect(fieldId).toBeDefined();

    await browser.type(fieldId!, 'replaced');
    expect(await browser.evaluate('document.getElementById("field").value')).toBe('replaced');

    await browser.type(fieldId!, ' plus appended', false, true);
    expect(await browser.evaluate('document.getElementById("field").value')).toBe('replaced plus appended');
  }, 20_000);

  test('append works on contenteditable without destroying content', async () => {
    const snap = await browser.snapshot();
    const editorId = findId(snap, 'editor');
    expect(editorId).toBeDefined();

    await browser.type(editorId!, ' second part', false, true);
    const content = await browser.evaluate('document.getElementById("editor").innerText');
    expect(content).toBe('first line second part');

    // And replace semantics still clear it
    await browser.type(editorId!, 'fresh');
    expect(await browser.evaluate('document.getElementById("editor").innerText')).toBe('fresh');
  }, 20_000);

  test('double click and right click dispatch real events', async () => {
    const snap = await browser.snapshot();
    const btnId = findId(snap, 'clickme');
    expect(btnId).toBeDefined();

    expect(await browser.click(btnId!, { double: true })).toContain('Double-clicked');
    expect(await browser.click(btnId!, { button: 'right' })).toContain('Right-clicked');

    const evts = await events();
    expect(evts).toContain('dblclick');
    expect(evts).toContain('contextmenu');
  }, 20_000);
});
