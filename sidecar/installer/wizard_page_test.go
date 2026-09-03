package main

// The wizard is one page and one state struct, and both carry decisions that
// compile fine when broken: a title bar spliced in three pieces (drop one and
// Windows ships a window with no caption at all), and a status line fed from a
// snapshot that a finished install has to correct.

import (
	"regexp"
	"strings"
	"testing"

	"github.com/jarvis/sidecar/internal/brand"
)

func TestWizardPageCarriesTheWholeTitlebar(t *testing.T) {
	for name, piece := range map[string]string{
		"markup": brand.TitlebarHTML,
		"CSS":    brand.TitlebarCSS,
		"script": brand.TitlebarJS,
	} {
		if !strings.Contains(wizardHTML, piece) {
			t.Errorf("wizard page is missing the title bar %s — the Windows window would be broken chrome, not native chrome", name)
		}
	}
	// The strip renders document.title; without one it shows an empty caption
	// where the window's name belongs.
	if !strings.Contains(wizardHTML, "<title>") {
		t.Error("wizard page has no <title> for the strip to show")
	}
}

// The wrapper is the scroll container, so its scrollbar starts below the strip
// instead of running behind it — and because a div takes no focus of its own,
// the page must carry PageBodyJS or the window is unscrollable without a mouse.
func TestWizardPageWrapsItsScrollContainer(t *testing.T) {
	if !strings.Contains(wizardHTML, `<div class="pagebody" tabindex="-1">`) {
		t.Error("no focusable .pagebody scroll container")
	}
	if !strings.Contains(wizardHTML, "overflow-y: auto") {
		t.Error(".pagebody does not scroll")
	}
	if !strings.Contains(wizardHTML, brand.PageBodyJS) {
		t.Error("no PageBodyJS — Space/PageDown would not scroll the window")
	}
}

var (
	// bodyRule matches a real `body { … }` rule; the leading boundary is what
	// stops it matching inside `.pagebody {`.
	bodyRule    = regexp.MustCompile(`(?m)(^|[\s,])body\s*\{[^}]*\}`)
	cssComment  = regexp.MustCompile(`(?s)/\*.*?\*/`)
	paddingDecl = regexp.MustCompile(`padding[^:;{}]*:\s*([^;}]+)`)
)

// Padding on body is REPLACED by the strip's offset, not added to it, which
// leaves the hero flush against the bar.
func TestWizardPageDoesNotPadItsBody(t *testing.T) {
	// Scan the page's own rules: the strip's CSS is the thing whose offset the
	// page must not fight, and its comments quote `body { padding: … }`.
	page := cssComment.ReplaceAllString(strings.Replace(wizardHTML, brand.TitlebarCSS, "", 1), "")
	for _, rule := range bodyRule.FindAllString(page, -1) {
		for _, m := range paddingDecl.FindAllStringSubmatch(rule, -1) {
			if strings.TrimSpace(m[1]) != "0" {
				t.Errorf("body sets %q — the strip offset will replace that, not add to it\n  in: %s",
					strings.TrimSpace(m[0]), strings.TrimSpace(rule))
			}
		}
	}
}

// Version numbers are deliberately not part of this page: the installer only
// ever fetches `latest`, so a version is a number the user cannot act on. This
// pins the removal — the fields are gone from wizardState, so a page reading
// them would silently render "undefined" rather than fail to compile.
func TestWizardPageShowsNoVersions(t *testing.T) {
	for _, ref := range []string{"installed_version", "latest_version", "st.installed_version", "st.latest_version"} {
		if strings.Contains(wizardHTML, ref) {
			t.Errorf("page still reads %q — wizardState no longer carries it, so it would render as undefined", ref)
		}
	}
}

func TestApplyPlan(t *testing.T) {
	const latest = "0.9.2"
	cases := []struct {
		name      string
		inst      installedSidecar
		installed bool
		upToDate  bool
		first     bool
		npm       bool
	}{
		{name: "nothing installed", first: true},
		{name: "older version", inst: installedSidecar{Version: "0.9.1"}, installed: true},
		{name: "current version", inst: installedSidecar{Version: "0.9.2"}, installed: true, upToDate: true},
		{name: "newer than latest", inst: installedSidecar{Version: "0.9.3"}, installed: true, upToDate: true},
		{name: "npm managed", inst: installedSidecar{Version: "0.9.1", ManagedByNpm: true}, installed: true, npm: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var s wizardState
			applyPlan(&s, c.inst, latest)
			if s.Phase != "plan" {
				t.Errorf("phase = %q, want plan", s.Phase)
			}
			// Whatever else it says, the page has to know the machine was
			// actually looked at.
			if !s.Detected {
				t.Error("detected = false after a plan that inspected the machine")
			}
			if s.Installed != c.installed {
				t.Errorf("installed = %v, want %v", s.Installed, c.installed)
			}
			if s.UpToDate != c.upToDate {
				t.Errorf("up_to_date = %v, want %v", s.UpToDate, c.upToDate)
			}
			if s.FirstInstall != c.first {
				t.Errorf("first_install = %v, want %v", s.FirstInstall, c.first)
			}
			if s.NpmManaged != c.npm {
				t.Errorf("npm_managed = %v, want %v", s.NpmManaged, c.npm)
			}
		})
	}
}

// The regression this exists for: the panel is fed from the plan snapshot, so
// a first install that succeeded kept reporting "not installed" on its own
// done screen.
func TestApplyOutcomeMarksTheSidecarInstalled(t *testing.T) {
	cases := map[string]installOutcome{
		"fresh install":   {InstallDir: "/opt/jarvis"},
		"already current": {UpToDate: true},
		"npm managed":     {NpmManaged: true},
	}
	for name, out := range cases {
		t.Run(name, func(t *testing.T) {
			// Start from the plan state of a machine with no sidecar — the
			// only starting point where a stale flag is visible.
			s := wizardState{
				Phase: "running", Detected: true, FirstInstall: true,
				Stage: "install", Detail: "Installing to C:\\Users\\x\\AppData\\Local\\Jarvis…",
			}
			applyOutcome(&s, out)
			if s.Phase != "done" {
				t.Errorf("phase = %q, want done", s.Phase)
			}
			if !s.Installed {
				t.Error("installed = false on the done screen — the panel would still read \"Not installed\"")
			}
			if s.UpToDate != out.UpToDate {
				t.Errorf("up_to_date = %v, want %v", s.UpToDate, out.UpToDate)
			}
			if s.NpmManaged != out.NpmManaged {
				t.Errorf("npm_managed = %v, want %v", s.NpmManaged, out.NpmManaged)
			}
			// FirstInstall keeps its plan-time meaning: the macOS done screen
			// and the autostart policy both ask "was this run the first one?".
			if !s.FirstInstall {
				t.Error("first_install was cleared by the outcome — the macOS permissions handoff copy depends on it")
			}
			// The stage line is progress, and there is none left. Leaving it
			// puts "Installing to …" directly under "Installed".
			if s.Stage != "" || s.Detail != "" {
				t.Errorf("stage/detail survived into the done screen: %q / %q", s.Stage, s.Detail)
			}
		})
	}
}
