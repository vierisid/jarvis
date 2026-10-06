// Isolated UI specimen. No daemon, authenticated account or model is used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4392/?brief=preview&specimen=chat-tabs#/_brief_preview';
const button = (page, name) => page.getByRole('button', {name, exact:true});
const tab = (page,id) => page.locator(`[data-chat-id="${id}"] [role="tab"]`);
const close = (page,id) => page.locator(`[data-chat-id="${id}"] .brief-chat-tab-close`);
const active = (page,id) => page.waitForFunction(id => document.querySelector('.d12-example-panel')?.dataset.activeChat === id, id);
const settled = page => page.waitForFunction(() => !document.querySelector('.brief-chat-tabs-header')?.getAnimations({subtree:true}).some(a => a.playState === 'running') && document.querySelector('[aria-label="Conversations"]')?.getAttribute('aria-busy') === 'false');
async function geometry(page) {
  return page.evaluate(() => {
    const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}; };
    return { plus:rect(document.querySelector('[aria-label="New conversation"]')), x:rect(document.querySelector('.brief-pebble-close')), strip:rect(document.querySelector('.brief-chat-tabs-viewport')),
      tabs:[...document.querySelectorAll('.brief-chat-tab-slot:not([data-exiting="true"])')].map(el=>rect(el)),
      overflow:document.querySelector('.brief-chat-tabs-viewport').scrollWidth > document.querySelector('.brief-chat-tabs-viewport').clientWidth };
  });
}
(async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true}); const results=[], errors=[];
  try {
    for (const theme of ['light','dark']) for (const rail of [false,true]) {
      const context=await browser.newContext({viewport:{width:1440,height:1150}}), page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(base); await button(page,'Open conversation').waitFor();
      if (await page.locator('.brief-today-specimen').getAttribute('data-brief-theme') !== theme) await button(page,`Switch to ${theme}`).click();
      if (rail) await button(page,'Collapse sidebar').click();
      await button(page,'Open conversation').click(); await page.waitForTimeout(380);
      await page.getByRole('textbox',{name:'Conversation draft',exact:true}).fill('General draft stays with General.');
      await page.getByRole('checkbox',{name:'Long retained reply',exact:true}).check();
      const thread=page.getByLabel('Conversation messages',{exact:true}); await thread.evaluate(el=>{el.scrollTop=160;});
      await page.waitForTimeout(50); const savedTop=await thread.evaluate(el=>el.scrollTop);
      const original=await geometry(page); assert.ok(original.strip.right <= original.plus.x+1); assert.ok(original.plus.right <= original.x.x+1);
      const label=tab(page,'general').locator('span'), labelBefore=await label.boundingBox();
      for(let i=0;i<10;i++){await tab(page,'general').hover();await page.locator('h1').hover();}
      const labelAfter=await label.boundingBox(); assert.deepEqual(labelAfter,labelBefore);
      for(let i=0;i<10;i++) {
        await button(page,'New conversation').click(); await active(page,`chat-${i+1}`); await settled(page);
        await page.getByRole('textbox',{name:'Conversation draft',exact:true}).fill(`Distinct draft ${i+1}`);
        await tab(page,`chat-${i+1}`).hover(); await close(page,`chat-${i+1}`).click(); await active(page,'investor'); await settled(page);
        assert.equal(await page.getByRole('textbox',{name:'Conversation draft',exact:true}).inputValue(),'Summarize this week’s progress.');
        await tab(page,'general').click(); await active(page,'general'); await settled(page);
        assert.equal(await page.getByRole('textbox',{name:'Conversation draft',exact:true}).inputValue(),'General draft stays with General.');
        assert.equal(await thread.evaluate(el=>el.scrollTop),savedTop);
      }
      // Closed history is retained by the example owner, not erased by the strip.
      await button(page,'Reopen last closed fixture').click(); await active(page,'chat-10'); await settled(page);
      assert.equal(await page.getByRole('textbox',{name:'Conversation draft',exact:true}).inputValue(),'Distinct draft 10');
      for(let i=0;i<5;i++){await button(page,'New conversation').click();await active(page,`chat-${11+i}`);await settled(page);}
      const many=await geometry(page); assert.ok(many.overflow); assert.ok(many.tabs.every(r=>r.width>=111.9));
      assert.deepEqual(many.x,original.x);assert.deepEqual(many.plus,original.plus);
      const selected=await tab(page,'chat-15').boundingBox(); assert.ok(selected.x+selected.width<=many.strip.right+1);
      await tab(page,'chat-15').focus(); await page.keyboard.press('Home');
      assert.equal(await tab(page,'general').evaluate(el=>el===document.activeElement),true);
      assert.equal(await tab(page,'chat-15').getAttribute('aria-selected'),'true');
      await page.keyboard.press('Enter');await active(page,'general');await settled(page);
      // Twenty shell reversals retain selected conversation, draft and reading anchor.
      for(let i=0;i<10;i++){await button(page,'Close conversation').click();await button(page,'Open conversation').click();await page.waitForTimeout(350);}
      assert.equal(await page.getByRole('textbox',{name:'Conversation draft',exact:true}).inputValue(),'General draft stays with General.');
      assert.equal(await thread.evaluate(el=>el.scrollTop),savedTop);
      await page.getByRole('checkbox',{name:'Fail tab writes',exact:true}).check();
      await tab(page,'general').hover();await close(page,'general').click();await page.getByText('Conversation change failed. Try again.',{exact:true}).waitFor();
      assert.equal(await tab(page,'general').getAttribute('aria-selected'),'true');
      await page.getByRole('checkbox',{name:'Fail tab writes',exact:true}).uncheck();
      await tab(page,'general').hover();await close(page,'general').click();await active(page,'investor');await settled(page);
      await page.screenshot({path:path.join(__dirname,`tabs-${theme}-${rail?'rail':'expanded'}.png`)});
      await page.getByRole('checkbox',{name:'Reduce motion',exact:true}).check();
      assert.equal(await page.locator('.brief-chat-tabs-header').getAttribute('data-reduced-motion'),'true');
      await page.getByRole('checkbox',{name:'Reduce motion',exact:true}).uncheck();
      await page.emulateMedia({reducedMotion:'reduce'});await button(page,'New conversation').click();await active(page,'chat-16');
      assert.equal(await page.locator('.brief-chat-tabs-header').evaluate(el=>el.getAnimations({subtree:true}).length),0);
      for(const mode of ['loading','legacy','unavailable','disabled']) {
        await page.getByRole('combobox',{name:'Chat mode',exact:true}).selectOption(mode);
        assert.equal(await page.getByRole('tab').count(),0);assert.equal(await button(page,'New conversation').count(),0);
      }
      await page.getByRole('combobox',{name:'Chat mode',exact:true}).selectOption('scoped');
      await active(page,'chat-16');assert.equal(await tab(page,'chat-16').getAttribute('aria-selected'),'true');
      while (await page.getByRole('tab').count()) {
        const id=await page.locator('[role="tab"][aria-selected="true"]').evaluate(el=>el.closest('[data-chat-id]').dataset.chatId);
        await tab(page,id).hover();await close(page,id).click();
        await page.waitForFunction(id=>document.querySelector('.d12-example-panel')?.dataset.activeChat!==id,id);await settled(page);
      }
      assert.equal(await button(page,'New conversation').evaluate(el=>el===document.activeElement),true);
      assert.equal(await page.locator('.d12-example-panel').getAttribute('data-active-chat'),'');
      await button(page,'New conversation').click();await active(page,'chat-17');await settled(page);
      const one=await geometry(page);assert.equal(one.overflow,false);
      await page.screenshot({path:path.join(__dirname,`tabs-one-${theme}-${rail?'rail':'expanded'}.png`)});
      results.push({theme,rail,addCloseCycles:10,hoverCycles:10,panelReopenCycles:10,contentDraftScrollRetained:true,failureRetry:true,overflow:many,reducedMotion:true,modeGates:4,finalCloseAndRestart:true});
      console.log(`PASS ${theme} ${rail?'rail':'expanded'}`);await context.close();
    }
    const context=await browser.newContext({viewport:{width:390,height:900},hasTouch:true,isMobile:true}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await button(page,'Open conversation').click();await page.waitForTimeout(400);
    for(let i=0;i<4;i++){await button(page,'New conversation').click();await active(page,`chat-${i+1}`);await settled(page);}
    const narrow=await geometry(page);assert.ok(narrow.plus.right<=narrow.x.x+1);assert.ok(narrow.overflow);
    assert.equal(await close(page,'chat-4').evaluate(el=>getComputedStyle(el).opacity),'1');
    await page.screenshot({path:path.join(__dirname,'tabs-narrow-touch.png')});await context.close();
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify({base,browser:await browser.version(),results,narrow,errors,limits:['Fixture owner only. F-04 live transport is not mounted.','Not screen reader certification or a measured frame-rate claim.']},null,2)+'\n');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
