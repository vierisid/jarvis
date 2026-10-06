// Inspect actual WAAPI intermediate frames, not only the settled textarea.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4393/?brief=preview&specimen=composer#/_brief_preview';
const button = (p, name) => p.getByRole('button', { name, exact: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }), results = [];
  try {
    for (const theme of ['light', 'dark']) for (const rail of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1150 }, reducedMotion: 'no-preference' });
      const page = await context.newPage(); await page.goto(base);
      await button(page, 'Open conversation').waitFor();
      if (await page.locator('.brief-today-specimen').getAttribute('data-brief-theme') !== theme) await button(page, `Switch to ${theme}`).click();
      if (rail) await button(page, 'Collapse sidebar').click();
      await button(page, 'Open conversation').click(); await page.waitForTimeout(380);
      // Pause new height animations at creation so fast/slow hosts inspect the same frames.
      await page.evaluate(() => {
        const surface = document.querySelector('.brief-composer-surface');
        const animate = surface.animate.bind(surface);
        surface.animate = (...args) => { const a = animate(...args); a.pause(); a.currentTime = 0; return a; };
      });
      const field = page.getByRole('textbox', { name: 'Message Jarvis', exact: true });
      for (const [direction, text] of [['grow', 'Line one\nLine two\nLine three'], ['shrink', 'Short']]) {
        await field.fill(text);
        for (const time of [0, 45, 90, 135, 179]) {
          const frame = await page.evaluate(time => {
            const surface = document.querySelector('.brief-composer-surface');
            const animation = surface.getAnimations()[0];
            if (!animation) throw Error('Expected an actual surface height animation');
            animation.currentTime = time;
            const rect = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
            return { surface: rect(surface), text: rect(surface.querySelector('textarea')),
              send: rect(surface.querySelector('.brief-composer-send')), plus: rect(surface.querySelector('.brief-composer-attachment')) };
          }, time);
          assert.ok(frame.text.top >= frame.surface.top + 5, `${theme}/${rail}/${direction}/${time}: textarea extends above its surface (${JSON.stringify(frame)})`);
          assert.ok(frame.text.bottom <= frame.surface.bottom - 5);
          assert.equal(frame.send.height, 44); assert.equal(frame.plus.height, 44);
          assert.equal(frame.surface.bottom - frame.send.bottom, 6); assert.equal(frame.surface.bottom - frame.plus.bottom, 6);
          results.push({ theme, rail, direction, time, ...frame });
        }
        await page.evaluate(() => document.querySelector('.brief-composer-surface').getAnimations().forEach(a => a.finish()));
      }
      console.log(`PASS intermediate growth/shrink: ${theme}, ${rail ? 'rail' : 'expanded'}`); await context.close();
    }
    fs.writeFileSync(path.join(__dirname, 'resize-results.json'), JSON.stringify({ base, browser: await browser.version(), frames: results, method: 'Real surface WAAPI animation paused at five intermediate times in each direction.' }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
