// Isolated composer fixture only. No real model, send or upload.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4393/?brief=preview&specimen=composer#/_brief_preview';
const button = (page, name) => page.getByRole('button', { name, exact:true });
const field = page => page.getByRole('textbox', {name:'Message Jarvis',exact:true});
const tab = (page, id) => page.locator(`[data-chat-id="${id}"] [role="tab"]`);
const check = (page, name) => page.getByRole('checkbox', {name,exact:true});
const ops = page => page.getByLabel('Fixture operations',{exact:true}).textContent();
const settle = page => page.waitForFunction(() => !document.querySelector('.brief-composer')?.getAnimations({subtree:true}).some(a=>a.playState==='running'));
async function geometry(page) {
  return page.evaluate(() => {
    const rect = el => {const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,right:b.right};};
    const text=document.querySelector('.brief-composer textarea'),surface=document.querySelector('.brief-composer-surface');
    return {surface:rect(surface),text:rect(text),plus:rect(document.querySelector('.brief-composer-attachment')),send:rect(document.querySelector('.brief-composer-send')),
      overflow:text.scrollHeight>text.clientHeight, border:getComputedStyle(surface).borderTopWidth, focus:getComputedStyle(surface).outlineStyle};
  });
}
async function capture(page,name) {await page.screenshot({path:path.join(__dirname,`${name}.png`)});}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true}), results=[], errors=[];
  try {
    for(const theme of ['light','dark']) for(const rail of [false,true]) {
      const context=await browser.newContext({viewport:{width:1440,height:1150},reducedMotion:'no-preference',permissions:['clipboard-read','clipboard-write']}), page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(base);await button(page,'Open conversation').waitFor();
      if(await page.locator('.brief-today-specimen').getAttribute('data-brief-theme')!==theme)await button(page,`Switch to ${theme}`).click();
      if(rail)await button(page,'Collapse sidebar').click();
      await button(page,'Open conversation').click();await page.waitForTimeout(380);
      const empty=await geometry(page);assert.equal(empty.surface.height,56);assert.equal(empty.border,'1px');assert.equal(empty.send.width,44);
      assert.equal(await button(page,'Send').getAttribute('aria-disabled'),'true');
      await capture(page,`empty-${theme}-${rail?'rail':'expanded'}`);
      await button(page,'Prepare a call').click();await settle(page);
      assert.equal(await field(page).inputValue(),'Prepare my next call with Alex.');assert.equal(await ops(page),'0 sends · 0 stops');
      await field(page).fill('Line one\nLine two\nLine three');await settle(page);
      const multiline=await geometry(page);assert.equal(multiline.surface.height,104);assert.deepEqual(multiline.send,empty.send);assert.deepEqual(multiline.plus,empty.plus);
      await field(page).fill(Array.from({length:40},(_,i)=>`Retained line ${i+1} 你好`).join('\n'));await settle(page);
      const long=await geometry(page);assert.equal(long.surface.height,104);assert.equal(long.overflow,true);assert.ok(long.text.right<long.send.x);assert.deepEqual(long.send,empty.send);
      const draft=await field(page).inputValue();await tab(page,'investor').click();assert.equal(await field(page).inputValue(),'Summarize this week’s progress.');
      await tab(page,'general').click();assert.equal(await field(page).inputValue(),draft);
      await field(page).focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' at the end');
      assert.equal(await field(page).evaluate(el=>el.scrollTop>0),true);
      await field(page).fill(draft);
      for(let i=0;i<10;i++) {
        await button(page,'Send').hover();await page.waitForTimeout(45);await field(page).hover();await page.waitForTimeout(35);await button(page,'Send').hover();await field(page).hover();
      }
      await settle(page);assert.equal(await page.locator('.brief-composer-send-mark').evaluate(el=>getComputedStyle(el).transform),'matrix(1, 0, 0, 1, 0, 0)');
      assert.equal(await field(page).inputValue(),draft);
      await field(page).focus();await page.keyboard.press('Tab');await page.getByRole('tooltip',{name:'Send',exact:true}).waitFor();await settle(page);
      assert.notEqual(await page.locator('.brief-composer-send-mark').evaluate(el=>getComputedStyle(el).transform),'matrix(1, 0, 0, 1, 0, 0)');
      await page.keyboard.press('Escape');await field(page).focus();await settle(page);
      await capture(page,`long-${theme}-${rail?'rail':'expanded'}`);
      // Browser clipboard inserts text into a native textarea, never HTML markup.
      await field(page).fill('');await page.evaluate(()=>navigator.clipboard.writeText('Pasted <b>plain text</b>\n你好'));
      await field(page).focus();await page.keyboard.press('Control+V');
      await page.waitForFunction(()=>document.querySelector('.brief-composer textarea').value.startsWith('Pasted'));
      assert.equal(await field(page).inputValue(),'Pasted <b>plain text</b>\n你好');assert.equal(await page.locator('.brief-composer b').count(),0);
      await page.keyboard.press('End');await page.keyboard.press('Shift+Enter');assert.ok((await field(page).inputValue()).endsWith('\n'));assert.equal(await ops(page),'0 sends · 0 stops');
      await field(page).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'你好'})));
      await page.keyboard.press('Enter');assert.equal(await ops(page),'0 sends · 0 stops');
      await field(page).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你好'})));await page.waitForTimeout(40);
      await check(page,'Fail send').check();await field(page).fill('Retry this draft');await button(page,'Send').click();
      await page.getByText('Could not send. Your draft is still here.',{exact:true}).waitFor();assert.equal(await field(page).inputValue(),'Retry this draft');
      await check(page,'Fail send').uncheck();await check(page,'Hold response').check();await button(page,'Send').click();
      await field(page).fill('A newer draft');await page.getByText('Preparing your response…',{exact:true}).waitFor();
      assert.equal(await field(page).inputValue(),'A newer draft');assert.equal(await ops(page),'2 sends · 0 stops');
      await field(page).press('Enter');assert.equal(await ops(page),'2 sends · 0 stops');
      await check(page,'Fail stop').check();await button(page,'Stop response').click();
      await page.getByText('Stopping response…',{exact:true}).waitFor();await button(page,'Retry stop').waitFor();
      assert.equal(await button(page,'Retry stop').getAttribute('aria-disabled'),'false');
      await page.getByText('Could not stop the response. Try again.',{exact:true}).waitFor();
      await button(page,'Stop response').click();await page.getByText('Stopping response…',{exact:true}).waitFor();
      await page.getByText('Could not stop the response. Try again.',{exact:true}).waitFor();
      await check(page,'Fail stop').uncheck();await button(page,'Stop response').click();
      await page.getByText('Stopping response…',{exact:true}).waitFor();await button(page,'Retry stop').waitFor();
      if(theme==='light'&&!rail)await page.locator('.brief-composer').screenshot({path:path.join(__dirname,'review-stopping.png')});
      await page.getByText('Response stopped.',{exact:true}).waitFor();
      assert.equal(await field(page).inputValue(),'A newer draft');assert.equal(await ops(page),'2 sends · 3 stops');
      await field(page).fill('Accepted draft');await field(page).press('Enter');await page.getByText('Preparing your response…',{exact:true}).waitFor();
      assert.equal(await field(page).inputValue(),'');await button(page,'Finish response').click();
      await field(page).fill('Persist across reflow');
      for(let i=0;i<10;i++) {await button(page,'Close conversation').click();await button(page,'Open conversation').click();await page.waitForTimeout(330);}
      assert.equal(await field(page).inputValue(),'Persist across reflow');
      await check(page,'Connected').uncheck();assert.equal(await button(page,'Send').getAttribute('aria-disabled'),'true');await field(page).fill('Offline edit stays');
      await check(page,'Connected').check();assert.equal(await field(page).inputValue(),'Offline edit stays');
      await page.emulateMedia({reducedMotion:'reduce'});await field(page).fill('One\nTwo\nThree');await button(page,'Send').hover();
      assert.equal(await page.locator('.brief-composer').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
      for(const mode of ['loading','legacy','unavailable','disabled']) {
        await page.getByRole('combobox',{name:'Chat mode',exact:true}).selectOption(mode);assert.equal(await field(page).count(),0);
      }
      await page.getByRole('combobox',{name:'Chat mode',exact:true}).selectOption('scoped');assert.equal(await field(page).inputValue(),'One\nTwo\nThree');
      results.push({theme,rail,empty,multiline,long,rapidHoverCycles:10,panelReopens:10,paste:true,imeGuard:true,draftAcceptance:true,scopedStop:true,reducedMotion:true});
      console.log(`PASS ${theme} ${rail?'rail':'expanded'}`);await context.close();
    }
    const context=await browser.newContext({viewport:{width:390,height:900},isMobile:true,hasTouch:true}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await button(page,'Open conversation').click();await page.waitForTimeout(380);
    await field(page).fill('Long words '.repeat(120));await settle(page);const narrow=await geometry(page);
    assert.equal(narrow.surface.height,104);assert.ok(narrow.text.right<narrow.send.x);assert.ok(narrow.plus.right<=narrow.text.x+3);assert.ok(narrow.send.right<=390);assert.equal(narrow.overflow,true);
    const panel=await page.locator('.brief-pebble-surface').boundingBox();assert.ok(narrow.send.bottom<=panel.y+panel.height-10);assert.ok(narrow.plus.bottom<=panel.y+panel.height-10);assert.ok(narrow.surface.bottom<=900);
    await capture(page,'narrow-touch');await context.close();assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify({base,browser:await browser.version(),results,narrow,errors,limits:['Fixture owner, no live inference or transport.','Composition events verified, not an OS IME certification.','Not a screen-reader or frame-rate certification.']},null,2)+'\n');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
