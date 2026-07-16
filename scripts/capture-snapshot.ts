/**
 * Live-capture helper for the template LIVE-VERIFY pass.
 *
 * Spawns an isolated headless Chromium on the given port, navigates with the
 * REAL BrowserController (same snapshot pipeline templates run against), and
 * prints the LLM-facing snapshot: Page/URL, Page Text, and every interactive
 * element with its attrs. Optionally clicks an element and re-snapshots.
 *
 * Usage:
 *   bun run scripts/capture-snapshot.ts <port> <url> [--click <element_id>] [--full-text]
 *
 * Each invocation is self-contained (own chromium + tmp profile, killed on
 * exit) so parallel captures just need distinct ports.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserController } from '../src/actions/browser/session.ts';

const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  '/snap/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean) as string[];

const [portArg, url, ...rest] = process.argv.slice(2);
if (!portArg || !url) {
  console.error('usage: bun run scripts/capture-snapshot.ts <port> <url> [--click <id>] [--full-text]');
  process.exit(1);
}
const port = Number(portArg);
const clickIdx = rest.indexOf('--click');
const clickId = clickIdx >= 0 ? Number(rest[clickIdx + 1]) : null;
const fullText = rest.includes('--full-text');

const exe = CHROMIUM_CANDIDATES.find(p => existsSync(p!));
if (!exe) {
  console.error('no chromium found');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), `jarvis-capture-${port}-`));
const proc = Bun.spawn([
  exe,
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-sandbox',
  '--no-first-run',
  '--disable-dev-shm-usage',
  '--window-size=1280,900',
  '--lang=en-US',
  '--accept-lang=en-US,en',
  'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });

function printSnapshot(snap: Awaited<ReturnType<BrowserController['snapshot']>>) {
  console.log(`Page: ${snap.title}`);
  console.log(`URL: ${snap.url}`);
  console.log('--- Page Text ---');
  console.log(fullText ? snap.text : snap.text.slice(0, 2500));
  console.log(`--- Interactive Elements (${snap.elements.length}) ---`);
  for (const el of snap.elements) {
    const attrs = Object.entries(el.attrs)
      .filter(([k]) => k !== 'id' || el.attrs[k]!.length < 40)
      .map(([k, v]) => `${k}="${v!.slice(0, 90)}"`)
      .join(' ');
    console.log(`[${el.id}] ${el.tag}${el.text ? ` "${el.text.slice(0, 60)}"` : ''} ${attrs}`);
  }
}

try {
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) { up = true; break; }
    } catch { /* not yet */ }
    await Bun.sleep(250);
  }
  if (!up) throw new Error('chromium CDP did not come up');

  const browser = new BrowserController(port);
  const snap = await browser.navigate(url);
  printSnapshot(snap);

  if (clickId !== null && !Number.isNaN(clickId)) {
    console.log(`\n=== after click [${clickId}] ===`);
    console.log(await browser.click(clickId));
    printSnapshot(await browser.snapshot());
  }

  await browser.disconnect();
} catch (err) {
  console.error(`CAPTURE ERROR: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
} finally {
  proc.kill();
  rmSync(profile, { recursive: true, force: true });
}
