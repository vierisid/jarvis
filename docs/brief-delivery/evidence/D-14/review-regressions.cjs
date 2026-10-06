const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.BRIEF_PREVIEW_URL||'http://127.0.0.1:4394/?brief=preview&specimen=attachments#/_brief_preview';
const button=(p,name)=>p.getByRole('button',{name,exact:true});
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
  try {
    if(!process.env.R2_ONLY){
      const p=await browser.newPage({viewport:{width:1440,height:1150},reducedMotion:'reduce'});
      await p.goto(base);await button(p,'Open conversation').click();
      await p.getByRole('textbox',{name:'Message Jarvis',exact:true}).fill('Keep the original draft.');
      await button(p,'Add attachment').click();await p.locator('[data-choice="document"]').click();
      await p.getByRole('tab',{name:'Investor update',exact:true}).click();await p.waitForTimeout(500);
      assert.equal(await p.getByLabel('Attachment feedback',{exact:true}).textContent(),'');
      await p.getByRole('tab',{name:'General',exact:true}).click();
      assert.equal(await p.getByLabel('Attachment feedback',{exact:true}).textContent(),'');
      assert.equal(await p.getByLabel('Attachment selections',{exact:true}).textContent(),'0 selections');
      assert.equal(await p.getByRole('textbox',{name:'Message Jarvis',exact:true}).inputValue(),'Keep the original draft.');
      results.push({chatRoundTrip:true,cancelledReceiptCleared:true,draftRetained:true});await p.close();
    }
    for(const width of [390,1440])for(const theme of ['light','dark']){
      const p=await browser.newPage({viewport:{width:1440,height:800},reducedMotion:'reduce'});
      await p.goto(base);if(theme==='dark')await button(p,'Switch to dark').click();
      await p.setViewportSize({width,height:width===390?844:800});
      await button(p,'Open conversation').click();
      await p.getByRole('textbox',{name:'Message Jarvis',exact:true}).fill('Long draft\nwith three\nlines');
      await button(p,'Add attachment').click();await p.waitForTimeout(100);
      assert.equal(await p.locator('.brief-fan-layer').getAttribute('data-compact'),'true');
      for(const interaction of ['hover','focus']){
        const row=p.locator('[data-choice="screenshot"]');
        if(interaction==='hover')await row.hover();else {
          await p.mouse.move(0,0);await button(p,'Close attachments').focus();
          await p.keyboard.press('ArrowUp');await p.keyboard.press('End');
        }
        const geometry=await row.locator('.brief-fan-reason').evaluate(el=>{
          const reason=el.getBoundingClientRect(),layer=el.closest('.brief-fan-layer'),box=layer.getBoundingClientRect();
          const clip=getComputedStyle(layer).clipPath.match(/inset\((.*)\)/)[1].split(/\s+/);
          const left=box.left+parseFloat(clip[3]);
          return {left:reason.left,right:reason.right,top:reason.top,bottom:reason.bottom,clipLeft:left,
            hit:el.contains(document.elementFromPoint(reason.left+2,reason.top+reason.height/2)),width:innerWidth,height:innerHeight};
        });
        if(process.env.R2_ONLY)await p.screenshot({path:path.join(__dirname,'review-before-compact-hint.png')});
        assert.ok(geometry.left>=geometry.clipLeft&&geometry.left>=8,`Explanation is left-clipped: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.right<=width-8&&geometry.top>=8&&geometry.bottom<=geometry.height-8);
        assert.equal(geometry.hit,true,'Explanation must be visibly hit-testable at its left edge');
        results.push({width,theme,interaction,...geometry});
        if(interaction==='focus')await p.screenshot({path:path.join(__dirname,`review-hint-${width}-${theme}.png`)});
      }
      await p.keyboard.press('Escape');assert.equal(await p.locator('.brief-fan-layer').getAttribute('data-open'),'false');
      await p.close();
    }
    fs.writeFileSync(path.join(__dirname,'review-browser-results.json'),JSON.stringify(results,null,2)+'\n');
    console.log('PASS A/B/A cancellation and retained draft; full Screenshot explanation visible and hit-testable on hover/focus in both themes at 390px and 1440px compact layouts. No live effects.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
