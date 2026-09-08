import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The "did the host open it?" contract, which spans two languages and is held
 * together by a string literal.
 *
 * The sidecar's panel runtime injects `window.__jarvisOpensExternally` when it
 * has installed new-window routing; the onboarding wizard reads it to decide
 * whether a null from `window.open` means "the host handed the URL to the
 * system browser" or "the popup was blocked". Those look identical from the
 * page, because the host's handler opens the URL and returns no view.
 *
 * A typo on either side silently reverts to the old behaviour: the user's
 * browser opens the consent screen while the page tells them it didn't. No
 * error, nothing in a log, and only reproducible inside a real panel on macOS.
 * So the two spellings get asserted equal here, where it costs nothing.
 */
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

const FLAG = "__jarvisOpensExternally";

describe("host-opens-externally contract", () => {
  test("the sidecar injects the same flag the wizard reads", () => {
    const runtime = read("sidecar", "panels_runtime.go");
    const wizard = read("ui", "src", "v2", "onboarding", "OnboardingWizard.tsx");

    expect(runtime).toContain(`window.${FLAG} = true`);
    expect(wizard).toContain(`window.${FLAG} === true`);
  });

  test("the flag is only injected when routing actually installed", () => {
    // Injecting unconditionally would be worse than not injecting at all: the
    // page would suppress its fallback message on a platform where nothing
    // routes new windows, so a genuinely blocked popup would fail in silence.
    const runtime = read("sidecar", "panels_runtime.go");
    const gate = runtime.indexOf("if installPanelExternalNav(wv) {");
    const inject = runtime.indexOf(`window.${FLAG} = true`);

    expect(gate).toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(gate);
    // ...and inside that block, not merely after it.
    const between = runtime.slice(gate, inject);
    expect(between).not.toContain("\n\t\t\t}");
  });

  test("every platform reports whether it installed routing", () => {
    // The gate above is only meaningful if a platform that routes nothing says
    // so. `_other.go` is the one that must return false.
    for (const file of [
      "panels_extnav_darwin.go",
      "panels_extnav_linux.go",
      "panels_extnav_windows.go",
      "panels_extnav_other.go",
    ]) {
      expect(read("sidecar", file)).toContain("func installPanelExternalNav(wv webview.WebView) bool");
    }
    expect(read("sidecar", "panels_extnav_other.go")).toContain("return false");
  });

  test("the wizard never passes noopener to window.open", () => {
    // `window.open` with noopener returns null BY SPECIFICATION, so any check
    // of its return value reads as "blocked" on every call. This repo has hit
    // that twice in this one function -- once in the managed branch (fixed, and
    // documented in a comment there) and once in the self-hosted branch, which
    // sat there telling every user their popup was blocked while the consent
    // screen opened behind the message.
    const wizard = read("ui", "src", "v2", "onboarding", "OnboardingWizard.tsx");
    for (const call of wizard.matchAll(/window\.open\([^)]*\)/g)) {
      expect(call[0]).not.toContain("noopener");
    }
  });
});
