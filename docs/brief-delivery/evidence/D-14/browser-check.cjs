const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4394/?brief=preview&specimen=attachments#/_brief_preview';
const button=(p,name)=>p.getByRole('button',{name,exact:true}), field=p=>p.getByRole('textbox',{name:'Message Jarvis',exact:true});
const wait=p=>p.waitForTimeout(320);
const rect = async locator => {const r=await locator.boundingBox();return {x:r.x,y:r.y,width:r.width,height:r.height};};
async function points(p){return {field:await rect(field(p)),surface:await rect(p.locator('.brief-composer-surface')),plus:await rect(p.locator('.brief-fan-toggle')),send:await rect(p.locator('.brief-composer-send'))};}
async function capture(p,name){await p.screenshot({path:path.join(__dirname,`${name}.png`)});}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),results=[],errors=[];
 try {
 for(const theme of ['light','dark']) for(const rail of [false,true]){
  const context=await browser.newContext({viewport:{width:1440,height:1150},reducedMotion:'no-preference'}),p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base);await button(p,'Open conversation').waitFor();if(await p.locator('.brief-today-specimen').getAttribute('data-brief-theme')!==theme)await button(p,`Switch to ${theme}`).click();if(rail)await button(p,'Collapse sidebar').click();await button(p,'Open conversation').click();await wait(p);
  const original=await points(p);await button(p,'Add attachment').click();await wait(p);await capture(p,`open-${theme}-${rail?'rail':'expanded'}`);
  assert.deepEqual(await points(p),original);
  assert.equal(await p.locator('.brief-fan-layer').getAttribute('data-open'),'true');
  assert.equal(await p.locator('.brief-fan-name').first().evaluate(el=>getComputedStyle(el).opacity),'0');
  for(let cycle=0;cycle<20;cycle++)for(const kind of ['document','image','screenshot']){
    const row=p.locator(`[data-choice="${kind}"]`);const r=await row.boundingBox();
    await p.mouse.move(r.x+22,r.y+22);await p.waitForTimeout(90);assert.equal(await row.locator('.brief-fan-name').evaluate(el=>getComputedStyle(el).opacity),'1');
    await p.mouse.move(r.x+96,r.y+22,{steps:4});assert.equal(await row.locator('.brief-fan-name').evaluate(el=>getComputedStyle(el).opacity),'1');
  }
  await field(p).hover();await p.waitForTimeout(100);assert.equal(await p.locator('.brief-fan-name').first().evaluate(el=>getComputedStyle(el).opacity),'0');
  await button(p,'Close attachments').click();await wait(p);const origin=await p.locator('.brief-fan-toggle').boundingBox();
  const click=()=>p.mouse.click(origin.x+22,origin.y+22);
  for(let i=0;i<20;i++){await click();await p.waitForTimeout(35);await click();await p.waitForTimeout(25);await click();await p.waitForTimeout(45);await click();}
  await wait(p);assert.equal(await p.locator('.brief-fan-layer').getAttribute('data-open'),'false');
  const closed=await p.locator('.brief-fan-item').evaluateAll(rows=>rows.map(el=>({opacity:getComputedStyle(el).opacity,transform:getComputedStyle(el).transform,animations:el.getAnimations().length})));
  closed.forEach(x=>{assert.equal(x.opacity,'0');assert.equal(x.transform,'matrix(1, 0, 0, 1, 0, 0)');assert.equal(x.animations,0);});assert.deepEqual(await points(p),original);
  // Input grows upward; choices clear both text and suggestions.
  await field(p).fill('Keep this draft.\nAnother line.\nA third line.\nA fourth line.');await wait(p);const multiline=await points(p);await button(p,'Add attachment').click();await wait(p);
  const doc=await p.locator('[data-choice="document"]').boundingBox(),suggestions=await p.locator('.brief-composer-suggestions').boundingBox();assert.ok(doc.y+doc.height<=suggestions.y-10);assert.deepEqual(await points(p),multiline);
  await p.locator('[data-choice="document"]').hover();await p.waitForTimeout(100);await capture(p,`multiline-${theme}-${rail?'rail':'expanded'}`);
  // Keyboard unavailable state, Escape and repeated reentry.
  await p.keyboard.press('Escape');await button(p,'Add attachment').focus();await p.keyboard.press('ArrowUp');await wait(p);
  assert.equal(await p.locator('[data-choice="document"]').evaluate(el=>el===document.activeElement),true);
  await p.keyboard.press('End');assert.equal(await p.locator('[data-choice="screenshot"]').evaluate(el=>el===document.activeElement),true);assert.equal(await p.locator('[data-choice="screenshot"]').getAttribute('aria-disabled'),'true');
  await p.keyboard.press('Enter');assert.equal(await p.getByLabel('Attachment selections',{exact:true}).textContent(),'0 selections');
  await p.keyboard.press('Escape');assert.equal(await button(p,'Add attachment').evaluate(el=>el===document.activeElement),true);assert.equal(await p.locator('.brief-pebble-layout').getAttribute('data-pebble-open'),'true');
  // Illustrative selection, failure/retry, never a real file or capture.
  await p.getByRole('checkbox',{name:'Fail attachment',exact:true}).check();await button(p,'Add attachment').click();await wait(p);await p.locator('[data-choice="image"]').click();await p.getByText('Could not add image. Try again.',{exact:true}).waitFor();
  await p.getByRole('checkbox',{name:'Fail attachment',exact:true}).uncheck();await p.getByRole('checkbox',{name:'Screenshot available',exact:true}).check();await button(p,'Add attachment').click();await wait(p);await p.locator('[data-choice="screenshot"]').click();await p.getByText('Screenshot attached.',{exact:true}).waitFor();assert.equal(await p.getByLabel('Attachment selections',{exact:true}).textContent(),'1 selections · general: screenshot');
  // Closing Pebble hides any portaled fan; reopening starts at rest with the draft retained.
  await button(p,'Add attachment').click();await wait(p);await button(p,'Close conversation').click();await wait(p);assert.equal(await p.locator('.brief-fan-layer').getAttribute('data-open'),'false');await button(p,'Open conversation').click();await wait(p);assert.equal(await field(p).inputValue(),'Keep this draft.\nAnother line.\nA third line.\nA fourth line.');
  await p.emulateMedia({reducedMotion:'reduce'});await button(p,'Add attachment').click();await p.waitForTimeout(60);assert.equal(await p.locator('.brief-fan-item').evaluateAll(rows=>rows.some(el=>el.getAnimations().some(a=>a.playState==='running'))),false);await p.keyboard.press('Escape');
  results.push({theme,rail,reversalCycles:20,labelCrossings:60,origin,closed,multilineClearance:suggestions.y-doc.y-doc.height,keyboard:true,unsupported:true,failureRetry:true,reduced:true});await context.close();
 }
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'}),p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await button(p,'Open conversation').click();await wait(p);await field(p).fill('Long draft\nwith three\nlines');await wait(p);await button(p,'Add attachment').tap();await wait(p);
 for(const kind of ['document','image','screenshot']){const r=await p.locator(`[data-choice="${kind}"]`).boundingBox();assert.ok(r.y>=0&&r.x>=0&&r.x+r.width<=390);}
 assert.equal(await p.locator('.brief-fan-layer').getAttribute('data-compact'),'true');
 const header=await p.locator('.brief-chat-tabs-header').boundingBox();
 for(const kind of ['document','image','screenshot'])assert.ok((await p.locator(`[data-choice="${kind}"]`).boundingBox()).y>=header.y+header.height+8);
 await capture(p,'narrow-touch');await button(p,'Close attachments').tap();assert.equal(await p.locator('.brief-fan-layer').getAttribute('data-open'),'false');await context.close();
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify({results,narrowTouch:true,errors},null,2));console.log('PASS four theme/sidebar layouts; 80 rapid reversal cycles, 240 icon-label crossings, multiline clearance, keyboard, unsupported screenshot, failure/retry, panel return, reduced motion and 390px touch. No real capture or upload.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
