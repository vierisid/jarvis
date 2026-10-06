const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.BRIEF_PREVIEW_URL||'http://127.0.0.1:4395/?brief=preview&specimen=messages#/_brief_preview';
const button=(p,name)=>p.getByRole('button',{name,exact:true}),wait=p=>p.waitForTimeout(380);
const rect=async x=>{const r=await x.boundingBox();return {x:r.x,y:r.y,width:r.width,height:r.height};};
const screenshot=(p,name)=>p.screenshot({path:path.join(__dirname,name+'.png')});
const scroll=p=>p.locator('.brief-message-scroll');
async function place(p,top){await scroll(p).evaluate((el,top)=>el.scrollTop=top,top);await p.waitForTimeout(80);}
async function top(p){return scroll(p).evaluate(el=>el.scrollTop);}
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),results=[],errors=[];
try{
 for(const theme of ['light','dark'])for(const rail of [false,true]){
  const context=await browser.newContext({viewport:{width:1440,height:1150},reducedMotion:'no-preference'}),p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base);await button(p,'Open conversation').waitFor();if(await p.locator('.brief-today-specimen').getAttribute('data-brief-theme')!==theme)await button(p,`Switch to ${theme}`).click();if(rail)await button(p,'Collapse sidebar').click();await button(p,'Open conversation').click();await wait(p);
  const fixed=await rect(p.locator('.brief-composer-surface')),bubble=await rect(p.locator('.brief-user-message'));
  assert.ok((await rect(p.locator('.brief-activity-toggle'))).y-(bubble.y+bubble.height)>=23);
  await screenshot(p,`answer-${theme}-${rail?'rail':'expanded'}`);
  for(let i=0;i<10;i++){
   await p.locator('.brief-activity-toggle').click();await wait(p);assert.equal(await p.locator('.brief-activity-toggle').getAttribute('aria-expanded'),'true');
   const row=await rect(p.locator('.brief-activity-list li').last()),heading=await rect(p.locator('.brief-reply-prose h2'));
   assert.ok(heading.y-(row.y+row.height)>=31);assert.deepEqual(await rect(p.locator('.brief-composer-surface')),fixed);
   await p.locator('.brief-activity-toggle').click();assert.equal(await p.locator('.brief-activity-toggle').getAttribute('aria-expanded'),'false');
  }
  await p.locator('.brief-activity-toggle').click();await screenshot(p,`activity-${theme}-${rail?'rail':'expanded'}`);
  await p.getByRole('tab',{name:'Investor update',exact:true}).click();await p.getByRole('tab',{name:'General',exact:true}).click();assert.equal(await p.locator('.brief-activity-toggle').getAttribute('aria-expanded'),'true');
  // Long replies: semantic anchor through shell width change, history prepend and A/B/A.
  await button(p,'Long reply').click();await place(p,1250);const before=await top(p);assert.ok(before>1000);
  const anchor=await scroll(p).evaluate(el=>{const t=el.getBoundingClientRect().top;const node=[...el.querySelectorAll('.brief-reply-prose p')].find(n=>n.getBoundingClientRect().bottom>t);return {text:node.textContent,y:node.getBoundingClientRect().top-t};});
  await button(p,rail?'Expand sidebar':'Collapse sidebar').click();await wait(p);
  const afterAnchor=await scroll(p).evaluate((el,text)=>{const n=[...el.querySelectorAll('.brief-reply-prose p')].find(n=>n.textContent===text);return n.getBoundingClientRect().top-el.getBoundingClientRect().top;},anchor.text);
  assert.ok(Math.abs(afterAnchor-anchor.y)<3,`width anchor drift: ${afterAnchor-anchor.y}`);
  const retained=await top(p);
  const retainedAnchor=await scroll(p).evaluate(el=>{const top=el.getBoundingClientRect().top;const n=[...el.querySelectorAll('.brief-reply-prose p')].find(n=>n.getBoundingClientRect().bottom>top);return {text:n.textContent,y:n.getBoundingClientRect().top-top};});
  await button(p,'Load earlier messages').evaluate(el=>el.click());await wait(p);
  const prependAnchor=await scroll(p).evaluate((el,text)=>[...el.querySelectorAll('.brief-reply-prose p')].find(n=>n.textContent===text).getBoundingClientRect().top-el.getBoundingClientRect().top,retainedAnchor.text);
  assert.ok(Math.abs(prependAnchor-retainedAnchor.y)<3);const afterPrepend=await top(p);
  await p.getByRole('tab',{name:'Investor update',exact:true}).click();await p.getByRole('tab',{name:'General',exact:true}).click();await wait(p);assert.ok(Math.abs(await top(p)-afterPrepend)<3);
  for(let i=0;i<10;i++){await button(p,'Close conversation').click();await p.waitForTimeout(40);await button(p,'Open conversation').click();await p.waitForTimeout(60);}await wait(p);assert.ok(Math.abs(await top(p)-afterPrepend)<3);assert.deepEqual(await rect(p.locator('.brief-composer-surface')),fixed);
  // An offscreen stream must not pull the reader down.
  const resting=await top(p);await button(p,'Start response').click();await wait(p);assert.ok(Math.abs(await top(p)-resting)<3);
  await button(p,'Latest messages').click();await wait(p);assert.ok(await scroll(p).evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<2));
  assert.equal(await p.locator('.brief-activity-marker[data-current="true"]').count(),1);
  assert.equal(await p.locator('.brief-activity-marker').evaluateAll(nodes=>nodes.filter(n=>n.getAnimations().some(a=>a.playState==='running')).length),1);
  await button(p,'Replay snapshot').click();await wait(p);assert.equal(await p.locator('.brief-activity-marker[data-current="true"]').count(),0);
  await button(p,'Partial failure').click();await wait(p);assert.ok(await scroll(p).evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<2));
  assert.match(await p.locator('.brief-assistant-reply').last().innerText(),/partial answer is kept above/);await screenshot(p,`failure-${theme}-${rail?'rail':'expanded'}`);
  // Reduced motion keeps the working meaning without a moving marker.
  await p.emulateMedia({reducedMotion:'reduce'});await button(p,'Start response').click();await wait(p);assert.equal(await p.locator('.brief-activity-marker').evaluateAll(nodes=>nodes.some(n=>n.getAnimations().some(a=>a.playState==='running'))),false);
  assert.deepEqual(await rect(p.locator('.brief-composer-surface')),fixed);
  results.push({theme,rail,activityCycles:10,panelReversals:10,anchor,afterAnchor,retained,afterPrepend,historyPrepend:true,bottomFollow:true,partialFailure:true,replayStill:true,reduced:true});await context.close();
 }
 for(const theme of ['light','dark']){
  const p=await browser.newPage({viewport:{width:1440,height:800},reducedMotion:'reduce'});p.on('pageerror',e=>errors.push(e.message));await p.goto(base);if(await p.locator('.brief-today-specimen').getAttribute('data-brief-theme')!==theme)await button(p,`Switch to ${theme}`).click();await button(p,'Long reply').click();await p.setViewportSize({width:390,height:844});await button(p,'Open conversation').click();await wait(p);await place(p,100000);
  assert.ok(await p.locator('.brief-pebble-surface').evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await scroll(p).evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  const visibleTail=await scroll(p).evaluate(el=>{const box=el.getBoundingClientRect(),link=el.querySelector('.brief-reply-prose a').getBoundingClientRect();return {height:el.clientHeight,visible:link.top>=box.top&&link.bottom<=box.bottom};});assert.ok(visibleTail.visible,JSON.stringify(visibleTail));
  const code=await p.locator('.brief-reply-prose pre').evaluate(el=>({width:el.clientWidth,overflow:el.scrollWidth>el.clientWidth}));assert.equal(code.overflow,true);await screenshot(p,`narrow-${theme}`);await p.close();
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify({results,narrow:true,errors},null,2)+'\n');console.log('PASS 40 activity cycles, 40 panel reversals, both themes/sidebar states, semantic anchors across width and tab changes, bottom-only follow, partial failures, replay and reduced motion; 390px code/table containment.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
