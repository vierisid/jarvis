const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.D15_REVIEW_URL||'http://127.0.0.1:4395/review-d15/review-fixture.html';
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),results=[],errors=[];try{
 for(const theme of ['light','dark'])for(const width of [320,448])for(const scenario of (process.env.D15_REVIEW_CASE?[process.env.D15_REVIEW_CASE]:['restore','lists','empty','bottom'])){
  const p=await browser.newPage({viewport:{width:Math.max(width+48,390),height:900},reducedMotion:'reduce'});p.on('pageerror',e=>errors.push(e.message));
  await p.goto(`${base}?case=${scenario}&theme=${theme}&width=${width}`);const scroll=p.locator('.brief-message-scroll');await scroll.waitFor();await p.waitForTimeout(100);
  assert.equal(await p.locator('.brief-root').evaluate(el=>getComputedStyle(el).backgroundColor),theme==='dark'?'rgb(18, 20, 23)':'rgb(250, 251, 252)');
  if(scenario==='lists'){
   const styles=await p.locator('.brief-reply-prose').evaluate(el=>({
    ordered:[...el.querySelectorAll('ol')].map(n=>getComputedStyle(n).listStyleType),
    unordered:[...el.querySelectorAll('ul')].map(n=>getComputedStyle(n).listStyleType),
    tasks:[...el.querySelectorAll('li.task-list-item')].map(n=>getComputedStyle(n).listStyleType),
    normal:[...el.querySelectorAll('li:not(.task-list-item)')].map(n=>getComputedStyle(n).listStyleType),
    start:el.querySelector('ol').start,checks:[...el.querySelectorAll('input[type=checkbox]')].map(n=>({checked:n.checked,disabled:n.disabled})),
    overflow:el.scrollWidth>el.clientWidth+1}));
   assert.ok(styles.ordered.every(s=>s==='decimal'),JSON.stringify(styles));assert.ok(styles.unordered.every(s=>s==='disc'||s==='circle'),JSON.stringify(styles));
   assert.deepEqual(styles.tasks,['none','none']);assert.ok(styles.normal.every(s=>s!=='none'));assert.equal(styles.start,3);
   assert.deepEqual(styles.checks,[{checked:true,disabled:true},{checked:false,disabled:true}]);assert.equal(styles.overflow,false);
   await p.screenshot({path:path.join(__dirname,`review-lists-${theme}-${width}.png`)});results.push({theme,width,scenario,...styles});
  }else{
   for(const name of ['Loading','Fail history','Loading']){await p.getByRole('button',{name,exact:true}).click();await p.waitForTimeout(60);}
   assert.equal(await p.locator('#writes').textContent(),'[]');
   await p.getByRole('button',{name:'Load history',exact:true}).click();await p.waitForTimeout(120);
   const actual=await scroll.evaluate(el=>({top:el.scrollTop,bottom:el.scrollHeight-el.clientHeight-el.scrollTop}));
   if(scenario==='restore'){
    assert.ok(Math.abs(actual.top-480)<2,JSON.stringify(actual));assert.ok(actual.bottom>100);
    await p.getByRole('button',{name:'Switch chat',exact:true}).click();await p.getByRole('button',{name:'Switch chat',exact:true}).click();await p.waitForTimeout(80);
    assert.ok(Math.abs(await scroll.evaluate(el=>el.scrollTop)-480)<2);
   }else if(scenario==='bottom')assert.ok(actual.bottom<2,JSON.stringify(actual));
   else {assert.equal(actual.top,0);assert.equal(await p.locator('.brief-reply-latest').count(),0);}
   results.push({theme,width,scenario,...actual});
  }await p.close();
 }assert.deepEqual(errors,[]);fs.writeFileSync(path.join(__dirname,'review-browser-results.json'),JSON.stringify({results,errors},null,2)+'\n');console.log('PASS delayed history/error/retry restores 480px, A/B/A retention, true bottom followers, genuine empty history, ordered/nested/mixed task-list markers; both themes at 320px and 448px.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
