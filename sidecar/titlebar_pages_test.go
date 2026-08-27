package main

// The splice, not the strip. internal/brand tests what the title bar IS; these
// test that the pages actually carry it — dropping one of the three pieces from
// a page compiles, passes every other test, and ships a Windows window with no
// title bar at all (or one whose buttons do nothing).

import (
	"regexp"
	"strings"
	"testing"
)

// customChromePages are the local pages that draw their own title bar on
// Windows, keyed by the name the QA dump uses. Their windows get there two
// ways: settings, logs and onboarding pass winchrome.CustomTitleBar to their
// window host, while hosted and setup are shown by runFirstRunWindow, which
// builds its webview itself and calls winchrome.Install directly.
// brand_pages_dump_test.go dumps a chromed variant of exactly this set, so the
// two cannot drift.
var customChromePages = map[string]string{
	"settings":   settingsWindowHTML,
	"logs":       logViewerHTML,
	"hosted":     hostedShellHTML,
	"setup":      setupWindowHTML,
	"onboarding": onboardingWindowHTML,
}

// wrappedPages are the chromed pages that scroll an inner .pagebody. Logs is
// the exception: its body is a flex column that never scrolls (its <pre> does),
// and it was already designed flush to the window edge.
var wrappedPages = []string{"settings", "hosted", "setup", "onboarding"}

func TestCustomChromePagesCarryTheWholeTitlebar(t *testing.T) {
	for name, html := range customChromePages {
		if !strings.Contains(html, brandTitlebarHTML) {
			t.Errorf("%s: no title bar markup — the window would have no title bar at all on Windows", name)
		}
		if !strings.Contains(html, brandTitlebarCSS) {
			t.Errorf("%s: no title bar CSS — the strip would render unstyled", name)
		}
		if !strings.Contains(html, brandTitlebarJS) {
			t.Errorf("%s: no title bar script — the window controls would be dead", name)
		}
		// The strip renders document.title; without one it shows an empty
		// caption where the window's name belongs.
		if !strings.Contains(html, "<title>") {
			t.Errorf("%s: no <title> for the strip to show", name)
		}
	}
}

// The account window shows a remote origin end to end, so it must never get
// custom chrome: the bindings that move, minimise and close the window would
// be reachable from that page. account_window.go passes NativeTitleBar; this
// pins the other half of that decision.
func TestRemotePagesHaveNoTitlebar(t *testing.T) {
	if strings.Contains(accountShellHTML, brandTitlebarHTML) {
		t.Error("the account shell carries the title bar; that window shows remote content and must stay natively framed")
	}
}

// bodyRule matches a real `body { … }` rule. The leading boundary is what stops
// it matching inside `.pagebody {`.
var bodyRule = regexp.MustCompile(`(?m)(^|[\s,])body\s*\{[^}]*\}`)

// cssComment strips /* … */ before any rule is scanned: the title bar's own CSS
// explains itself by quoting "body { padding: … }", and a test that reads prose
// as code fails on the documentation instead of on the page.
var cssComment = regexp.MustCompile(`(?s)/\*.*?\*/`)

// Padding on body is REPLACED by the strip's offset, not added to it, which
// leaves the page's first element flush against the bar. Whatever padding a
// chromed page wants goes on .pagebody instead. Checked generically: pinning
// the three literal declarations this replaced would pass again the moment
// someone writes a fourth.
func TestChromedPagesDoNotPadTheirBody(t *testing.T) {
	pad := regexp.MustCompile(`padding[^:;{}]*:\s*([^;}]+)`)
	for name, html := range customChromePages {
		// The strip's own CSS is not under test here — it is the thing whose
		// body offset the page must not fight — so scan the page's rules only.
		page := cssComment.ReplaceAllString(strings.Replace(html, brandTitlebarCSS, "", 1), "")
		for _, rule := range bodyRule.FindAllString(page, -1) {
			for _, m := range pad.FindAllStringSubmatch(rule, -1) {
				if strings.TrimSpace(m[1]) != "0" {
					t.Errorf("%s: body sets %q — the strip offset will replace that, not add to it\n  in: %s",
						name, strings.TrimSpace(m[0]), strings.TrimSpace(rule))
				}
			}
		}
	}
}

// The wrapper is the scroll container, so its scrollbar starts below the strip
// instead of running behind it — and because a div takes no focus of its own,
// the page must carry PageBodyJS or the window becomes unscrollable for anyone
// without a mouse.
func TestWrappedPagesCarryTheScrollContainerAndItsKeyboard(t *testing.T) {
	for _, name := range wrappedPages {
		html, ok := customChromePages[name]
		if !ok {
			t.Fatalf("%s is not one of the chromed pages", name)
		}
		if !strings.Contains(html, `<div class="pagebody" tabindex="-1">`) {
			t.Errorf("%s: no focusable .pagebody scroll container", name)
		}
		if !strings.Contains(html, "overflow-y: auto") {
			t.Errorf("%s: .pagebody does not scroll", name)
		}
		if !strings.Contains(html, brandPageBodyJS) {
			t.Errorf("%s: no PageBodyJS — Space/PageDown would not scroll the window", name)
		}
	}
}
