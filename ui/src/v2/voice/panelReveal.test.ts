import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentVisibility, effectiveVisibility } from "./panelReveal";
import { shownApprovalId } from "./shownApproval";

/**
 * #886. The Windows sidecar panel is hidden with SW_HIDE while its page first
 * loads, and WebView2 still reports `visible` then. The panel marks the page
 * not yet revealed, and the voice guard must read that as hidden.
 */
describe("effectiveVisibility", () => {
  test("a panel page not yet revealed is hidden, whatever the page reports", () => {
    expect(effectiveVisibility("visible", false)).toBe("hidden");
  });

  test("a revealed panel, or a page with no flag, keeps what the page reports", () => {
    expect(effectiveVisibility("visible", true)).toBe("visible");
    expect(effectiveVisibility("visible", undefined)).toBe("visible");
    expect(effectiveVisibility("hidden", true)).toBe("hidden");
    expect(effectiveVisibility("hidden", undefined)).toBe("hidden");
  });

  test("only an exact false counts as not revealed", () => {
    expect(effectiveVisibility("visible", 0)).toBe("visible");
    expect(effectiveVisibility("visible", null)).toBe("visible");
    expect(effectiveVisibility("visible", "false")).toBe("visible");
  });

  test("a spoken answer during the first load names no approval", () => {
    const approvals = [{ id: "a", timestamp: 1 }];
    expect(shownApprovalId(approvals, effectiveVisibility("visible", false))).toBeNull();
    expect(shownApprovalId(approvals, effectiveVisibility("visible", true))).toBe("a");
  });
});

/**
 * The sidecar's document-start scripts, run as the page would run them. They
 * are read from the Go source so this tests the script the sidecar ships.
 */
const goSource = readFileSync(join(import.meta.dir, "../../../../sidecar/panels_reveal.go"), "utf8");

function goScript(name: string): string {
  const m = goSource.match(new RegExp(`const ${name} = ((?:\`[^\`]*\`(?:\\s*\\+\\s*)?)+)`));
  if (!m) throw new Error(`const ${name} not found in panels_reveal.go`);
  return [...m[1]!.matchAll(/`([^`]*)`/g)].map((p) => p[1]).join("");
}

type FakePage = {
  window: Record<string, unknown>;
  fireLoad: () => void;
  flush: () => Promise<void>;
};

function runInPage(script: string, binding: (() => unknown) | undefined, readyState = "loading"): FakePage {
  const loadHandlers: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const win: Record<string, unknown> = {
    addEventListener: (ev: string, fn: () => void) => { if (ev === "load") loadHandlers.push(fn); },
  };
  if (binding) win.__sidecar_panel_ready = binding;
  const doc = { readyState };
  const setTimeoutFake = (fn: () => void) => { timers.push(fn); };
  new Function("window", "document", "setTimeout", script)(win, doc, setTimeoutFake);
  return {
    window: win,
    fireLoad: () => { for (const h of loadHandlers) h(); },
    flush: async () => {
      while (timers.length) timers.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("panel ready scripts (sidecar/panels_reveal.go)", () => {
  const tracking = goScript("panelReadyTrackingScript");
  const plain = goScript("panelReadyScript");

  test("the tracking script marks the page not revealed before it loads", async () => {
    let calls = 0;
    const page = runInPage(tracking, () => { calls++; return Promise.resolve(true); });
    expect(page.window.__jarvis_panel_revealed).toBe(false);
    await page.flush();
    expect(calls).toBe(0);
    expect(page.window.__jarvis_panel_revealed).toBe(false);
  });

  test("it is revealed only once the host answers that the window is shown", async () => {
    const page = runInPage(tracking, () => Promise.resolve(true));
    page.fireLoad();
    await page.flush();
    expect(page.window.__jarvis_panel_revealed).toBe(true);
  });

  test("a host that did not show the window leaves it not revealed", async () => {
    for (const answer of [false, null, undefined, 1, "true"]) {
      const page = runInPage(tracking, () => Promise.resolve(answer));
      page.fireLoad();
      await page.flush();
      expect(page.window.__jarvis_panel_revealed).toBe(false);
    }
  });

  test("a failed or missing binding leaves it not revealed", async () => {
    const rejected = runInPage(tracking, () => Promise.reject(new Error("gone")));
    rejected.fireLoad();
    await rejected.flush();
    expect(rejected.window.__jarvis_panel_revealed).toBe(false);

    const missing = runInPage(tracking, undefined);
    missing.fireLoad();
    await missing.flush();
    expect(missing.window.__jarvis_panel_revealed).toBe(false);
  });

  test("a page already loaded is revealed after the binding answers", async () => {
    const page = runInPage(tracking, () => Promise.resolve(true), "complete");
    expect(page.window.__jarvis_panel_revealed).toBe(false);
    await page.flush();
    expect(page.window.__jarvis_panel_revealed).toBe(true);
  });

  test("the plain script (macOS, Linux) still calls the binding and sets no flag", async () => {
    let calls = 0;
    const page = runInPage(plain, () => { calls++; });
    page.fireLoad();
    await page.flush();
    expect(calls).toBe(1);
    expect("__jarvis_panel_revealed" in page.window).toBe(false);
  });
});

describe("currentVisibility", () => {
  test("reads the live page and the panel's flag", () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = "window" in g;
    const hadDocument = "document" in g;
    const oldWindow = g.window;
    const oldDocument = g.document;
    try {
      const win: Record<string, unknown> = {};
      g.window = win;
      g.document = { visibilityState: "visible" };
      expect(currentVisibility()).toBe("visible");
      win.__jarvis_panel_revealed = false;
      expect(currentVisibility()).toBe("hidden");
      win.__jarvis_panel_revealed = true;
      expect(currentVisibility()).toBe("visible");
      g.document = { visibilityState: "hidden" };
      expect(currentVisibility()).toBe("hidden");
    } finally {
      if (hadWindow) g.window = oldWindow; else delete g.window;
      if (hadDocument) g.document = oldDocument; else delete g.document;
    }
  });
});
