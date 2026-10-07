const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const url = process.env.BRIEF_PREVIEW_URL || 'http://127.0.0.1:4399/?brief=preview&specimen=workflow-runs#/_brief_preview';
const btn = (p, name) => p.getByRole('button', {name, exact: true});
const detail = p => p.getByRole('article', {name: 'Selected run details'});
const settled = p => p.waitForTimeout(380);
const selected = (p, n) => p.locator(`[data-run-id="meeting-run-${n}"]`).waitFor();
const shot = (p, name) => p.screenshot({path: path.join(__dirname, name + '.png')});
(async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  const errors = [], mutations = [], layouts = [];
  let p;
  try {
    for (const theme of ['light','dark']) for (const rail of [false,true]) for (const chat of [false,true]) {
      const context = await browser.newContext({viewport:{width:1440,height:1100}});
      p = await context.newPage();
      p.on('pageerror', e => errors.push(e.message));
      p.on('request', r => {if (r.method() !== 'GET') mutations.push(r.url());});
      await p.goto(url); await selected(p,'012');
      if (theme === 'dark') await btn(p,'Switch to dark').click();
      await btn(p,'Open Run 006').click(); await selected(p,'006');
      if (rail) await btn(p,'Collapse sidebar').click();
      if (chat) await btn(p,'Open conversation').click();
      await settled(p); await selected(p,'006');
      assert.equal(await detail(p).count(),1);
      assert.equal(await p.getByRole('dialog').count(),0);
      assert.ok((await detail(p).innerText()).includes('confirmation was not received'));
      const bounds = await p.locator('.brief-workspace-content').evaluate(e => ({w:e.clientWidth, s:e.scrollWidth}));
      assert.ok(bounds.s <= bounds.w+1, 'work area overflow');
      if (!chat) {
        const opener = await btn(p,'Open conversation').boundingBox(), card = await detail(p).boundingBox();
        assert.ok(card.y+card.height <= opener.y+1, 'detail covers opener');
      }
      await shot(p,`${theme}-${rail?'rail':'expanded'}-${chat?'chat':'closed'}`);
      layouts.push({theme,rail,chat,selected:'meeting-run-006',inlineCards:1});
      await context.close();
    }
    p = await browser.newPage({viewport:{width:1440,height:1100}});
    p.on('pageerror', e => errors.push(e.message));
    p.on('request', r => {if (r.method() !== 'GET') mutations.push(r.url());});
    await p.goto(url); await selected(p,'012');
    await shot(p,'paused-wide');
    const statuses = { '012':'Paused','011':'Succeeded','010':'Running','009':'Queued','008':'Failed','007':'Cancelled','006':'Uncertain' };
    for (const [id,status] of Object.entries(statuses)) {
      await btn(p,'Open Run '+id).click(); await selected(p,id);
      assert.equal(await detail(p).locator('.brief-run-document-heading .brief-run-status').innerText(),status);
    }
    await btn(p,'Open Run 007').click(); await selected(p,'007');
    assert.ok((await detail(p).innerText()).includes('did not undo it'));
    await btn(p,'Open Run 001').click(); await selected(p,'001');
    assert.ok((await detail(p).innerText()).includes('meeting-v2'));
    assert.ok((await detail(p).innerText()).includes('No longer available'));
    await btn(p,'Open Run 012').click(); await selected(p,'012');
    await detail(p).locator('summary').last().click();
    assert.ok((await detail(p).innerText()).includes('Redacted'));
    assert.ok(!(await p.locator('body').textContent()).includes('PRIVATE_CANARY'));
    assert.ok((await detail(p).innerText()).includes('Email approval'));
    await shot(p,'step-inspection');
    // Force a late A response after selecting B. Providers may ignore abort.
    await p.getByLabel('Run history example').selectOption('slow');
    for (let i=0; i<10; i++) {
      await btn(p,'Open Run 011').click(); await selected(p,'011');
      await btn(p,'Open Run 012').click();
      assert.equal(await p.locator('[data-run-id="meeting-run-011"]').count(),0);
      await btn(p,'Open Run 006').click(); await selected(p,'006');
      await p.waitForTimeout(850); await selected(p,'006');
      assert.equal(await detail(p).locator('h2').innerText(),'Run 006');
    }
    await p.getByLabel('Run history example').selectOption('normal');
    // Local acknowledgement is single-flight; it selects the returned receipt.
    await btn(p,'Run workflow').evaluate(e => { e.click(); e.click(); e.click(); });
    await selected(p,'013');
    assert.equal(await btn(p,'Open Run 014').count(),0);
    assert.ok((await p.locator('.brief-runs-feedback').innerText()).includes('Run requested.'));
    await btn(p,'Open conversation').click(); await settled(p);
    await btn(p,'Collapse sidebar').click(); await settled(p); await selected(p,'013');
    await btn(p,'Close conversation').click(); await settled(p);
    await btn(p,'Expand sidebar').click(); await settled(p);
    // Navigate to the actual D18 editor and back, keeping header coordinates/ID.
    const h = await p.locator('.brief-canvas-heading').boundingBox();
    await btn(p,'Canvas').click(); await p.locator('.react-flow__node[data-id="draft"]').waitFor(); await settled(p);
    const ch = await p.locator('.brief-canvas-heading').boundingBox();
    assert.ok(Math.abs(h.y-ch.y)<1 && Math.abs(h.height-ch.height)<1, 'workflow header shifted');
    await p.locator('.react-flow__node[data-id="draft"]').focus(); await p.keyboard.press('Enter');
    await p.getByRole('complementary',{name:'Step settings'}).waitFor();
    await btn(p,'Close settings').click();
    await btn(p,'Runs').click(); await selected(p,'013'); await settled(p);
    await btn(p,'Context & rules').click(); await p.getByText(/remains with D-20/).waitFor(); await settled(p);
    await btn(p,'Runs').click(); await selected(p,'013'); await settled(p);
    await shot(p,'accepted-run');
    // No run replay on uncertain acknowledgement, refresh or room return.
    await p.getByLabel('Run history example').selectOption('uncertain-command');
    await btn(p,'Run workflow').click();
    await p.getByText('Run request could not be confirmed. Check history before starting another run.',{exact:true}).waitFor();
    assert.ok(await btn(p,'Run workflow').isDisabled());
    await btn(p,'Refresh run history').click(); await settled(p);
    await btn(p,'Canvas').click(); await settled(p); await btn(p,'Runs').click(); await settled(p);
    assert.ok(await btn(p,'Run workflow').isDisabled()); await selected(p,'013');
    await shot(p,'uncertain-command');
    // Dense viewport, reduced motion and keyboard selection.
    await p.emulateMedia({reducedMotion:'reduce'}); await p.setViewportSize({width:390,height:844}); await settled(p);
    await btn(p,'Open Run 008').focus(); await p.keyboard.press('Enter'); await selected(p,'008');
    assert.ok(await p.locator('.brief-workspace-content').evaluate(e => e.scrollWidth<=e.clientWidth+1));
    await shot(p,'narrow-reduced-motion');
    await btn(p,'Open conversation').click(); await settled(p);
    await btn(p,'Close conversation').click(); await settled(p); await selected(p,'008');
    await p.setViewportSize({width:1440,height:1100});
    await p.getByLabel('Run history example').selectOption('unavailable'); await settled(p);
    assert.ok((await detail(p).innerText()).includes('could not be loaded'));
    await p.getByLabel('Run history example').selectOption('empty'); await settled(p);
    assert.ok((await p.locator('.brief-runs-list').innerText()).includes('No runs yet.'));
    assert.deepEqual(errors,[]); assert.deepEqual(mutations,[]);
    fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify({layouts,statuses,rapidSelectionCycles:10,olderVersion:true,redaction:true,partialEffects:true,waitpoints:true,manualReceipt:true,uncertainLock:true,sharedHeader:true,narrow:true,reducedMotion:true,errors,mutations},null,2)+'\n');
    console.log('PASS: 8 shell/theme/chat layouts; 7 statuses; 10 reversed-detail response cycles; manual receipt, uncertain lock, actual Canvas/header return, historical identity, redacted inspection, partial effects/waitpoints, keyboard and 390px reduced motion.');
  } catch (e) {
    if (p && !p.isClosed()) { await shot(p,'failure'); fs.writeFileSync(path.join(__dirname,'failure.txt'),String(e)+'\n'+await p.locator('body').innerText()); }
    throw e;
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exit(1);});
