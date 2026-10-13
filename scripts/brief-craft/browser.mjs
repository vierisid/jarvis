import { ROOMS, fixtureBlock } from "./matrix.mjs";

// Uses only documented CUA locators, read-only DOM and native keyboard input. The caller supplies its
// already selected tab, viewport capability and artifact writer. No CDP server,
// browser launch, page injection, network request or hidden application access.
export async function inspect(tab, room) {
  return tab.playwright.evaluate(({ selector }) => {
    const main = document.querySelector(".brief-workspace-content");
    const navigation = document.querySelector(".brief-navigation");
    const root = document.querySelector(".brief-root");
    const roomElement = main?.querySelector(selector);
    const visible = element => {
      if (!element || element.closest('[inert], [aria-hidden="true"]')) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      // SVG edges can be visible/focusable with a zero-width bounding box.
      // Positive two-dimensional geometry is required for panels below.
      return element.getClientRects().length > 0;
    };
    const bounds = element => {
      const rect = element?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    };
    const measure = element => {
      // Conversation surfaces must actually paint. General keyboard controls
      // may use a transparent native input over a visible, labelled custom UI.
      let painted = visible(element);
      for (let node = element; node && painted; node = node.parentElement) {
        if (getComputedStyle(node).opacity === "0") painted = false;
      }
      return { visible: painted, bounds: bounds(element) };
    };
    const pebble = navigation?.querySelector("[data-pebble-layout]");
    const surface = pebble?.querySelector(".brief-pebble-surface");
    const composers = surface?.querySelectorAll(".brief-pebble-content textarea") ?? [];
    const name = element => {
      const ids = element.getAttribute("aria-labelledby");
      if (ids) return ids.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      return (element.getAttribute("aria-label") || [...(element.labels ?? [])].map(label => label.textContent).join(" ") || element.textContent || element.getAttribute("title") || "").trim();
    };
    const controls = [...(navigation?.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]') ?? [])].filter(visible);
    const unnamed = controls.filter(element => !name(element)).map(element => ({ tag: element.tagName, class: element.className }));
    const selected = [...(main?.querySelectorAll('[aria-selected="true"], [aria-pressed="true"], [aria-current], [data-fact-id], [data-run-id]') ?? [])].map(element => ({ tag: element.tagName, name: name(element), factId: element.getAttribute("data-fact-id"), runId: element.getAttribute("data-run-id") }));
    const workflowNodeIds = [...(roomElement?.querySelectorAll(".react-flow__node[data-id] .wf-node--selected") ?? [])]
      .map(element => element.closest(".react-flow__node").getAttribute("data-id")).sort();
    const active = document.activeElement;
    return {
      room: main?.getAttribute("data-brief-room"), bodyPresent: !!roomElement,
      theme: root?.getAttribute("data-brief-theme"), sidebar: navigation?.getAttribute("data-requested-sidebar"), rail: navigation?.getAttribute("data-rail"), chat: navigation?.getAttribute("data-chat-open"),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : null,
      roomBounds: bounds(roomElement),
      roomVisible: !!roomElement && visible(roomElement),
      pebbleLayout: pebble?.getAttribute("data-pebble-layout"),
      conversation: {
        open: pebble?.getAttribute("data-pebble-open") === "true",
        available: pebble?.getAttribute("data-pebble-available") === "true",
        hostBounds: bounds(pebble), surface: measure(surface),
        reading: measure(surface?.querySelector(".brief-pebble-reading")),
        content: measure(surface?.querySelector(".brief-pebble-content")),
        close: measure(surface?.querySelector('[aria-label="Close conversation"]')),
        composer: measure(composers.length === 1 ? composers[0] : null),
      },
      busy: [...(main?.querySelectorAll('[aria-busy="true"]') ?? [])].some(visible)
        || [...(main?.querySelectorAll('h1,h2,[role="status"]') ?? [])].some(element => visible(element) && /^Loading\b/.test(element.textContent?.trim() ?? "")),
      activeAnimations: Number(document.querySelector("[data-brief-craft]")?.getAttribute("data-active-animations") ?? -1),
      controls: controls.length, unnamed, selected, workflowNodeIds,
      focus: active ? { tag: active.tagName, name: name(active), visible: visible(active), inRoom: !!main?.contains(active) } : null,
      headings: [...(main?.querySelectorAll("h1,h2") ?? [])].filter(visible).map(element => element.textContent?.trim()),
      statuses: [...(main?.querySelectorAll('[role="status"], [role="alert"]') ?? [])].filter(visible).map(element => element.textContent?.trim()),
    };
  }, { selector: room.selector });
}

function containsBounds(outer, inner) {
  const valid = rect => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
  // Allow border/subpixel rounding, never an offscreen or collapsed surface.
  return valid(outer) && valid(inner) && inner.x >= outer.x - 2 && inner.y >= outer.y - 2
    && inner.x + inner.width <= outer.x + outer.width + 2 && inner.y + inner.height <= outer.y + outer.height + 2;
}

export function layoutProblems(test, metrics) {
  const errors = [];
  if (!metrics.bodyPresent || metrics.room !== test.room) errors.push("Expected actual room body/route, not a destination placeholder.");
  if (metrics.theme !== test.theme) errors.push("Wrong theme.");
  if (metrics.sidebar !== test.sidebar) errors.push("Wrong requested sidebar.");
  if (metrics.rail !== String(test.width < 700 || test.sidebar === "rail")) errors.push("Wrong effective sidebar.");
  if (metrics.chat !== String(test.chat)) errors.push("Wrong conversation state.");
  const conversation = metrics.conversation;
  if (!conversation || conversation.open !== test.chat) errors.push("Wrong rendered conversation state.");
  if (test.chat) {
    const viewport = { x: 0, y: 0, width: metrics.viewport.width, height: metrics.viewport.height };
    if (!conversation?.available || !conversation.surface?.visible
      || !containsBounds(viewport, conversation.surface?.bounds)
      || !containsBounds(conversation.hostBounds, conversation.surface?.bounds)) errors.push("Conversation surface is missing, hidden, collapsed or outside the viewport/workspace.");
    for (const part of ["reading", "content", "close", "composer"]) {
      if (!conversation?.[part]?.visible || !containsBounds(conversation.surface?.bounds, conversation[part].bounds)) errors.push(`Conversation ${part} is missing, hidden, collapsed or clipped.`);
    }
  }
  if (metrics.viewport.width !== test.width) errors.push("Viewport was not applied.");
  if (metrics.busy || metrics.activeAnimations) errors.push("Room did not settle.");
  if (metrics.pageOverflow > 2 || metrics.mainOverflow > 2) errors.push("Horizontal clipping/overflow.");
  if (metrics.unnamed.length) errors.push("Interactive controls missing an accessible name.");
  if (!metrics.roomVisible && !(test.chat && metrics.pebbleLayout === "single")) errors.push("Room unexpectedly hidden.");
  return errors;
}

export function workflowSelectionProblems(expectedId, metrics) {
  return expectedId && metrics.workflowNodeIds?.length === 1 && metrics.workflowNodeIds[0] === expectedId
    ? [] : ["Selected workflow node was lost or changed."];
}

async function selectWorkflowNode(tab, room) {
  // Select a non-trigger step through the same keyboard path as a user. Closing
  // its settings retains the selection, so chat is exercised with a real ID.
  const nodes = tab.playwright.locator(`${room.selector} .react-flow__node[data-id]`);
  if (await nodes.count() < 2) throw Error("Expected a selectable workflow step beyond the trigger.");
  const node = nodes.nth(1);
  const id = await node.getAttribute("data-id");
  if (!id) throw Error("Workflow step has no stable ID.");
  await node.press("Enter");
  await tab.playwright.getByRole("button", { name: "Close settings", exact: true }).click();
  return id;
}

async function settle(tab, room) {
  // Each snapshot waits for the browser observation cycle. Never pass a loading
  // skeleton merely because its outer section exists.
  for (let attempt = 0; attempt < 12; attempt++) {
    await tab.playwright.locator('[data-brief-craft][data-active-animations="0"]').waitFor({ state: "attached", timeoutMs: 5000 });
    const snapshot = await tab.playwright.domSnapshot();
    const metrics = await inspect(tab, room);
    if (!metrics.busy && !metrics.activeAnimations) return { snapshot, metrics };
    // Wait on observable UI state rather than racing a fixed number of reads
    // against delayed fixture responses. Hidden preserved streams do not block.
    const main = tab.playwright.locator(".brief-workspace-content");
    const pending = [
      main.locator('[aria-busy="true"]').filter({ visible: true }),
      main.getByRole("heading", { name: /^Loading\b/ }),
      main.getByRole("status").filter({ hasText: /^Loading\b/ }),
    ];
    for (const locator of pending) if (await locator.count()) await locator.first().waitFor({ state: "hidden", timeoutMs: 5000 });
  }
  throw Error("Fixture or animation did not settle after 12 observations.");
}

async function prepare(tab, baseUrl, room, test) {
  const url = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("Fixture runner requires a loopback static preview.");
  url.search = new URLSearchParams({ brief: "preview", specimen: room.specimen, craft: "1" }).toString();
  url.hash = "/_brief_preview";
  if (await tab.url() === url.href) await tab.reload();
  else await tab.goto(url.href);
  await tab.playwright.locator(".brief-navigation").waitFor({ state: "visible" });
  for (const step of room.states[test.state]) {
    const control = tab.playwright.getByLabel(step.label, { exact: true });
    if (step.kind === "check") await control.setChecked(true);
    else await control.selectOption(step.value);
  }
  if (room.enter) {
    const control = room.enter.selector ? tab.playwright.locator(room.enter.selector).first() : tab.playwright.getByRole(room.enter.role, { name: new RegExp(`^${room.enter.name}`) });
    await control.click();
  }
  await settle(tab, room);
}

async function shell(tab, test) {
  const root = tab.playwright.locator(".brief-root.brief-today-specimen");
  if (await root.getAttribute("data-brief-theme") !== test.theme) await tab.playwright.getByRole("button", { name: `Switch to ${test.theme}`, exact: true }).click();
  const nav = tab.playwright.locator(".brief-navigation");
  if (test.width >= 700 && await nav.getAttribute("data-requested-sidebar") !== test.sidebar) await tab.playwright.getByRole("button", { name: test.sidebar === "rail" ? "Collapse sidebar" : "Expand sidebar", exact: true }).click();
  if (await nav.getAttribute("data-chat-open") !== String(test.chat)) await tab.playwright.getByRole("button", { name: test.chat ? "Open conversation" : "Close conversation", exact: true }).click();
}

/** Run a bounded slice so an operator can inspect failures before continuing.
 * save(path, data) must write under the run's evidence directory. */
export async function runCases({ tab, viewport, baseUrl, cases, save, onResult = (_row) => {} }) {
  const results = [];
  let prepared = "";
  for (const test of cases) {
    const blocked = fixtureBlock(test);
    if (blocked) {
      const result = { id: test.id, status: "blocked", reason: blocked, evidence: [] };
      await save(`${test.id.replaceAll("/", "--")}.result.json`, JSON.stringify(result));
      results.push(result); await onResult(result); continue;
    }
    const room = ROOMS.find(room => room.id === test.room);
    const file = test.id.replaceAll("/", "--");
    let result;
    try {
      await viewport.set({ width: test.width, height: 1100 });
      const key = `${test.room}/${test.state}/${test.kind}`;
      if (prepared !== key) { await prepare(tab, baseUrl, room, test); prepared = key; }
      let closedObservation;
      if (test.kind === "viewport") {
        await shell(tab, { ...test, chat: false });
        closedObservation = await settle(tab, room);
        await save(`${file}.work.png`, await tab.screenshot({ fullPage: false }));
      }
      await shell(tab, test);
      let observation = await settle(tab, room);
      const evidence = [`${file}.json`, `${file}.ax.txt`];
      const problems = layoutProblems(test, observation.metrics);
      if (closedObservation) {
        problems.push(...layoutProblems({ ...test, chat: false }, closedObservation.metrics));
        await save(`${file}.work.json`, JSON.stringify(closedObservation.metrics, null, 2));
        evidence.push(`${file}.work.json`, `${file}.work.png`);
      }
      if (test.kind === "keyboard") {
        const focusOrder = [];
        await tab.playwright.getByRole("link", { name: "Skip to content", exact: true }).press("Enter");
        let focus = (await inspect(tab, room)).focus;
        if (focus?.tag !== "MAIN") problems.push("Skip link did not focus the main room.");
        for (let index = 0; index < 12; index++) {
          // Preserve focus and send a real key, including from aria-disabled
          // actions: locator.press's enabled check would misreport a trap there.
          await tab.pressKey(null, "Tab");
          focus = (await inspect(tab, room)).focus;
          focusOrder.push(focus);
          if (!focus?.visible || (!focus.name && focus.tag !== "BODY")) problems.push(`Unusable keyboard focus at step ${index + 1}.`);
        }
        if (new Set(focusOrder.map(focus => `${focus?.tag}/${focus?.name}`)).size < 3) problems.push("Tab traversal did not progress through the room.");
        // Verify Escape closes the account menu and restores its trigger.
        const account = tab.playwright.getByRole("button", { name: /Account menu$/ });
        await account.press("Enter");
        await tab.playwright.getByRole("menu").waitFor({ state: "visible" });
        await tab.pressKey(null, "Escape");
        await tab.playwright.getByRole("menu").waitFor({ state: "hidden" });
        if (!(await inspect(tab, room)).focus?.name.endsWith("Account menu")) problems.push("Account menu did not restore focus.");
        await save(`${file}.focus.json`, JSON.stringify({ focusOrder, scope: "Skip link, 12 forward Tab stops, account menu keyboard open/Escape/return. Full screen-reader journey is a separate required case." }, null, 2));
        evidence.push(`${file}.focus.json`);
      }
      if (test.kind === "repeat-20") {
        const workflowNodeId = room.id === "workflow" ? await selectWorkflowNode(tab, room) : null;
        observation = await settle(tab, room);
        if (room.id === "workflow" && workflowSelectionProblems(workflowNodeId, observation.metrics).length) throw Error("Workflow selection setup did not select the expected node.");
        const before = observation.metrics.selected;
        const cycles = [];
        const draft = "Keep this thought across twenty conversation cycles.";
        for (let cycle = 0; cycle < 20; cycle++) {
          await tab.playwright.getByRole("button", { name: "Open conversation", exact: true }).click();
          const open = await settle(tab, room);
          const composer = tab.playwright.locator(".brief-pebble-content textarea");
          if (await composer.count() !== 1) throw Error("Expected one persistent conversation composer.");
          if (cycle === 0) await composer.fill(draft);
          const retained = await composer.evaluate(element => element.value);
          await tab.playwright.getByRole("button", { name: "Close conversation", exact: true }).click();
          const closed = await settle(tab, room);
          const cycleProblems = [...layoutProblems({ ...test, chat: true }, open.metrics), ...layoutProblems(test, closed.metrics)];
          if (room.id === "workflow") cycleProblems.push(...workflowSelectionProblems(workflowNodeId, open.metrics), ...workflowSelectionProblems(workflowNodeId, closed.metrics));
          if (JSON.stringify(before) !== JSON.stringify(closed.metrics.selected)) cycleProblems.push("Selection changed during conversation toggle.");
          if (retained !== draft) cycleProblems.push("Conversation draft was lost.");
          if (closed.metrics.focus?.name !== "Open conversation") cycleProblems.push("Conversation close lost return focus.");
          cycles.push({ cycle: cycle + 1, ...(workflowNodeId ? { workflowNodeId, openNodeIds: open.metrics.workflowNodeIds, closedNodeIds: closed.metrics.workflowNodeIds } : {}), problems: cycleProblems });
          problems.push(...cycleProblems.map(problem => `Cycle ${cycle + 1}: ${problem}`));
        }
        observation = await settle(tab, room);
        await tab.playwright.getByRole("button", { name: "Capture craft trace", exact: true }).click();
        const trace = JSON.parse(await tab.playwright.locator("[data-brief-craft-trace]").textContent());
        if (trace.backgrounded || trace.truncated || trace.activeAnimations || !trace.frames.length || trace.inputs.length < 40) problems.push("Performance trace is incomplete or not at rest.");
        await save(`${file}.trace.json`, JSON.stringify({ ...trace, selectionBefore: before, selectionAfter: observation.metrics.selected, workflowNodeId, cycles }, null, 2));
        evidence.push(`${file}.trace.json`);
      }
      await save(`${file}.json`, JSON.stringify({ test, ...observation.metrics, problems }, null, 2));
      await save(`${file}.ax.txt`, observation.snapshot);
      if ((test.kind === "layout" && test.state === "ready" && test.sidebar === "expanded" && !test.chat) || test.kind === "viewport") {
        await save(`${file}.png`, await tab.screenshot({ fullPage: false }));
        evidence.push(`${file}.png`);
      }
      result = { id: test.id, status: problems.length ? "failed" : "passed", ...(problems.length ? { reason: [...new Set(problems)].join(" ") } : {}), evidence };
    } catch (error) {
      // An unavailable browser/server or stale locator needs operator inspection.
      // Do not turn one infrastructure failure into hundreds of bogus UI results.
      const reason = String(error).slice(0, 2000);
      await save(`${file}.error.txt`, reason);
      result = { id: test.id, status: "failed", reason, evidence: [`${file}.error.txt`] };
      await save(`${file}.result.json`, JSON.stringify(result));
      results.push(result); await onResult(result);
      break;
    }
    await save(`${file}.result.json`, JSON.stringify(result));
    results.push(result); await onResult(result);
  }
  return results;
}
