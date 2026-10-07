const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const url = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4400/?brief=preview&specimen=workflow-context#/_brief_preview';
const btn = (p, name) => p.getByRole('button', {name, exact:true});
const wait = p => p.waitForTimeout(380);
const evidencePath = name => path.join(__dirname, (process.env.BRIEF_EVIDENCE_PREFIX || '') + name);
const shot = (p,name) => p.screenshot({path:evidencePath(name+'.png')});
const context = p => p.locator('[data-context-basis]');
const bounds = async p => {
  const r = await p.locator('.brief-workspace-content').evaluate(e => ({w:e.clientWidth,s:e.scrollWidth}));
  assert.ok(r.s <= r.w+1,'workspace overflow');
  const card = await p.locator('.brief-context-scroll').evaluate(e => ({w:e.clientWidth,s:e.scrollWidth}));
  assert.ok(card.s <= card.w+1,'context overflow');
};
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true}), errors=[], mutations=[], layouts=[];
  let p;
  try {
    for(const theme of ['light','dark']) for(const rail of [false,true]) for(const chat of [false,true]) {
      const c=await browser.newContext({viewport:{width:1440,height:1100}}); p=await c.newPage();
      p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()!=='GET')mutations.push(r.url());});
      await p.goto(url);await context(p).waitFor();
      if(theme==='dark')await btn(p,'Switch to dark').click();
      if(rail)await btn(p,'Collapse sidebar').click();if(chat)await btn(p,'Open conversation').click();await wait(p);
      assert.equal(await context(p).getAttribute('data-context-basis'),'configured');
      await bounds(p);await shot(p,`${theme}-${rail?'rail':'expanded'}-${chat?'chat':'closed'}`);
      await p.getByRole('radio',{name:'Used by run',exact:true}).check();await p.locator('[data-context-basis="recorded"]').waitFor();
      assert.equal(await context(p).getAttribute('data-context-run'),'meeting-run-012');
      layouts.push({theme,rail,chat,configured:true,recorded:'meeting-run-012'});await c.close();
    }
    p=await browser.newPage({viewport:{width:1440,height:1100}});p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()!=='GET')mutations.push(r.url());});
    await p.goto(url);await context(p).waitFor();
    const header = await p.locator('.brief-canvas-heading').boundingBox();
    await btn(p,'Open goal goal-design-partners').click();await p.getByRole('dialog').waitFor();
    assert.ok((await p.getByRole('dialog').innerText()).includes('goal-design-partners'));await btn(p,'Back to context').click();await wait(p);
    assert.equal(await btn(p,'Open goal goal-design-partners').evaluate(e=>e===document.activeElement),true,'source focus return');
    await btn(p,'Runs').click();await p.locator('[data-run-id="meeting-run-012"]').waitFor();await btn(p,'Open Run 001').click();await p.locator('[data-run-id="meeting-run-001"]').waitFor();
    await btn(p,'Context & rules').click();await context(p).waitFor();await p.getByRole('radio',{name:'Used by run',exact:true}).check();await p.locator('[data-context-version="meeting-v2"]').waitFor();
    assert.ok((await context(p).innerText()).includes('Start three pilots'));assert.ok(!(await context(p).innerText()).includes('Win 10 design partners'));await shot(p,'historical-run');
    await btn(p,'Canvas').click();await p.locator('.react-flow__node').first().waitFor();await wait(p);
    const canvasHeader=await p.locator('.brief-canvas-heading').boundingBox();
    assert.ok(Math.abs(header.x-canvasHeader.x)<1 && Math.abs(header.y-canvasHeader.y)<1 && Math.abs(header.height-canvasHeader.height)<1,'shared header drift');
    await p.locator('.react-flow__node[data-id="draft"]').focus();await p.keyboard.press('Enter');await p.getByRole('complementary',{name:'Step settings'}).waitFor();await shot(p,'canvas-inspector-return');
    await btn(p,'Context & rules').click();await p.locator('[data-context-version="meeting-v2"]').waitFor();
    for(let n=0;n<10;n++){await p.getByRole('radio',{name:'Configured',exact:true}).check();await p.getByRole('radio',{name:'Used by run',exact:true}).check();}assert.equal(await context(p).getAttribute('data-context-run'),'meeting-run-001');
    await btn(p,'Open conversation').click();await btn(p,'Collapse sidebar').click();await wait(p);assert.equal(await context(p).getAttribute('data-context-run'),'meeting-run-001');
    await p.getByLabel('Workflow context example').selectOption('missing');await wait(p);assert.ok((await context(p).innerText()).includes('Source removed'));assert.equal(await btn(p,'Open goal goal-first-pilots').count(),0);await shot(p,'missing-compact');
    await p.getByLabel('Workflow context example').selectOption('long');await wait(p);await bounds(p);const scroller=p.locator('.brief-context-scroll');await scroller.evaluate(e=>e.scrollTop=360);await p.waitForTimeout(50);
    const top=await scroller.evaluate(e=>e.scrollTop);await btn(p,'Runs').click();await wait(p);await btn(p,'Context & rules').click();await wait(p);assert.ok(Math.abs((await scroller.evaluate(e=>e.scrollTop))-top)<2,'scroll restore');await shot(p,'long-compact');
    await p.getByLabel('Workflow context example').selectOption('partial');await wait(p);assert.ok((await context(p).innerText()).includes('Recorded usage is unavailable'));await shot(p,'partial');
    for(const [mode,phrase] of [['unavailable','could not be loaded'],['unsupported','not supported'],['empty','No context was recorded']]){await p.getByLabel('Workflow context example').selectOption(mode);await wait(p);assert.ok((await p.locator('.brief-context-feedback').innerText()).includes(phrase));}
    await p.getByLabel('Workflow context example').selectOption('normal');await wait(p);await btn(p,'Run workflow').click();await p.locator('[data-run-id="meeting-run-013"]').waitFor();await btn(p,'Context & rules').click();await p.locator('[data-selected-run="meeting-run-013"]').waitFor();assert.ok((await p.locator(".brief-context-feedback").innerText()).includes("No context was recorded"));
    await btn(p,'Close conversation').click();await wait(p);await p.emulateMedia({reducedMotion:'reduce'});await p.setViewportSize({width:390,height:844});await wait(p);await bounds(p);await p.getByRole('radio',{name:'Configured',exact:true}).focus();await p.keyboard.press('Space');await p.locator('[data-context-basis="configured"]').waitFor();await shot(p,'narrow-reduced-motion');
    assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);
    fs.writeFileSync(evidencePath('browser-results.json'),JSON.stringify({layouts,sourceIdentity:true,sourceFocusReturn:true,historicalVersion:true,headerAligned:true,canvasInspector:true,basisCycles:10,selectionAndScrollReturn:true,partial:true,missing:true,narrow:true,reducedMotion:true,sharedRunReceipt:true,errors,mutations},null,2)+'\n');
    console.log('PASS: eight layouts, configured/recorded identity, source focus return, historical version, stable Canvas header/inspector, ten basis cycles, scroll restoration, unavailable/partial/missing, shared Run receipt and narrow/reduced motion.');
  }catch(e){if(p&&!p.isClosed()){await shot(p,'failure');fs.writeFileSync(evidencePath('failure.txt'),String(e)+'\n'+await p.locator('body').innerText());}throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
