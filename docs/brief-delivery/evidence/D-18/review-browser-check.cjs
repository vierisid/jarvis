const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const url = process.env.BRIEF_PREVIEW_URL || "http://127.0.0.1:4398/?brief=preview&specimen=workflow-canvas#/_brief_preview";
const wait = p => p.waitForTimeout(450);
const button = (p, name) => p.getByRole("button", { name, exact: true });
const node = (p, id) => p.locator(`.react-flow__node[data-id="${id}"]`);
const panel = p => p.getByRole("complementary", { name: "Step settings" });
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const errors = [], mutations = [], results = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", dialog => dialog.accept()); // Fixture-only save validation.
    page.on("request", r => { if (r.method() !== "GET") mutations.push(r.url()); });
    await page.goto(url);
    await node(page, "draft").waitFor();
    await wait(page);
    for (const [tab, label, value] of [
      ["Input", "Sample input override", '{"x":1}'],
      ["Output", "Sample output + test this step", '{"output":true}'],
    ]) {
      await node(page, "draft").click();
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const section = panel(page).locator(`[aria-label="${label}"]`);
      await section.locator("textarea").fill(value);
      assert.ok(await section.getByText(/Unsaved edits/).isVisible());
      await section.getByRole("button", { name: "Save sample", exact: true }).click();
      await wait(page);
      assert.equal(await section.getByText(/Unsaved edits/).count(), 0);
      await node(page, "notes").click();
      await node(page, "draft").click();
      await page.getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(await section.getByText(/Unsaved edits/).count(), 0, tab + " was marked unsaved after remount");
      assert.deepEqual(JSON.parse(await section.locator("textarea").inputValue()), JSON.parse(value));
      if (tab === "Output") assert.ok(await section.getByRole("button", { name: "Test this step", exact: true }).isEnabled());
      results.push(tab + ": compact sample remains saved after node change");
    }
    await page.screenshot({ path: path.join(__dirname, "review-saved-sample.png") });
    await button(page, "Close settings").click();
    await page.getByLabel("Branches, loops & disconnected nodes").check();
    await page.locator(".react-flow__controls-fitview").click();
    await wait(page);
    async function drag(id, dx, dy) {
      const box = await node(page, id).boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
      await wait(page);
    }
    const transform = id => node(page, id).evaluate(el => el.style.transform);
    await drag("orphan_child", 45, 50);
    const promotedPosition = await transform("orphan_child");
    await node(page, "orphan").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await wait(page);
    assert.equal(await node(page, "orphan").count(), 0);
    assert.equal(await transform("orphan_child"), promotedPosition, "promotion moved the authored position");
    await drag("orphan_child", -40, 35);
    const movedPosition = await transform("orphan_child");
    assert.notEqual(movedPosition, promotedPosition, "promoted root snapped back after drag");
    await button(page, "Save changes").click(); await wait(page);
    assert.ok(await button(page, "Save changes").isDisabled(), "fixture save was not acknowledged");
    assert.equal(await transform("orphan_child"), movedPosition);
    await button(page, "Open conversation").click(); await wait(page);
    await button(page, "Close conversation").click(); await wait(page);
    assert.equal(await transform("orphan_child"), movedPosition);
    results.push("Detached descendant: drag, promote, drag, save and chat reflow preserve new position");
    await page.screenshot({ path: path.join(__dirname, "review-promoted-node.png") });
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    fs.writeFileSync(path.join(__dirname, "review-browser-results.json"), JSON.stringify({ results, errors, mutations }, null, 2) + "\n");
    console.log("PASS " + results.join("; "));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(__dirname, "review-failure.png") });
      fs.writeFileSync(path.join(__dirname, "review-failure.txt"), String(error) + "\n" + await page.locator("body").innerText());
    }
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
