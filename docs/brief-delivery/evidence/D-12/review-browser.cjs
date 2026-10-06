// R1: interrupt an entering tab through the specimen's real metadata action.
// No model, account or live conversation is connected.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4392/?brief=preview&specimen=chat-tabs#/_brief_preview';
const button = (page, name) => page.getByRole('button', { name, exact: true });

async function interruptEntry(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const header = document.querySelector('.brief-chat-tabs-header');
    const original = new Set([...header.querySelectorAll('[data-chat-id]')].map(el => el.dataset.chatId));
    let slot, id, enteredAt, exit, frame;
    const timer = setTimeout(() => finish(new Error('Interrupted tab did not finish exiting')), 4000);
    const finish = error => {
      clearTimeout(timer); cancelAnimationFrame(frame); observer.disconnect();
      if (error) reject(error); else resolve({ id, ...exit, removed: true });
    };
    const observer = new MutationObserver(() => {
      if (!slot) {
        const added = [...header.querySelectorAll('[data-chat-id]')].find(el => !original.has(el.dataset.chatId));
        if (!added) return;
        id = added.dataset.chatId; slot = added.closest('.brief-chat-tab-slot'); enteredAt = performance.now();
        // Let Chrome present part of entry, then close while it is still growing.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => added.querySelector('.brief-chat-tab-close').click());
        });
      }
      if (!slot.isConnected) {
        if (!exit) return finish(new Error('Entering tab unmounted without an exit'));
        return finish();
      }
      if (!exit && slot.dataset.exiting === 'true') {
        const animation = slot.getAnimations()[0];
        const keyframes = animation?.effect?.getKeyframes();
        exit = {
          elapsedFromEntry: performance.now() - enteredAt,
          inert: slot.inert, hidden: slot.getAttribute('aria-hidden'),
          duration: animation?.effect?.getTiming().duration,
          fromWidth: parseFloat(keyframes?.[0]?.width), toWidth: parseFloat(keyframes?.at(-1)?.width),
          visibleWidth: parseFloat(getComputedStyle(slot).width),
          selected: document.querySelector('.d12-example-panel').dataset.activeChat,
        };
      }
    });
    observer.observe(header, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-exiting'] });
    header.querySelector('[aria-label="New conversation"]').click();
  }));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [], errors = [];
  try {
    for (const theme of ['light', 'dark']) for (const rail of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1150 }, reducedMotion: 'no-preference' });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await button(page, 'Open conversation').waitFor();
      if (await page.locator('.brief-today-specimen').getAttribute('data-brief-theme') !== theme) await button(page, `Switch to ${theme}`).click();
      if (rail) await button(page, 'Collapse sidebar').click();
      await button(page, 'Open conversation').click(); await page.waitForTimeout(380);
      const plusBefore = await button(page, 'New conversation').boundingBox();
      const closeBefore = await button(page, 'Close conversation').boundingBox();
      const cycles = [];
      for (let index = 0; index < 10; index++) {
        const result = await interruptEntry(page);
        assert.ok(result.elapsedFromEntry < 180, `Entry already settled: ${JSON.stringify(result)}`);
        assert.equal(result.inert, true); assert.equal(result.hidden, 'true');
        assert.equal(result.duration, 180); assert.ok(result.fromWidth > 0); assert.equal(result.toWidth, 0);
        assert.ok(result.visibleWidth > 0); assert.equal(result.selected, 'investor');
        assert.equal(await page.locator('.brief-chat-tab-slot').count(), 2);
        assert.deepEqual(await button(page, 'New conversation').boundingBox(), plusBefore);
        assert.deepEqual(await button(page, 'Close conversation').boundingBox(), closeBefore);
        cycles.push(result);
      }
      await page.screenshot({ path: path.join(__dirname, `review-tabs-${theme}-${rail ? 'rail' : 'expanded'}.png`) });
      results.push({ theme, rail, cycles }); console.log(`PASS ${theme} ${rail ? 'rail' : 'expanded'}: 10 interrupted entries`);
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(__dirname, 'review-browser-results.json'), JSON.stringify({ base, browser: await browser.version(), results, errors,
      limits: ['Specimen owner, not live F-04 transport.', 'Durations are design values, not frame-rate certification.'] }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
