import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { inspect, layoutProblems, workflowSelectionProblems } from "../../../../scripts/brief-craft/browser.mjs";

beforeAll(() => {
  GlobalRegistrator.register();
  Object.defineProperties(globalThis, {
    innerWidth: { configurable: true, value: 390 },
    innerHeight: { configurable: true, value: 1100 },
    devicePixelRatio: { configurable: true, value: 1 },
  });
});
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

// Run the real read-only observation against DOM fixtures. Happy DOM has no
// layout engine: supply explicit rectangles to model visible and clipped cases.
const tab = { playwright: { evaluate: async (fn: Function, args: unknown) => fn(args) } };
const room = { selector: ".brief-workflow-canvas" };
const compact = { room: "workflow", theme: "light", sidebar: "expanded", chat: true, width: 390 };
function bounds(selector: string, x: number, y: number, width: number, height: number) {
  const rect = { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
  for (const element of document.querySelectorAll(selector)) Object.defineProperties(element, {
    getBoundingClientRect: { configurable: true, value: () => rect },
    getClientRects: { configurable: true, value: () => [rect] },
  });
}
function fixture() {
  document.body.innerHTML = `<div class="brief-root" data-brief-theme="light">
    <div class="brief-navigation" data-requested-sidebar="expanded" data-rail="true" data-chat-open="true">
      <div data-pebble-layout="single" data-pebble-open="true" data-pebble-available="true">
        <div class="brief-pebble-work" aria-hidden="true" inert><main class="brief-workspace-content" data-brief-room="workflow">
          <section class="brief-workflow-canvas"><button role="tab" aria-selected="true">Canvas</button>
            <div class="react-flow__node" data-id="notes"><div class="wf-node wf-node--selected">Read notes</div></div>
            <div class="react-flow__node" data-id="draft"><div class="wf-node">Draft follow-up</div></div>
          </section>
        </main></div>
        <section class="brief-pebble-surface" aria-label="Conversation"><div class="brief-pebble-reading">
          <button aria-label="Close conversation">Close</button>
          <div class="brief-pebble-content"><textarea aria-label="Message"></textarea></div>
        </div></section>
      </div>
    </div></div><aside data-brief-craft data-active-animations="0"></aside>`;
  bounds("*", 80, 110, 300, 850);
  bounds("[data-pebble-layout]", 70, 100, 320, 900);
  bounds(".brief-pebble-content", 90, 160, 280, 750);
  bounds("[aria-label='Close conversation']", 320, 120, 44, 44);
  bounds("textarea", 100, 800, 260, 70);
}

test("a real visible conversation permits hidden work in the single-panel fallback", async () => {
  fixture();
  const metrics = await inspect(tab, room);
  expect(metrics.roomVisible).toBe(false);
  expect(metrics.conversation.surface.visible).toBe(true);
  expect(layoutProblems(compact, metrics)).toEqual([]);
  expect(layoutProblems({ ...compact, chat: false }, { ...metrics, chat: "false", roomVisible: true })).toContain("Wrong rendered conversation state.");
});

test("requested chat-open cannot pass with both surfaces hidden or conversation unavailable", async () => {
  fixture();
  const pebble = document.querySelector("[data-pebble-layout]")!;
  pebble.setAttribute("data-pebble-open", "false");
  pebble.setAttribute("data-pebble-available", "false");
  document.querySelector(".brief-pebble-surface")!.setAttribute("aria-hidden", "true");
  const metrics = await inspect(tab, room);
  expect(metrics.chat).toBe("true");
  expect(metrics.roomVisible).toBe(false);
  expect(layoutProblems(compact, metrics)).toContain("Wrong rendered conversation state.");
  expect(layoutProblems(compact, metrics).some(error => error.startsWith("Conversation surface"))).toBe(true);
});

test("open conversation rejects missing, transparent, zero-sized and offscreen panels", async () => {
  for (const broken of ["missing", "transparent", "zero", "offscreen"] as const) {
    fixture();
    const surface = document.querySelector<HTMLElement>(".brief-pebble-surface")!;
    if (broken === "missing") surface.remove();
    if (broken === "transparent") surface.style.opacity = "0";
    if (broken === "zero") bounds(".brief-pebble-surface", 80, 110, 0, 0);
    if (broken === "offscreen") bounds(".brief-pebble-surface", 400, 110, 300, 850);
    expect(layoutProblems(compact, await inspect(tab, room)).some(error => error.startsWith("Conversation surface"))).toBe(true);
  }
});

test("a collapsed clipping surface and a clipped or missing composer cannot pass", async () => {
  fixture();
  bounds(".brief-pebble-surface", 322, 902, 58, 58);
  expect(layoutProblems(compact, await inspect(tab, room))).toContain("Conversation reading is missing, hidden, collapsed or clipped.");
  fixture();
  bounds("textarea", 100, 950, 260, 70);
  expect(layoutProblems(compact, await inspect(tab, room))).toContain("Conversation composer is missing, hidden, collapsed or clipped.");
  fixture();
  document.querySelector("textarea")!.remove();
  expect(layoutProblems(compact, await inspect(tab, room))).toContain("Conversation composer is missing, hidden, collapsed or clipped.");
});

test("visible SVG edges with a zero-width box remain valid named controls", async () => {
  fixture();
  document.querySelector(".brief-pebble-content")!.insertAdjacentHTML("beforeend", '<svg><g role="button" aria-label="Edge from notes to draft"><path d="M0 0 V60" stroke="black" /></g></svg>');
  bounds("svg, g, path", 100, 200, 0, 60);
  const metrics = await inspect(tab, room);
  expect(metrics.controls).toBe(3);
  expect(metrics.unnamed).toEqual([]);
  expect(layoutProblems(compact, metrics)).toEqual([]);
});

test("workflow observation detects a changed or lost node even while the Canvas tab stays selected", async () => {
  fixture();
  const before = await inspect(tab, room);
  expect(before.workflowNodeIds).toEqual(["notes"]);
  expect(workflowSelectionProblems("notes", before)).toEqual([]);
  document.querySelector(".wf-node--selected")!.classList.remove("wf-node--selected");
  document.querySelector('[data-id="draft"] .wf-node')!.classList.add("wf-node--selected");
  const changed = await inspect(tab, room);
  expect(changed.selected).toEqual(before.selected);
  expect(workflowSelectionProblems("notes", changed)).toEqual(["Selected workflow node was lost or changed."]);
  document.querySelector(".wf-node--selected")!.classList.remove("wf-node--selected");
  expect(workflowSelectionProblems("notes", await inspect(tab, room))).toEqual(["Selected workflow node was lost or changed."]);
  expect(workflowSelectionProblems(null, await inspect(tab, room))).toEqual(["Selected workflow node was lost or changed."]);
});
