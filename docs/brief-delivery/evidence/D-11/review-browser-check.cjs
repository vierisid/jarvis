// D-11 review regressions. Isolated preview only; never calls a live provider.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4391/?brief=preview&specimen=today#/_brief_preview';
const select = (page, value) => page.getByRole('combobox', {name:'Opportunity scenario',exact:true}).selectOption(value);
const button = (page, name) => page.getByRole('button', {name,exact:true});
const front = page => page.locator('.brief-opportunity-stack').getAttribute('data-proposal-id');
const settle = (page, id) => page.waitForFunction(id => {
  const stack = document.querySelector('.brief-opportunity-stack');
  return stack?.dataset.phase === 'rest' && stack.dataset.proposalId === id;
}, id);
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const results = [], errors = [];
  let build;
  try {
    for (const theme of ['light','dark']) for (const rail of [false,true]) for (const chat of [false,true]) {
      const context = await browser.newContext({viewport:{width:1440,height:1100}});
      const page = await context.newPage();page.on('pageerror',error => errors.push(error.message));
      await page.goto(base);await page.locator('.brief-opportunity-approve').waitFor();
      build = await page.locator('script[src]').evaluateAll(nodes => nodes.map(n => n.getAttribute('src')));
      if (await page.locator('.brief-today-specimen').getAttribute('data-brief-theme') !== theme) await button(page, `Switch to ${theme}`).click();
      if (rail) await button(page, 'Collapse sidebar').click();
      if (chat) await button(page, 'Open conversation').click();
      await select(page, 'stale');
      for (let i=0;i<10;i++) {
        await button(page, 'Next opportunity').click();await settle(page, `fixture-opportunity-${(i+1)%3}`);
        for (const selector of ['.brief-opportunity-approve','.brief-opportunity-dismiss']) assert.equal(await page.locator(selector).getAttribute('aria-disabled'), 'true');
      }
      assert.equal(await page.locator('[aria-label="Opportunity action calls"]').textContent(), '0');
      assert.equal(await button(page, 'Next opportunity').getAttribute('aria-disabled'), 'false');
      if (!rail && chat) await page.screenshot({path:path.join(__dirname, `review-stale-${theme}.png`)});
      await select(page, 'ready');assert.equal(await front(page), 'fixture-opportunity-1');
      for (const action of ['approve','dismiss']) {
        await button(page, 'Reset opportunities').click();await button(page, 'Next opportunity').click();await settle(page, 'fixture-opportunity-1');
        const url = page.url();
        // Same-turn background refresh while the illustrative owner's response is pending.
        await page.locator(`.brief-opportunity-${action}`).evaluate(el => {
          el.click();[...document.querySelectorAll('button')].find(b => b.textContent === 'Reverse opportunity list').click();
        });
        await page.waitForFunction(() => document.querySelector('.brief-opportunity-stack').dataset.phase === 'acknowledged');
        assert.equal(await front(page), 'fixture-opportunity-1');
        await settle(page, 'fixture-opportunity-2');
        assert.equal(await page.locator('[aria-label="Opportunity action calls"]').textContent(), '1');
        assert.equal(await page.locator('[aria-label="Opportunity position"]').textContent(), '1 / 2');
        assert.equal(page.url(), url);
        assert.equal(await page.locator('.brief-opportunity-approve').getAttribute('aria-disabled'), 'false');
      }
      // The same local browse remains usable with reduced motion.
      await page.emulateMedia({reducedMotion:'reduce'});await button(page, 'Reset opportunities').click();await select(page, 'stale');
      await button(page, 'Next opportunity').click();await settle(page, 'fixture-opportunity-1');
      assert.equal(await page.locator('.brief-opportunity-stack').evaluate(el => el.getAnimations({subtree:true}).length), 0);
      results.push({theme,rail,chat,staleNextCycles:10,staleWrites:0,reorderedApproval:'fixture-opportunity-2',reorderedDismissal:'fixture-opportunity-2',reducedMotion:true});
      console.log(`PASS review ${theme} ${rail?'rail':'expanded'} ${chat?'open':'closed'}`);
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(__dirname,'review-browser-results.json'), JSON.stringify({browser:await browser.version(),base,build,results,errors,limits:['Illustrative providers only; no workflow enabled or dismissed in a live account.','No real network outage or cross-window backend synchronization exercised.']},null,2)+'\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error);process.exit(1); });
