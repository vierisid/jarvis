import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostOpensExternally, openExternal, openedOrHandedOff } from "./external-open.ts";

/**
 * This repo has no DOM test infrastructure (see OnboardingWizard.steps.test.ts),
 * and these two functions exist precisely to read `window`. A two-property stub
 * is enough: they touch `window.open` and one flag, nothing else.
 */
const g = globalThis as { window?: unknown };
type StubWindow = { open?: unknown; __jarvisOpensExternally?: unknown };
const stubWindow = (): StubWindow => {
  const w: StubWindow = {};
  g.window = w;
  return w;
};

/**
 * The decision this module exists to get right: a null from `window.open` means
 * three different things, and only one of them should be reported to the user
 * as a failure. Getting it wrong in either direction is invisible -- either the
 * page tells you it could not open a link while your browser is opening it, or
 * it says nothing at all when nothing opened.
 */
describe("openedOrHandedOff", () => {
  const opened = () => ({}) as Window;
  let w: StubWindow;

  beforeEach(() => {
    w = stubWindow();
  });
  afterEach(() => {
    delete g.window;
  });

  test("a real window is a success, host routing or not", () => {
    expect(openedOrHandedOff(opened())).toBe(true);
    w.__jarvisOpensExternally = true;
    expect(openedOrHandedOff(opened())).toBe(true);
  });

  test("null with the host routing is a hand-off, not a failure", () => {
    // The panel host opened the URL in the system browser and returned no view.
    w.__jarvisOpensExternally = true;
    expect(openedOrHandedOff(null)).toBe(true);
  });

  test("null with no host routing is the one real failure", () => {
    expect(openedOrHandedOff(null)).toBe(false);
  });

  test("only the exact flag counts", () => {
    // Anything truthy-but-not-true is a page setting a global we did not inject.
    w.__jarvisOpensExternally = "yes";
    expect(hostOpensExternally()).toBe(false);
    expect(openedOrHandedOff(null)).toBe(false);
  });

  test("no window at all (server render) is not a hand-off", () => {
    delete g.window;
    expect(hostOpensExternally()).toBe(false);
  });
});

describe("openExternal", () => {
  let w: StubWindow;
  beforeEach(() => {
    w = stubWindow();
  });
  afterEach(() => {
    delete g.window;
  });

  test("severs the opener instead of passing noopener", () => {
    // `noopener` would make the return value null unconditionally and destroy
    // the caller's ability to tell a blocked popup from an open one.
    let features: string | undefined;
    const child = { opener: {} as unknown } as Window;
    w.open = (_u: string, _t?: string, f?: string) => {
      features = f;
      return child;
    };

    expect(openExternal("https://example.test/x")).toBe(child);
    expect(features).toBeUndefined();
    expect(child.opener).toBeNull();
  });

  test("a blocked popup comes back as null", () => {
    w.open = () => null;
    expect(openExternal("https://example.test/x")).toBeNull();
  });

  test("survives a browser that refuses the opener write", () => {
    const child = {} as Window;
    Object.defineProperty(child, "opener", {
      set() {
        throw new Error("cross-origin");
      },
    });
    w.open = () => child;
    expect(() => openExternal("https://example.test/x")).not.toThrow();
  });
});

/**
 * The flag literal spans Go and TypeScript, so no compiler links the two. A
 * typo on either side silently restores the old behaviour, with no error
 * anywhere and only reproducible inside a real panel.
 */
describe("host-injection contract", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
  const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), "utf8");
  const FLAG = "__jarvisOpensExternally";

  test("the sidecar injects the flag this module reads", () => {
    expect(read("sidecar", "panels_runtime.go")).toContain(`window.${FLAG} = true`);
    expect(read("ui", "src", "v2", "onboarding", "external-open.ts")).toContain(`window.${FLAG} === true`);
  });

  test("every platform reports whether it installed routing", () => {
    // The injection is gated on this bool. `_other.go` routes nothing and is
    // the case that makes the gate worth having; nothing compiles it in CI.
    for (const f of [
      "panels_extnav_darwin.go",
      "panels_extnav_linux.go",
      "panels_extnav_windows.go",
      "panels_extnav_other.go",
    ]) {
      expect(read("sidecar", f)).toContain("func installPanelExternalNav(wv webview.WebView) bool");
    }
    expect(read("sidecar", "panels_extnav_other.go")).toContain("return false");
  });

  test("the platforms that need a popup setting both set AND verify it", () => {
    // Reporting true without this is what makes the injected flag a lie: the
    // page stops showing the fallback while the open is still refused. Linux
    // shipped exactly that for one review round.
    const darwin = read("sidecar", "panels_extnav_darwin.go");
    expect(darwin).toContain("javaScriptCanOpenWindowsAutomatically = YES");
    expect(darwin).toContain("if (!v.configuration.preferences.javaScriptCanOpenWindowsAutomatically)");

    const linux = read("sidecar", "panels_extnav_linux.go");
    expect(linux).toContain("webkit_settings_set_javascript_can_open_windows_automatically(settings, TRUE)");
    expect(linux).toContain("return webkit_settings_get_javascript_can_open_windows_automatically(settings)");
  });
});
