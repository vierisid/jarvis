const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const url=process.env.BRIEF_PREVIEW_URL||'http://127.0.0.1:4401/?brief=preview&specimen=workflow-manage#/_brief_preview';
const btn=(p,name)=>p.getByRole('button',{name,exact:true});
const toggle=(p,name)=>p.getByRole('switch',{name:'Enable '+name,exact:true});
const wait=p=>p.waitForTimeout(650),shot=(p,name)=>p.screenshot({path:path.join(__dirname,name+'.png')});
const row=(p,id)=>p.locator(`[data-flow="${id}"]`);
const activeRows=p=>p.locator('.brief-management-collapse[data-removed="false"] [data-flow]').evaluateAll(es=>es.map(e=>e.dataset.flow));
const removed=(p,id)=>p.locator(`[data-flow="${id}"]`).evaluate(e=>e.closest('[data-removed]').dataset.removed==='true');
const bounds=async p=>{const x=await p.locator('.brief-workspace-content').evaluate(e=>({w:e.clientWidth,s:e.scrollWidth}));assert.ok(x.s<=x.w+1,'workspace overflow '+JSON.stringify(x));const b=await p.locator('.brief-management').evaluate(e=>({w:e.clientWidth,s:e.scrollWidth}));assert.ok(b.s<=b.w+1,'list overflow '+JSON.stringify(b));};
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});let p;const errors=[],mutations=[],layouts=[];
 const watch=p=>{p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()!=='GET')mutations.push(r.url());});};
 try {
  for(const theme of ['light','dark'])for(const rail of [false,true])for(const chat of [false,true]){
   const c=await browser.newContext({viewport:{width:1440,height:1100}});p=await c.newPage();watch(p);await p.goto(url);await btn(p,'Meeting follow-ups').waitFor();
   if(theme==='dark')await btn(p,'Switch to dark').click();if(rail)await btn(p,'Collapse sidebar').click();if(chat)await btn(p,'Open conversation').click();await wait(p);await bounds(p);
   await shot(p,`${theme}-${rail?'rail':'expanded'}-${chat?'chat':'closed'}`);
   await toggle(p,'Meeting follow-ups').click();await wait(p);assert.equal(await toggle(p,'Meeting follow-ups').getAttribute('aria-checked'),'false');
   await btn(p,'Delete Competitor watch').click();assert.equal(await btn(p,'Cancel').evaluate(e=>e===document.activeElement),true);await shot(p,`${theme}-${rail?'rail':'expanded'}-${chat?'chat':'closed'}-confirm`);
   await btn(p,'Delete').click();await wait(p);assert.equal(await removed(p,'competitor'),true);assert.equal(await btn(p,'Undo delete Competitor watch').evaluate(e=>e===document.activeElement),true);
   await btn(p,'Undo delete Competitor watch').click();await wait(p);assert.equal(await toggle(p,'Competitor watch').getAttribute('aria-checked'),'false');assert.deepEqual(await activeRows(p),['meeting','inbox','competitor','investor']);await bounds(p);
   layouts.push({theme,rail,chat,activation:true,confirm:true,remove:true,undoPaused:true,focus:true});await c.close();
  }
  p=await browser.newPage({viewport:{width:1440,height:1100}});watch(p);await p.goto(url);await btn(p,'Meeting follow-ups').waitFor();
  const title=await p.getByRole('heading',{name:'All workflows',exact:true}).boundingBox(),inbox=await row(p,'inbox').boundingBox();
  await btn(p,'Delete Meeting follow-ups').click();await p.keyboard.press('Escape');assert.equal(await btn(p,'Delete Meeting follow-ups').evaluate(e=>e===document.activeElement),true);assert.deepEqual(await row(p,'inbox').boundingBox(),inbox);
  // Ten repeated switch intents and row hover departures cannot strand visual state.
  for(let n=0;n<10;n++){await btn(p,'Meeting follow-ups').hover();await p.mouse.move(900,110);await toggle(p,'Meeting follow-ups').click();await wait(p);}
  assert.equal(await toggle(p,'Meeting follow-ups').getAttribute('aria-checked'),'true');
  await btn(p,'Delete Meeting follow-ups').click();await btn(p,'Delete').click();await wait(p);await btn(p,'Delete Competitor watch').click();await btn(p,'Delete').click();await wait(p);
  assert.deepEqual(await activeRows(p),['inbox','investor']);await shot(p,'two-deleted');await btn(p,'Undo delete Competitor watch').click();await wait(p);await btn(p,'Undo delete Meeting follow-ups').click();await wait(p);assert.deepEqual(await activeRows(p),['meeting','inbox','competitor','investor']);
  assert.deepEqual(await p.getByRole('heading',{name:'All workflows',exact:true}).boundingBox(),title);
  await p.getByLabel('Workflow management example').selectOption('blocked enable');await wait(p);await toggle(p,'Weekly investor update').click();await wait(p);assert.equal(await toggle(p,'Weekly investor update').getAttribute('aria-checked'),'false');assert.ok((await row(p,'investor').innerText()).includes('Connect Notion before enabling.'));await shot(p,'enable-blocked');
  for(const scenario of ['rejected delete','lost response']){
   await p.getByLabel('Workflow management example').selectOption(scenario);await wait(p);await btn(p,'Delete Meeting follow-ups').click();await btn(p,'Delete').click();await wait(p);
   assert.equal(await removed(p,'meeting'),false);
   if(scenario==='lost response'){assert.equal(await btn(p,'Delete').isDisabled(),true);await shot(p,'uncertain-removal');await btn(p,'Check result').click();await wait(p);assert.equal(await removed(p,'meeting'),true);assert.equal(await btn(p,'Undo delete Meeting follow-ups').evaluate(e=>e===document.activeElement),true);await btn(p,'Undo delete Meeting follow-ups').click();await wait(p);await btn(p,'Check result').click();await wait(p);assert.equal(await removed(p,'meeting'),false);}
   else assert.ok((await row(p,'meeting').innerText()).includes('Deletion was refused'));
  }
  await p.getByLabel('Workflow management example').selectOption('expired undo');await wait(p);await btn(p,'Delete Meeting follow-ups').click();await btn(p,'Delete').click();await p.waitForTimeout(2600);assert.equal(await btn(p,'Undo delete Meeting follow-ups').isDisabled(),true);
  await p.getByLabel('Workflow management example').selectOption('normal');await wait(p);
  await btn(p,'Delete Meeting follow-ups').click();
  const samples=await p.evaluate(async()=>{const r=document.querySelector('[data-flow="inbox"]');const values=[r.getBoundingClientRect().y];const action=[...document.querySelectorAll('.brief-management-confirm button')].find(b=>b.querySelector('.brief-button__label')?.textContent==='Delete');action.click();const t=performance.now();while(performance.now()-t<850){await new Promise(requestAnimationFrame);values.push(r.getBoundingClientRect().y);}return values;});
  const first=samples[0],last=samples.at(-1);assert.ok(first-last>80,'deleted row collapses');assert.ok(samples.some(v=>v<first-2&&v>last+2),'intermediate gap collapse rendered');
  await btn(p,'Undo delete Meeting follow-ups').click();await wait(p);await btn(p,'Meeting follow-ups').click();await p.locator('.react-flow__node').first().waitFor();await shot(p,'list-to-canvas');await btn(p,'Back to all workflows').click();await wait(p);assert.equal(await btn(p,'Meeting follow-ups').evaluate(e=>e===document.activeElement),true);
  await p.getByLabel('Workflow management example').selectOption('long list');await wait(p);const scroll=p.locator('.brief-management-scroll');await scroll.evaluate(e=>e.scrollTop=960);await p.waitForTimeout(50);const pos=await scroll.evaluate(e=>e.scrollTop);
  const selected=p.locator('.brief-management-collapse[data-removed="false"] .brief-management-open').nth(8);const selectedName=await selected.innerText();await selected.click();await btn(p,'Back to all workflows').click();await wait(p);assert.ok(Math.abs((await scroll.evaluate(e=>e.scrollTop))-pos)<2,'row return scroll');assert.equal(await btn(p,selectedName).evaluate(e=>e===document.activeElement),true);
  // Creation return has its own preserved draft/scroll owner; management retains its own position.
  await btn(p,'Back to workflow creation').click();await p.getByRole('heading',{name:'Create your workflow',exact:true}).waitFor();await btn(p,'See all workflows').click();await wait(p);await shot(p,'long-list-return');
  await btn(p,'Open conversation').click();await wait(p);await bounds(p);await shot(p,'long-compact');
  await scroll.evaluate(e=>e.scrollTop=0);await wait(p);await btn(p,'Delete Meeting follow-ups').click();await btn(p,'Delete').click();await wait(p);
  const undoBox=await btn(p,'Undo delete Meeting follow-ups').boundingBox();assert.ok(undoBox.y>0&&undoBox.y+undoBox.height<1100,'long-list Undo reachable without page jump');await shot(p,'long-list-undo');await btn(p,'Undo delete Meeting follow-ups').click();await wait(p);

  for(const mode of ['stale','unavailable','unsupported','empty']){await p.getByLabel('Workflow management example').selectOption(mode);await wait(p);await bounds(p);if(mode==='stale')assert.equal(await toggle(p,'Meeting follow-ups').isDisabled(),true);if(mode==='empty')assert.ok((await p.locator('.brief-management').innerText()).includes('No workflows in this list.'));else assert.ok(!(await p.locator('.brief-management').innerText()).includes('0 workflows'));}
  await p.getByLabel('Workflow management example').selectOption('normal');await wait(p);await btn(p,'Close conversation').click();await p.emulateMedia({reducedMotion:'reduce'});await p.setViewportSize({width:390,height:844});await wait(p);await bounds(p);await shot(p,'narrow-reduced');
  await btn(p,'Delete Meeting follow-ups').click();await btn(p,'Delete').click();await wait(p);assert.equal(await p.locator('.brief-management-collapse').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s');await btn(p,'Undo delete Meeting follow-ups').click();await wait(p);await bounds(p);
  assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);
  fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify({layouts,cycles:10,inlineCancel:true,reverseOrderUndo:true,blockedEnable:true,uncertainReadOnlyRecovery:true,expiredReceipt:true,gapCollapseIntermediate:true,exactCanvasHandoff:true,longListUndoReachable:true,longListReturn:true,creationReturn:true,narrow:true,reducedMotion:true,errors,mutations},null,2)+'\n');
  console.log('PASS: eight layouts, inline confirmation/focus, ten activation/hover cycles, out-of-order Undo, blockers, uncertainty/reconciliation, receipt expiry, canvas and creation return, long list, honest read states, narrow/reduced motion; no mutation requests.');
 }catch(e){if(p&&!p.isClosed()){await shot(p,'failure');fs.writeFileSync(path.join(__dirname,'failure.txt'),String(e)+'\n'+await p.locator('body').innerText());}throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
