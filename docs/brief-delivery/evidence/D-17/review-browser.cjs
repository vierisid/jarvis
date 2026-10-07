const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const url=process.env.BRIEF_PREVIEW_URL||'http://127.0.0.1:4397/?brief=preview&specimen=ingredient-picker#/_brief_preview';
const red=process.env.REVIEW_RED==='1',results=[],errors=[];
async function sample(p,selector,label) {
 const frames=await p.evaluate(async({selector})=>{
  const frames=[],surface=document.querySelector('.brief-workflow-create-group .brief-composer-surface'),input=surface.querySelector('textarea'),textHeightBefore=input.getBoundingClientRect().height;
  function read(){const s=surface.getBoundingClientRect(),t=input.getBoundingClientRect(),c=surface.querySelector('.brief-composer-ingredients')?.getBoundingClientRect();const send=surface.querySelector('[aria-label="Send"]').getBoundingClientRect();
   frames.push({height:s.height,textHeight:t.height,textTop:t.top-s.top,textBottom:t.bottom-s.top,chipsTop:c?c.top-s.top:null,sendInset:s.bottom-send.bottom,sendWidth:send.width,textHeightBefore});}
  document.querySelector(selector).click();await Promise.resolve();read();
  const start=performance.now();await new Promise(resolve=>{function tick(){read();if(performance.now()-start<240)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});return frames;
 },{selector});
 const invalid=frames.filter(f=>Math.abs(f.textHeight-f.textHeightBefore)>0.5||f.textHeight<43.5||f.textTop<4.5||f.textBottom>f.height-4.5||(f.chipsTop!==null&&f.textBottom>f.chipsTop+0.5)||Math.abs(f.sendInset-6)>1||f.sendWidth!==44);
 results.push({label,samples:frames.length,minTextHeight:Math.min(...frames.map(f=>f.textHeight)),minTextTop:Math.min(...frames.map(f=>f.textTop)),first:frames[0],last:frames.at(-1),invalid});return invalid.length===0;
}
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const layouts=red?[{theme:'light',rail:false,chat:false,width:1440,reduced:false}]:[
  ...['light','dark'].flatMap(theme=>[false,true].flatMap(rail=>[false,true].map(chat=>({theme,rail,chat,width:1440,reduced:false})))),
  {theme:'light',rail:true,chat:false,width:390,reduced:false},{theme:'dark',rail:true,chat:false,width:390,reduced:true}];
 for(const layout of layouts){const context=await browser.newContext({viewport:{width:layout.width,height:1150},reducedMotion:layout.reduced?'reduce':'no-preference'}),p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(url);const prompt=p.getByRole('textbox',{name:'Workflow prompt',exact:true});await prompt.waitFor();
  if(await p.locator('.brief-today-specimen').getAttribute('data-brief-theme')!==layout.theme)await p.getByRole('button',{name:`Switch to ${layout.theme}`,exact:true}).click();
  if(layout.rail&&layout.width>500)await p.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
  if(layout.chat)await p.getByRole('button',{name:'Open conversation',exact:true}).click();await p.waitForTimeout(350);
  await prompt.fill('Prepare my next call.');await p.getByRole('button',{name:'Add connection or library node',exact:true}).click();await p.waitForTimeout(220);
  await sample(p,'.brief-ingredient-row',JSON.stringify(layout)+' / first chip');
  if(!red){await p.getByRole('tab',{name:'Library',exact:true}).click();
   await sample(p,'.brief-ingredient-row:nth-child(2)',JSON.stringify(layout)+' / wrapped chip');
   await p.keyboard.press('Escape');await p.waitForTimeout(220);
   await sample(p,'.brief-ingredient-chip button',JSON.stringify(layout)+' / remove first');
   await sample(p,'.brief-ingredient-chip button',JSON.stringify(layout)+' / remove last');
   if(layout.width===390)await p.screenshot({path:path.join(__dirname,`review-${layout.theme}-narrow.png`)});
   if(layout.theme==='light'&&!layout.rail&&!layout.chat){
    await p.getByRole('button',{name:'Add connection or library node',exact:true}).click();await p.getByRole('tab',{name:'Connections',exact:true}).click();
    for(let i=0;i<10;i++){await sample(p,'.brief-ingredient-row',`cycle ${i+1} add`);await sample(p,'.brief-ingredient-row',`cycle ${i+1} remove`);}
   }
   await p.keyboard.press('Escape');await p.waitForTimeout(220);
   await prompt.fill('Prepare the next call with the selected tools. '.repeat(15));await p.waitForTimeout(220);
   await p.getByRole('button',{name:'Add connection or library node',exact:true}).click();await p.getByRole('tab',{name:'Library',exact:true}).click();await p.waitForTimeout(220);
   await sample(p,'.brief-ingredient-row:nth-child(2)',JSON.stringify(layout)+' / multiline add');
   await sample(p,'.brief-ingredient-row:nth-child(2)',JSON.stringify(layout)+' / multiline remove');
  }
  await context.close();console.log('Checked',JSON.stringify(layout));
 }
 const failed=results.filter(r=>r.invalid.length);fs.writeFileSync(path.join(__dirname,red?'review-browser-red.json':'review-browser-results.json'),JSON.stringify({results,errors},null,2)+'\n');
 assert.deepEqual(errors,[]);assert.equal(failed.length,0,JSON.stringify(failed.map(r=>({label:r.label,firstInvalid:r.invalid[0]}))));console.log(`PASS ${results.length} frame-sampled changes; ${results.reduce((n,r)=>n+r.samples,0)} frames`);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
