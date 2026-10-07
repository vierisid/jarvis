const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const url = process.env.BRIEF_PREVIEW_URL || "http://127.0.0.1:4402/?brief=preview&specimen=opportunities#/_brief_preview";
const button = (p, name) => p.getByRole("button", { name, exact: true });
const wait = p => p.waitForTimeout(450);
const shot = (p, name) => p.screenshot({ path: path.join(__dirname, name + ".png") });
const selected = p => p.locator(".brief-finished").getAttribute("data-proposal");
const bounds = async p => { for (const selector of [".brief-workspace-content", ".brief-opportunities", ".brief-opportunities-scroll"]) { const g = await p.locator(selector).evaluate(e => ({ w: e.clientWidth, s: e.scrollWidth })); assert.ok(g.s <= g.w + 1, selector + " overflows: " + JSON.stringify(g)); } };
const choose = async (p, name) => { await p.getByLabel("Opportunity example").selectOption(name); await wait(p); };
const inside = async (p, child, parent) => {
  const c = await p.locator(child).boundingBox(), r = await p.locator(parent).boundingBox();
  assert.ok(c && r && c.y >= r.y - 1 && c.y + c.height <= r.y + r.height + 1 && c.x >= r.x - 1 && c.x + c.width <= r.x + r.width + 1, `${child} outside ${parent}: ${JSON.stringify({c,r})}`);
};
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const errors = [], mutations = [], layouts = []; let p;
  const watch = p => { p.on("pageerror", e => errors.push(e.message)); p.on("request", r => { if (r.method() !== "GET") mutations.push(r.url()); }); };
  try {
    for (const theme of ["light", "dark"]) for (const rail of [false, true]) for (const chat of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); p = await context.newPage(); watch(p);
      await p.goto(url); await button(p, "Competitor watch").waitFor(); await p.evaluate(() => document.fonts.ready);
      if (theme === "dark") await button(p, "Switch to dark").click();
      if (rail) await button(p, "Collapse sidebar").click();
      if (chat) await button(p, "Open conversation").click();
      await wait(p); await bounds(p); await shot(p, `${theme}-${rail ? "rail" : "expanded"}-${chat ? "chat" : "closed"}`);
      const header = await p.locator(".brief-finished-header").boundingBox();
      await button(p, "Weekly investor update").click(); assert.equal(await selected(p), "fixture-proposal-1");
      assert.deepEqual(await p.locator(".brief-finished-header").boundingBox(), header);
      await button(p, "Reorder proposals").click(); await wait(p); assert.equal(await selected(p), "fixture-proposal-1");
      await button(p, "Approve & enable").scrollIntoViewIfNeeded(); const press = await button(p, "Approve & enable").boundingBox();
      await button(p, "Approve & enable").click(); await p.waitForTimeout(260); assert.equal(await selected(p), "fixture-proposal-1");
      assert.ok((await p.locator(".brief-finished-feedback").innerText()).includes("Workflow enabled"));
      assert.deepEqual(await button(p, "Approve & enable").boundingBox(), press, "local acknowledgement holds the action target");
      await p.waitForTimeout(850); assert.equal(await selected(p), "fixture-proposal-0");
      assert.equal(await button(p, "Competitor watch").evaluate(e => e === document.activeElement), true);
      await button(p, "Dismiss").click(); await p.waitForTimeout(230); assert.ok((await p.locator(".brief-finished-feedback").innerText()).includes("No workflow enabled"));
      await p.waitForTimeout(850); assert.equal(await p.locator(".brief-finished").count(), 0); assert.ok((await p.locator(".brief-opportunities").innerText()).includes("No proposals to review"));
      // R2: navigate the complete ten-item collection without scrolling the brief away.
      await choose(p, "many proposals");
      const before = await p.locator(".brief-finished-header").boundingBox();
      await button(p, "Prepared opportunity 10").click();
      assert.equal(await selected(p), "fixture-proposal-9");
      assert.deepEqual(await p.locator(".brief-finished-header").boundingBox(), before);
      await inside(p, ".brief-finished-header", ".brief-opportunities-scroll");
      await inside(p, '.brief-proposal-choice[aria-pressed="true"]', ".brief-opportunity-list");
      await button(p, "Approve & enable").scrollIntoViewIfNeeded();
      await inside(p, ".brief-finished-actions", ".brief-finished");
      await button(p, "Competitor watch").click();
      assert.equal(await selected(p), "fixture-proposal-0");
      await inside(p, ".brief-finished-header", ".brief-opportunities-scroll");
      await button(p, "Prepared opportunity 10").click();
      await button(p, chat ? "Close conversation" : "Open conversation").click(); await wait(p);
      assert.equal(await selected(p), "fixture-proposal-9");
      await inside(p, '.brief-proposal-choice[aria-pressed="true"]', ".brief-opportunity-list");
      await inside(p, ".brief-finished-header", ".brief-opportunities-scroll");
      await bounds(p);
      await shot(p, `many-${theme}-${rail ? "rail" : "expanded"}-${chat ? "closed" : "chat"}`);
      layouts.push({ theme, rail, chat, selection: true, stableHeader: true, ackTarget: true, approveThenDismiss: true }); await context.close();
    }
    p = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); watch(p); await p.goto(url); await button(p, "Competitor watch").waitFor();
    await button(p, "Weekly investor update").click();
    for (let i = 0; i < 10; i++) {
      await button(p, "Competitor watch").hover(); await p.mouse.move(600, 170);
      await button(p, "Open conversation").click(); await p.waitForTimeout(70); await button(p, "Close conversation").click(); await wait(p);
      assert.equal(await selected(p), "fixture-proposal-1"); assert.equal(await button(p, "Weekly investor update").getAttribute("aria-pressed"), "true");
    }
    // Sample the local exit, not only endpoints, with unchanged shell geometry.
    await button(p, "Reset example").click(); await wait(p);
    const samples = await p.evaluate(async () => {
      const e = document.querySelector(".brief-finished-content"), title = document.querySelector(".brief-opportunities-heading");
      document.querySelector(".brief-finished-actions button").click(); const t = performance.now(), result = [];
      while (performance.now() - t < 1200) { await new Promise(requestAnimationFrame); result.push({ opacity: Number(getComputedStyle(e).opacity), y: title.getBoundingClientRect().y }); } return result;
    });
    assert.ok(samples.some(s => s.opacity > 0.02 && s.opacity < 0.98), "intermediate local motion is rendered");
    assert.ok(samples.every(s => s.y === samples[0].y), "room heading stays anchored");
    for (const example of ["preparing", "blocked", "stale", "missing preview", "registration pending", "registration blocked", "lost response", "refused"]) {
      await choose(p, example);
      if (["preparing", "blocked", "stale"].includes(example)) { assert.equal(await button(p, "Approve & enable").isDisabled(), true); assert.ok(!(await p.locator(".brief-finished-status").innerText()).includes("Ready to enable")); }
      if (example === "missing preview") assert.ok((await p.locator(".brief-finished-paper").innerText()).includes("not available"));
      if (["registration pending", "registration blocked", "lost response", "refused"].includes(example)) {
        await button(p, "Approve & enable").click(); await wait(p); assert.equal(await selected(p), "fixture-proposal-0");
        if (example === "lost response") { await shot(p, "uncertain-result"); await button(p, "Check result").click(); await p.waitForTimeout(1200); assert.equal(await selected(p), "fixture-proposal-1"); }
        else if (example === "refused") { assert.ok((await p.locator(".brief-finished-status").innerText()).includes("Decision not saved")); await button(p, "Refresh opportunities").click(); await wait(p); assert.equal(await button(p, "Approve & enable").isDisabled(), false); }
        else { assert.ok((await p.locator(".brief-finished-status").innerText()).includes("Approval saved")); await button(p, "Refresh opportunities").click(); await wait(p); assert.equal(await selected(p), "fixture-proposal-0"); await shot(p, example.replaceAll(" ", "-")); }
      }
      await bounds(p);
    }
    for (const example of ["empty", "loading", "unavailable", "unsupported"]) { await choose(p, example); assert.equal(await p.locator(".brief-finished").count(), 0); await bounds(p); }
    await choose(p, "long content"); await button(p, "Open conversation").click(); await button(p, "Switch to dark").click(); await wait(p); await bounds(p); await shot(p, "long-dark-chat");
    await p.locator(".brief-finished").evaluate(e => e.scrollTop = e.scrollHeight); await wait(p); const actionBox = await button(p, "Approve & enable").boundingBox(); assert.ok(actionBox.y > 0 && actionBox.y + actionBox.height <= 1100, "long content actions reachable");
    await button(p, "Close conversation").click(); await wait(p); await choose(p, "ready"); await p.emulateMedia({ reducedMotion: "reduce" }); await p.setViewportSize({ width: 390, height: 844 }); await wait(p); await bounds(p); await shot(p, "narrow-reduced");
    assert.equal(await p.locator(".brief-finished-content").evaluate(e => getComputedStyle(e).transitionDuration), "0s");
    await button(p, "Weekly investor update").focus(); await p.keyboard.press("Enter"); assert.equal(await selected(p), "fixture-proposal-1");
    await button(p, "Approve & enable").focus(); await p.keyboard.press("Enter"); await wait(p); assert.equal(await selected(p), "fixture-proposal-0");
    await choose(p, "many proposals");
    await button(p, "Prepared opportunity 10").focus(); await p.keyboard.press("Enter");
    assert.equal(await selected(p), "fixture-proposal-9");
    await inside(p, ".brief-finished-header", ".brief-opportunities-scroll");
    await inside(p, '.brief-proposal-choice[aria-pressed="true"]', ".brief-opportunity-list");
    await button(p, "Approve & enable").scrollIntoViewIfNeeded();
    await inside(p, ".brief-finished-actions", ".brief-finished");
    await button(p, "Competitor watch").focus(); await p.keyboard.press("Enter");
    await inside(p, ".brief-finished-header", ".brief-opportunities-scroll");
    await bounds(p); await shot(p, "many-narrow-reduced");
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    fs.writeFileSync(path.join(__dirname, "browser-results.json"), JSON.stringify({ layouts, tenProposalsAllLayouts: true, independentSelectorAndBrief: true, selectedChoiceVisibleAfterReflow: true, narrowTenProposalKeyboard: true, rapidPebbleCycles: 10, hoverCycles: 10, interruptedReflowSelection: true, sampledLocalMotion: true, staleAndPreparingBlocked: true, truthfulPendingRegistration: true, readOnlyRecovery: true, explicitRefusal: true, longContent: true, narrow: true, keyboardSelectionAndAction: true, reducedMotion: true, errors, mutations }, null, 2) + "\n");
    console.log("PASS: 8 layouts; stable selection/header/action targets; approve and dismiss; 10 hover/reflow reversals; sampled exit; readiness, uncertainty and refusal; long/narrow/reduced layouts; keyboard. No mutation requests or page errors.");
  } catch (e) { if (p && !p.isClosed()) { await shot(p, "failure"); fs.writeFileSync(path.join(__dirname, "failure.txt"), String(e) + "\n" + await p.locator("body").innerText()); } throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
