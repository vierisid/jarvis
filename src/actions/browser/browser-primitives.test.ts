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

    // Same-origin iframe with interactive content (frames[0])
    const f1 = document.createElement('iframe');
    f1.style.cssText = 'width:300px;height:120px;border:0;display:block';
    document.body.appendChild(f1);
    f1.contentDocument.write('<button aria-label="frame button" style="width:120px;height:30px">Frame Button</button><input aria-label="frame input" type="text">');
    f1.contentDocument.close();
    f1.contentDocument.querySelector('button').addEventListener('click', () => parent.__events.push('frame-click'));

    // Tiny clipped iframe hiding a contenteditable — simulates Google Docs'
    // texteventtarget iframe (frames[1])
    const f2 = document.createElement('iframe');
    f2.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:0;top:0';
    document.body.appendChild(f2);
    f2.contentDocument.write('<div contenteditable="true" role="textbox" aria-label="docs editor"></div>');
    f2.contentDocument.close();
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

    // Wait for CDP to come up. Generous deadline: on loaded CI runners a
    // headless Chromium can take well over 15s to start (see the flaky
    // hook-timeout failures on ubuntu-latest).
    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) { up = true; break; }
      } catch { /* not up yet */ }
      await Bun.sleep(250);
    }
    if (!up) throw new Error(`Chromium CDP did not come up on port ${TEST_PORT}`);

    browser = new BrowserController(TEST_PORT);
    await browser.navigate(`data:text/html,${encodeURIComponent(TEST_PAGE)}`);
    // 90s, not 60s: the poll alone may run ~46s and navigate() carries an
    // internal 30s load wait — the hook must exceed their sum.
  }, 90_000);

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

  test('snapshot does not throw on a page with no body (WAF/challenge pages)', async () => {
    // Some bot-wall / challenge pages have a null document.body; the snapshot
    // must return an empty-text snapshot so callers can detect the wall,
    // instead of throwing an opaque error. Use a throwaway page and restore
    // the shared TEST_PAGE afterwards so sibling tests are unaffected.
    await browser.navigate('data:text/html,' + encodeURIComponent('<html><body>gone</body></html>'));
    await browser.evaluate('document.body.remove()');
    const snap = await browser.snapshot();
    expect(snap.text).toBe('');
    expect(Array.isArray(snap.elements)).toBe(true);
    await browser.navigate(`data:text/html,${encodeURIComponent(TEST_PAGE)}`);
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

  test('snapshot traverses same-origin iframes with offset coordinates', async () => {
    const snap = await browser.snapshot();
    const frameBtn = snap.elements.find(e => e.attrs['aria-label'] === 'frame button');
    expect(frameBtn).toBeDefined();
    expect(frameBtn!.attrs.iframe).toBe('true');

    // Clicking by the offset coordinates must reach the button INSIDE the frame
    await browser.click(frameBtn!.id);
    expect(await browser.evaluate('window.__events') as string[]).toContain('frame-click');
  }, 20_000);

  test('type works on inputs inside iframes', async () => {
    const snap = await browser.snapshot();
    const frameInput = snap.elements.find(e => e.attrs['aria-label'] === 'frame input');
    expect(frameInput).toBeDefined();

    await browser.type(frameInput!.id, 'typed in frame');
    expect(await browser.evaluate('frames[0].document.querySelector("input").value'))
      .toBe('typed in frame');
  }, 20_000);

  test('hidden-iframe contenteditable (Google Docs pattern) is visible and typable', async () => {
    const snap = await browser.snapshot();
    // 1x1 clipped iframe — the typing-target exemption must keep this element
    const editor = snap.elements.find(e => e.attrs['aria-label'] === 'docs editor');
    expect(editor).toBeDefined();
    expect(editor!.attrs.iframe).toBe('true');

    await browser.type(editor!.id, 'Hello Docs');
    await browser.type(editor!.id, ' and more', false, true); // append
    expect(await browser.evaluate('frames[1].document.querySelector("[contenteditable]").innerText'))
      .toBe('Hello Docs and more');
  }, 20_000);

  test('iframe text appears in the page text', async () => {
    const snap = await browser.snapshot();
    expect(snap.text).toContain('Frame Button');
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
