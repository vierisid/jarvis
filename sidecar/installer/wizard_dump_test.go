package main

// Temporary helper, mirroring the sidecar's TestDumpBrandPages: dumps the
// wizard to JARVIS_PAGE_DUMP_DIR for visual QA in a real browser. Not part of
// the suite (skips without the env var).
//
// The wizard is a state machine whose whole visible output is one panel, so it
// dumps one file per STATE rather than a single page (the plan phase alone has
// four): "does the done screen still say Not installed?" is a question you
// answer by looking at the done screen.
//
// For the same states asserted rather than eyeballed, see
// TestWizardPanelSaysWhatIsOnTheMachine — it renders through `preview` too.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// preview turns the compiled page into something a plain browser can render:
// the bindings it polls are stubbed with a fixed snapshot, and chromed
// variants get the marker winchrome.Install stamps on Windows.
//
// It fails rather than returning the page unchanged: a silent no-op would hand
// visual QA a page that looks fine and proves nothing.
func preview(t *testing.T, st wizardState, chromed bool) string {
	t.Helper()
	snap, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	stub := `<script>` +
		`window.startPlan=function(){};window.retryPlan=function(){};` +
		`window.startInstall=function(){};window.launchAndClose=function(){};` +
		`window.closeInstaller=function(){};` +
		`window.getProgress=function(){return Promise.resolve(` + string(snap) + `);};`
	if chromed {
		stub += `window.__jarvisCustomChrome=true;`
	}
	stub += `</script>`

	html := wizardHTML
	if chromed {
		marked := strings.Replace(html, "<html>", `<html data-chrome="custom">`, 1)
		if marked == html {
			t.Fatal("no bare <html> tag to mark as custom-chromed")
		}
		html = marked
	}
	out := strings.Replace(html, "<body>", "<body>"+stub, 1)
	if out == html {
		t.Fatal("no bare <body> tag to inject the stubs into")
	}
	return out
}

func TestDumpWizardPage(t *testing.T) {
	dir := os.Getenv("JARVIS_PAGE_DUMP_DIR")
	if dir == "" {
		t.Skip("set JARVIS_PAGE_DUMP_DIR to dump the wizard page")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	// Windows throughout: it is the only platform with both the autostart row
	// and the custom title bar.
	base := wizardState{Platform: "windows", AutostartDefault: true}
	with := func(fn func(*wizardState)) wizardState {
		s := base
		fn(&s)
		return s
	}
	states := map[string]wizardState{
		"resolving":    with(func(s *wizardState) { s.Phase = "resolving" }),
		"plan-fresh":   with(func(s *wizardState) { s.Phase, s.Detected, s.FirstInstall = "plan", true, true }),
		"plan-update":  with(func(s *wizardState) { s.Phase, s.Detected, s.Installed = "plan", true, true }),
		"plan-current": with(func(s *wizardState) { s.Phase, s.Detected, s.Installed, s.UpToDate = "plan", true, true, true }),
		"plan-npm":     with(func(s *wizardState) { s.Phase, s.Detected, s.Installed, s.NpmManaged = "plan", true, true, true }),
		"running": with(func(s *wizardState) {
			s.Phase, s.Detected, s.Detail = "running", true, "Verifying the payload (sha512 + code signature)…"
		}),
		"done": with(func(s *wizardState) { s.Phase, s.Detected, s.Installed, s.FirstInstall = "done", true, true, true }),
		"failed": with(func(s *wizardState) {
			s.Phase, s.Error = "failed", "could not reach the npm registry: dial tcp: lookup registry.npmjs.org: no such host"
		}),
	}

	for name, st := range states {
		for _, chromed := range []bool{false, true} {
			file := name + ".html"
			if chromed {
				file = "chrome-" + file
			}
			html := preview(t, st, chromed)
			if err := os.WriteFile(filepath.Join(dir, file), []byte(html), 0644); err != nil {
				t.Fatal(err)
			}
			// Force the dark tokens AND dark UA form controls (color-scheme),
			// so the switch and scrollbars match a real dark-OS window.
			dark := strings.ReplaceAll(html, "@media (prefers-color-scheme: dark)", "@media all")
			dark = strings.Replace(dark, "color-scheme: light dark", "color-scheme: dark", 1)
			if err := os.WriteFile(filepath.Join(dir, "dark-"+file), []byte(dark), 0644); err != nil {
				t.Fatal(err)
			}
		}
	}
}
