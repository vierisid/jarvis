package brand

import (
	"regexp"
	"strings"
	"testing"
)

// The strip must be invisible until winchrome.Install stamps the marker —
// otherwise macOS and Linux would show a second title bar under the native one.
func TestTitlebarIsHiddenWithoutTheChromeMarker(t *testing.T) {
	if !strings.Contains(TitlebarCSS, ".wchrome { display: none; }") {
		t.Fatal("TitlebarCSS must hide .wchrome by default")
	}
	// Every rule that gives the strip layout or reserves space for it has to be
	// behind the marker, or an un-chromed page loses 34px to nothing.
	for _, gated := range []string{
		`html[data-chrome="custom"] body`,
		`html[data-chrome="custom"] .wchrome`,
	} {
		if !strings.Contains(TitlebarCSS, gated) {
			t.Errorf("TitlebarCSS is missing the gated rule %q", gated)
		}
	}
	if !strings.Contains(TitlebarJS, "if (!window.__jarvisCustomChrome) return;") {
		t.Error("TitlebarJS must no-op when custom chrome is not installed")
	}
}

// Element ids are the contract between the markup and the script; a rename on
// one side alone leaves a dead control that looks fine.
func TestTitlebarScriptOnlyReachesIdsTheMarkupDefines(t *testing.T) {
	defined := map[string]bool{}
	for _, m := range regexp.MustCompile(`id="([^"]+)"`).FindAllStringSubmatch(TitlebarHTML, -1) {
		defined[m[1]] = true
	}
	used := regexp.MustCompile(`getElementById\('([^']+)'\)`).FindAllStringSubmatch(TitlebarJS, -1)
	if len(used) == 0 {
		t.Fatal("no getElementById calls found — the extraction regexp has rotted")
	}
	for _, m := range used {
		if !defined[m[1]] {
			t.Errorf("TitlebarJS reaches for id %q, which TitlebarHTML does not define", m[1])
		}
	}
}

// The controls are the only reason the strip exists; each needs an accessible
// name, since its glyph is an aria-hidden SVG.
func TestTitlebarControlsAreNamed(t *testing.T) {
	for _, want := range []string{
		`id="wchrome-min" aria-label="Minimize"`,
		`id="wchrome-max" aria-label="Maximize"`,
		`id="wchrome-close" aria-label="Close"`,
	} {
		if !strings.Contains(TitlebarHTML, want) {
			t.Errorf("TitlebarHTML is missing %q", want)
		}
	}
	if n := strings.Count(TitlebarHTML, "<button"); n != 3 {
		t.Errorf("expected exactly 3 window controls, found %d", n)
	}
}

// The maximize button keeps both glyphs in the DOM and swaps them with a class,
// so the restore state can never be reached without a rule to render it.
func TestTitlebarHasBothMaximizeGlyphs(t *testing.T) {
	for _, cls := range []string{"wchrome-glyph-max", "wchrome-glyph-restore"} {
		if !strings.Contains(TitlebarHTML, cls) {
			t.Errorf("TitlebarHTML is missing the %s glyph", cls)
		}
		if !strings.Contains(TitlebarCSS, cls) {
			t.Errorf("TitlebarCSS never rules on %s", cls)
		}
	}
	if !strings.Contains(TitlebarCSS, ".wchrome.is-max .wchrome-glyph-restore") {
		t.Error("TitlebarCSS must show the restore glyph on .is-max")
	}
	if !strings.Contains(TitlebarJS, "'is-max'") {
		t.Error("TitlebarJS must toggle the is-max class")
	}
}

// A raw string constant that contains a backtick does not compile; these are
// concatenated into page HTML, so a stray one is a build break, not a bug — but
// an unescaped </script> inside TitlebarJS would silently truncate the page.
func TestTitlebarJSCannotCloseItsScriptTag(t *testing.T) {
	if strings.Contains(strings.ToLower(TitlebarJS), "</script") {
		t.Fatal("TitlebarJS contains </script, which would end the page's script block early")
	}
}
