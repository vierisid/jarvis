const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const context=await browser.newContext({viewport:{width:1440,height:1150},reducedMotion:'no-preference'}),page=await context.newPage();
 const frames=[],cdp=await context.newCDPSession(page),tmp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'d14-motion-'));
 cdp.on('Page.screencastFrame',event=>{const file=path.join(tmp,`${frames.length}.jpg`);fs.writeFileSync(file,Buffer.from(event.data,'base64'));frames.push({file,time:event.metadata.timestamp});void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});});
 await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:1002,maxHeight:800,everyNthFrame:1});
 await page.goto('http://127.0.0.1:4394/?brief=preview&specimen=attachments#/_brief_preview');await page.getByRole('button',{name:'Open conversation',exact:true}).click();await page.waitForTimeout(600);
 await page.getByRole('button',{name:'Add attachment',exact:true}).click();await page.waitForTimeout(500);
 for(const kind of ['document','image','screenshot']){await page.locator(`[data-choice="${kind}"]`).hover();await page.waitForTimeout(450);}
 await page.getByRole('button',{name:'Close attachments',exact:true}).click();await page.waitForTimeout(400);
 const b=await page.locator('.brief-fan-toggle').boundingBox();for(let i=0;i<3;i++){await page.mouse.click(b.x+22,b.y+22);await page.waitForTimeout(65);await page.mouse.click(b.x+22,b.y+22);await page.waitForTimeout(45);}
 await page.getByRole('textbox',{name:'Message Jarvis',exact:true}).fill('Prepare my next call.\nInclude our notes\nand three questions.');await page.waitForTimeout(300);
 await page.getByRole('button',{name:'Add attachment',exact:true}).click();await page.waitForTimeout(600);await page.locator('[data-choice="document"]').hover();await page.waitForTimeout(600);
 await page.getByRole('button',{name:'Close attachments',exact:true}).click();await page.waitForTimeout(450);
 await cdp.send('Page.stopScreencast');await context.close();
 const concat=path.join(tmp,'frames.txt');fs.writeFileSync(concat,frames.map((frame,i)=>`file '${frame.file.replaceAll('\\','/')}'\nduration ${Math.max(.01,(frames[i+1]?.time??frame.time+.2)-frame.time)}`).join('\n'));
 const result=require('node:child_process').spawnSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',concat,'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',path.join(__dirname,'attachment-motion.mp4')],{encoding:'utf8'});
 if(result.status!==0)throw Error(result.stderr||String(result.error));
 console.log(`Saved attachment-motion.mp4 from ${frames.length} browser frames: entry, labels, exit, reversal and multiline clearance.`);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
