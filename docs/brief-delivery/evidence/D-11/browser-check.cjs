// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package. No live backend.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4391/?brief=preview&specimen=today#/_brief_preview';
const output = __dirname;
const select = async (page, name, value) => page.getByRole('combobox', {name,exact:true}).selectOption(value);
const rest = async page => page.waitForFunction(() => document.querySelector('.brief-opportunity-stack')?.dataset.phase === 'rest');
const current = async page => page.locator('.brief-opportunity-stack').getAttribute('data-proposal-id');
const count = async page => page.locator('[aria-label="Opportunity position"]').textContent();
const next = async page => {await page.getByRole('button',{name:'Next opportunity',exact:true}).click();await rest(page);};
const approve = page => page.locator('.brief-opportunity-approve');
const dismiss = page => page.locator('.brief-opportunity-dismiss');
async function inspect(page) {
  const geometry = await page.locator('.brief-opportunity-stack').evaluate(stack => {
    const paper=stack.querySelector('.brief-opportunity-paper'), r=paper.getBoundingClientRect(), style=getComputedStyle(paper);
    const rect=el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};};
    return {paper:rect(paper),overflow:paper.scrollWidth>paper.clientWidth+1,corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomRightRadius,style.borderBottomLeftRadius],
      background:style.backgroundColor,labels:[...paper.querySelectorAll('dt')].map(el=>({size:parseFloat(getComputedStyle(el).fontSize),color:getComputedStyle(el).color})),
      actions:[...paper.querySelectorAll('button')].map(el=>({rect:rect(el),fits:el.getBoundingClientRect().left>=r.left&&el.getBoundingClientRect().right<=r.right+1})),
      backing:[...stack.querySelectorAll('.brief-opportunity-backing')].map(el=>({corners:[getComputedStyle(el).borderTopLeftRadius,getComputedStyle(el).borderTopRightRadius,getComputedStyle(el).borderBottomRightRadius,getComputedStyle(el).borderBottomLeftRadius],color:getComputedStyle(el).backgroundColor})),
      headingOutside:!paper.querySelector('h2')&&stack.parentElement.querySelector(':scope > h2')?.textContent==='Opportunities'};
  });
  assert(!geometry.overflow,'paper overflow');assert(geometry.headingOutside,'heading moved into card');
  assert(geometry.actions.every(a=>a.fits),'actions outside paper');assert(geometry.labels.every(l=>l.size>=12),'tiny labels');
  for(const sheet of geometry.backing) {assert.deepEqual(sheet.corners,geometry.corners);assert.notEqual(sheet.color,'rgba(0, 0, 0, 0)');}
  return geometry;
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const errors=[],results=[];
  try {
    for(const theme of ['light','dark']) for(const rail of [false,true]) for(const chat of [false,true]) {
      const context=await browser.newContext({viewport:{width:1440,height:1400}});const page=await context.newPage();
      page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await approve(page).waitFor();
      if(await page.locator('.brief-today-specimen').getAttribute('data-brief-theme')!==theme)await page.getByRole('button',{name:`Switch to ${theme}`,exact:true}).click();
      if(rail)await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
      if(chat)await page.getByRole('button',{name:'Open conversation',exact:true}).click();
      await page.waitForTimeout(400);await page.locator('.brief-opportunity-paper').scrollIntoViewIfNeeded();
      const geometry=await inspect(page);const key=`${theme}-${rail?'rail':'expanded'}-${chat?'open':'closed'}`;
      await page.screenshot({path:path.join(output,`${key}.png`)});
      for(let i=0;i<10;i++){await next(page);assert.equal(await current(page),`fixture-opportunity-${(i+1)%3}`);}
      assert.equal(await count(page),'2 / 3');
      const before=await current(page),url=page.url(),bounds=await approve(page).boundingBox();
      await approve(page).click();await approve(page).evaluate(el=>el.click());
      await page.waitForFunction(()=>document.querySelector('.brief-opportunity-stack').dataset.phase==='acknowledged');
      assert.equal(await current(page),before);assert.equal(await count(page),'2 / 3');
      assert.equal(await page.locator('[aria-label="Opportunity action calls"]').textContent(),'1');
      const ackBounds=await approve(page).boundingBox();assert(Math.abs(bounds.width-ackBounds.width)<1,'confirm moved width');
      assert(Math.abs(bounds.y-ackBounds.y)<1,'confirm moved button');
      await rest(page);assert.equal(await count(page),'2 / 2');assert.equal(await current(page),'fixture-opportunity-2');assert.equal(page.url(),url);
      await dismiss(page).click();await rest(page);assert.equal(await count(page),'1 / 1');
      await dismiss(page).click();await rest(page);assert.equal(await count(page),'0');
      assert.equal(await page.locator('.brief-opportunity-backing').count(),0);
      results.push({theme,rail,chat,nextCycles:10,geometry,approveOnce:true,dismissToEmpty:true,noNavigation:true});
      console.log(`PASS ${key}`);await context.close();
    }
    const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await approve(page).waitFor();
    const readStates=[];
    for(const scenario of ['preparing','blocked','missing-connection','no-owner','stale','loading','unavailable','unsupported','empty']) {
      await select(page,'Opportunity scenario',scenario);
      if(await approve(page).count()) {assert.equal(await approve(page).getAttribute('aria-disabled'),'true');await approve(page).evaluate(el=>el.click());}
      assert.equal(await page.locator('[aria-label="Opportunity action calls"]').textContent(),'0');
      if(['loading','unavailable','unsupported'].includes(scenario))assert.equal(await count(page),'—');
      readStates.push({scenario,count:await count(page),blocked:true});
    }
    await select(page,'Opportunity scenario','ready');
    for(const outcome of ['conflict','failed','unknown','lost-response']) {
      await page.getByRole('button',{name:'Reset opportunities',exact:true}).click();await select(page,'Opportunity result',outcome);
      await approve(page).click();await rest(page);assert.equal(await current(page),'fixture-opportunity-0');assert.equal(await count(page),'1 / 3');
      assert.equal(await approve(page).getAttribute('aria-disabled'),'true');await approve(page).evaluate(el=>el.click());
      assert.equal(await page.locator('[aria-label="Opportunity action calls"]').textContent(),'1');
    }
    await page.getByRole('button',{name:'Reset opportunities',exact:true}).click();await select(page,'Opportunity result','confirmed');
    await page.getByRole('button',{name:'Open conversation',exact:true}).click();await page.waitForTimeout(400);
    await page.getByRole('textbox',{name:'Conversation draft'}).fill('Keep this draft');
    for(let i=0;i<10;i++)for(const value of ['loading','ready']){
      await page.evaluate(value=>{const el=document.querySelector('[aria-label="Opportunity scenario"]');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));},value);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
      assert(await page.getByRole('textbox',{name:'Conversation draft'}).evaluate(el=>document.activeElement===el));
    }
    assert.equal(await page.getByRole('textbox',{name:'Conversation draft'}).inputValue(),'Keep this draft');
    // Reduced-motion recovery is exercised using the user's actual media preference.
    await page.emulateMedia({reducedMotion:'reduce'});await next(page);assert.equal(await page.locator('.brief-opportunity-stack').getAttribute('data-reduced'),'true');
    const reducedAnimations=await page.locator('.brief-opportunity-stack').evaluate(el=>el.getAnimations({subtree:true}).length);assert.equal(reducedAnimations,0);
    await page.screenshot({path:path.join(output,'reduced-motion.png')});
    // Test long authored content at a genuine narrow browser viewport.
    await page.getByRole('button',{name:'Close conversation',exact:true}).click();
    await page.setViewportSize({width:390,height:1000});await select(page,'Review width','390');await select(page,'Opportunity scenario','long');
    await page.getByRole('button',{name:'Reset opportunities',exact:true}).click();await page.locator('.brief-opportunity-paper').scrollIntoViewIfNeeded();
    const narrow=await inspect(page);
    await dismiss(page).scrollIntoViewIfNeeded();
    assert(await dismiss(page).evaluate(el=>{const r=el.getBoundingClientRect();const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el.contains(top);}), 'narrow dismiss covered');
    await page.screenshot({path:path.join(output,'narrow-long.png')});
    await dismiss(page).click();await rest(page);assert.equal(await count(page),'1 / 2');
    assert.deepEqual(errors,[]);
    const report={browser:`Headless Windows Chrome ${browser.version()} via Playwright`,build:await page.locator('script[src]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('src'))),base,results,readStates,failures:['conflict','failed','unknown','lost-response'],focusCycles:10,reducedAnimations,narrow,errors,
      limits:['Isolated fixtures; no live F-09/F-10 provider or external effects','No screen-reader certification or mobile keyboard test','Durations are design timings, not measured frame-rate guarantees']};
    fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify(report,null,2)+'\n');console.log('All D-11 browser checks passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
