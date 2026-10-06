const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4394/?brief=preview&specimen=attachments#/_brief_preview';
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1150},reducedMotion:'reduce'});
    const button = name => page.getByRole('button',{name,exact:true});
    await page.goto(base); await button('Open conversation').click();
    await button('Add attachment').click(); await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('[data-choice="document"]').evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('[data-choice="image"]').evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('textbox',{name:'Message Jarvis',exact:true}).evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('.brief-fan-layer').getAttribute('data-open'),'false');
    await button('Add attachment').click();
    await page.locator('[data-choice="document"]').click();
    assert.equal(await page.getByLabel('Attachment feedback',{exact:true}).textContent(),'Adding document…');
    await button('Close conversation').click(); await page.waitForTimeout(400);
    await button('Open conversation').click();
    assert.equal(await page.getByLabel('Attachment feedback',{exact:true}).textContent(),'');
    assert.equal(await page.getByLabel('Attachment selections',{exact:true}).textContent(),'0 selections');
    assert.equal(await button('Add attachment').getAttribute('aria-disabled'),'false');
    console.log('PASS pointer-open keyboard entry, ArrowRight and Tab return; closing Pebble aborts selection, clears pending feedback and restores entry without an attachment receipt.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
