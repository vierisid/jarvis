const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"),
  path = require("node:path");
const url =
  process.env.BRIEF_PREVIEW_URL ||
  "http://127.0.0.1:4400/?brief=preview&specimen=workflow-context#/_brief_preview";
const stage = process.env.REVIEW_STAGE || "green";
const checks = [],
  errors = [],
  mutations = [];
const button = (p, name) => p.getByRole("button", { name, exact: true });
const rect = (p, selector) => p.locator(selector).boundingBox();
const overlap = (a, b) =>
  a &&
  b &&
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
function check(id, layout, pass, detail) {
  checks.push({ id, layout, pass, detail });
}
async function settle(p) {
  await p.waitForTimeout(400);
}
async function screenshot(p, name) {
  await p.screenshot({
    path: path.join(__dirname, `review-${stage}-${name}.png`),
  });
}
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const layouts = [];
    for (const theme of ["light", "dark"]) {
      for (const rail of [false, true])
        for (const chat of [false, true])
          layouts.push({ width: 1440, theme, rail, chat });
      for (const width of [390, 490])
        layouts.push({ width, theme, rail: true, chat: false });
    }
    for (const layout of layouts) {
      const name = `${layout.width}-${layout.theme}-${layout.rail ? "rail" : "expanded"}-${layout.chat ? "chat" : "closed"}`;
      const c = await browser.newContext({
        viewport: {
          width: layout.width,
          height: layout.width < 600 ? 1000 : 1100,
        },
        reducedMotion: "reduce",
      });
      const p = await c.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("request", (r) => {
        if (r.method() !== "GET") mutations.push(r.method() + " " + r.url());
      });
      await p.goto(url);
      await p.locator('[data-context-basis="configured"]').waitFor();
      await p.evaluate(() => document.fonts.ready);
      if (layout.theme === "dark") await button(p, "Switch to dark").click();
      if (layout.rail && (await button(p, "Collapse sidebar").count()))
        await button(p, "Collapse sidebar").click();
      if (layout.chat) await button(p, "Open conversation").click();
      await settle(p);
      const before = await rect(p, ".brief-context-toolbar"),
        beforeScroll = await rect(p, ".brief-context-scroll");
      await p.getByRole("radio", { name: "Used by run", exact: true }).check();
      await p.locator('[data-context-basis="recorded"]').waitFor();
      const after = await rect(p, ".brief-context-toolbar"),
        afterScroll = await rect(p, ".brief-context-scroll");
      check(
        "R3",
        name,
        Math.abs(before.height - after.height) < 1 &&
          Math.abs(beforeScroll.y - afterScroll.y) < 1,
        {
          before,
          after,
          beforeScrollY: beforeScroll.y,
          afterScrollY: afterScroll.y,
        },
      );
      if (
        layout.width === 1440 &&
        !layout.chat &&
        !layout.rail &&
        layout.theme === "light"
      )
        await screenshot(p, "recorded");
      const origin = await button(p, "Run workflow").boundingBox();
      await button(p, "Runs").click();
      await p.locator(".brief-workflow-runs").waitFor();
      await settle(p);
      const runs = await button(p, "Run workflow").boundingBox();
      await button(p, "Canvas").click();
      await p.locator(".react-flow__node").first().waitFor();
      await settle(p);
      const canvas = await button(p, "Run workflow").boundingBox();
      check(
        "R2",
        name,
        Math.abs(origin.x - runs.x) < 1 &&
          Math.abs(origin.x - canvas.x) < 1 &&
          Math.abs(origin.width - runs.width) < 1,
        { context: origin, runs, canvas },
      );
      await button(p, "Context & rules").click();
      await p.locator(".brief-workflow-context").waitFor();
      await settle(p);
      const navBefore = await rect(p, ".brief-workflow-view-tabs"),
        toolbarBefore = await rect(p, ".brief-context-toolbar");
      for (const outcome of ["not_submitted", "uncertain"]) {
        await p.getByLabel("Illustrative run response").selectOption(outcome);
        await button(p, "Run workflow").click();
        await button(p, "Requesting…").waitFor();
        const pending = await rect(p, ".brief-context-run-message");
        check(
          "R1-pending",
          name,
          !overlap(pending, navBefore) && !overlap(pending, toolbarBefore),
          { pending },
        );
        const message = p.locator(".brief-context-run-message");
        await message
          .filter({
            hasText:
              outcome === "uncertain"
                ? "could not be confirmed"
                : "not submitted",
          })
          .waitFor();
        const feedback = await message.boundingBox(),
          nav = await rect(p, ".brief-workflow-view-tabs"),
          toolbar = await rect(p, ".brief-context-toolbar");
        const currentScroll = await rect(p, ".brief-context-scroll");
        const tabsUsable = await p
          .locator(".brief-workflow-view-tabs button")
          .evaluateAll((tabs) =>
            tabs.every((tab) => {
              const r = tab.getBoundingClientRect();
              return tab.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                ),
              );
            }),
          );
        check(
          "R1-" + outcome,
          name,
          !overlap(feedback, nav) &&
            !overlap(feedback, toolbar) &&
            !overlap(feedback, currentScroll) &&
            tabsUsable &&
            Math.abs(nav.y - navBefore.y) < 1 &&
            Math.abs(toolbar.y - toolbarBefore.y) < 1,
          { feedback, nav, toolbar, tabsUsable },
        );
        check(
          "command-lock-" + outcome,
          name,
          (await button(p, "Run workflow").isDisabled()) ===
            (outcome === "uncertain"),
        );
        if (
          layout.width === 390 &&
          layout.theme === "light" &&
          outcome === "uncertain"
        )
          await screenshot(p, "uncertain-narrow");
      }
      const overflow = await p
        .locator(".brief-workspace-content")
        .evaluate((e) => e.scrollWidth > e.clientWidth + 1);
      check("containment", name, !overflow);
      // History remains reachable after uncertain acknowledgement and retains its lock on return.
      if (stage === "red") await button(p, "Runs").dispatchEvent("click");
      else await button(p, "Runs").click();
      await p.locator(".brief-workflow-runs").waitFor();
      await button(p, "Context & rules").click();
      await p.locator(".brief-workflow-context").waitFor();
      check(
        "uncertain-return",
        name,
        await button(p, "Run workflow").isDisabled(),
      );
      await c.close();
    }
  } finally {
    await browser.close();
  }
  const failed = checks.filter((c) => !c.pass);
  fs.writeFileSync(
    path.join(__dirname, `review-${stage}-results.json`),
    JSON.stringify({ stage, checks, errors, mutations }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        checks: checks.length,
        failed: failed.map(({ id, layout }) => ({ id, layout })),
        errors,
        mutations,
      },
      null,
      2,
    ),
  );
  if (failed.length || errors.length || mutations.length) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
