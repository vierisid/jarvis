package main

// What the wizard's one panel actually SAYS, read out of a real browser.
//
// The Go side of this page is four fields and two pure functions, all of them
// tested next door — and none of that catches the bug this exists for. The
// panel read "not installed" on the done screen of a successful install
// because of which field `render()` looked at, so the only test that would
// have failed is one that renders the page and reads the label back.
//
// OPT-IN: set JARVIS_BROWSER_TESTS=1, the same gate as the sidecar's
// TestTitlebarGesture. A headless browser is not a dependency this suite can
// rely on, and a browser that launches but never exits must not be able to
// take the package to its timeout — hence the gate and the hard deadline.

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// text pulls an element's rendered text out of --dump-dom output. The page
// writes these with textContent, so what lands in the DOM is plain text.
func text(t *testing.T, dom, id string) string {
	t.Helper()
	re := regexp.MustCompile(`id="` + id + `"[^>]*>([^<]*)<`)
	m := re.FindStringSubmatch(dom)
	if m == nil {
		t.Fatalf("#%s is not in the rendered DOM", id)
	}
	return strings.TrimSpace(strings.ReplaceAll(m[1], "&nbsp;", " "))
}

// hidden reports whether an element carries the page's .hidden class.
func hidden(t *testing.T, dom, id string) bool {
	t.Helper()
	re := regexp.MustCompile(`<[^>]*id="` + id + `"[^>]*>`)
	m := re.FindString(dom)
	if m == "" {
		t.Fatalf("#%s is not in the rendered DOM", id)
	}
	return strings.Contains(m, "hidden")
}

func renderPage(t *testing.T, chrome string, st wizardState) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "wizard.html")
	if err := os.WriteFile(path, []byte(preview(t, st, true)), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, chrome,
		"--headless=new", "--disable-gpu", "--no-sandbox",
		"--disable-dev-shm-usage", "--no-first-run", "--disable-extensions",
		"--user-data-dir="+filepath.Join(dir, "profile"),
		// The page polls every 500ms and renders on the first answer.
		"--virtual-time-budget=2000", "--window-size=480,560",
		"--dump-dom", "file://"+path,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("%s never exited within 60s; stderr:\n%s", chrome, stderr.String())
	}
	if err != nil {
		t.Fatalf("%s: %v; stderr:\n%s", chrome, err, stderr.String())
	}
	return string(out)
}

func TestWizardPanelSaysWhatIsOnTheMachine(t *testing.T) {
	if os.Getenv("JARVIS_BROWSER_TESTS") == "" {
		t.Skip("set JARVIS_BROWSER_TESTS=1 to render the wizard in a real browser")
	}
	chrome := findChromium()
	if chrome == "" {
		t.Skip("no chromium/chrome on PATH — the panel is browser-rendered")
	}

	// Windows throughout: the only platform with both the autostart row and
	// the custom title bar.
	base := wizardState{Platform: "windows", AutostartDefault: true}
	with := func(fn func(*wizardState)) wizardState {
		s := base
		fn(&s)
		return s
	}

	cases := []struct {
		name string
		st   wizardState
		// What the panel row, the subtitle's opening and the main button say.
		status    string
		subtitle  string
		button    string
		autostart bool // the login-item row is visible
	}{
		{
			name:      "nothing installed yet",
			st:        with(func(s *wizardState) { s.Phase, s.Detected, s.FirstInstall = "plan", true, true }),
			status:    "Not installed",
			subtitle:  "This installs the Jarvis sidecar on this machine.",
			button:    "Install",
			autostart: true,
		},
		{
			name:     "an update is waiting",
			st:       with(func(s *wizardState) { s.Phase, s.Detected, s.Installed = "plan", true, true }),
			status:   "Update available",
			subtitle: "This updates the Jarvis sidecar on this machine.",
			button:   "Update",
		},
		{
			name:     "already current",
			st:       with(func(s *wizardState) { s.Phase, s.Detected, s.Installed, s.UpToDate = "plan", true, true, true }),
			status:   "Up to date",
			subtitle: "You already have the latest sidecar.",
			button:   "Close",
		},
		{
			name:   "npm owns it",
			st:     with(func(s *wizardState) { s.Phase, s.Detected, s.Installed, s.NpmManaged = "plan", true, true, true }),
			status: "Managed by npm",
			button: "Close",
		},
		{
			name:   "mid-install",
			st:     with(func(s *wizardState) { s.Phase, s.Detected = "running", true }),
			status: "In progress",
		},
		// THE REGRESSION. A first install that finished must not still be
		// reporting the plan's answer.
		{
			name:     "a first install that finished",
			st:       with(func(s *wizardState) { s.Phase, s.Detected, s.Installed, s.FirstInstall = "done", true, true, true }),
			status:   "Installed",
			subtitle: "Installed.",
			button:   "Launch Jarvis",
		},
		{
			name:     "an update that finished",
			st:       with(func(s *wizardState) { s.Phase, s.Detected, s.Installed = "done", true, true }),
			status:   "Updated",
			subtitle: "Updated.",
			button:   "Launch Jarvis",
		},
		{
			name:   "nothing could be checked",
			st:     with(func(s *wizardState) { s.Phase, s.Error = "failed", "could not reach the npm registry" }),
			status: "—",
			button: "Retry",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dom := renderPage(t, chrome, c.st)
			if got := text(t, dom, "vStatus"); got != c.status {
				t.Errorf("panel says %q, want %q", got, c.status)
			}
			if c.subtitle != "" {
				if got := text(t, dom, "subtitle"); got != c.subtitle {
					t.Errorf("subtitle says %q, want %q", got, c.subtitle)
				}
			}
			if c.button != "" {
				if got := text(t, dom, "btnMain"); got != c.button {
					t.Errorf("main button says %q, want %q", got, c.button)
				}
			}
			if got := !hidden(t, dom, "autostartRow"); got != c.autostart {
				t.Errorf("autostart row visible = %v, want %v", got, c.autostart)
			}
			// The strip is what this window is closed and moved by on
			// Windows; a page that rendered without it is a trapped window.
			if !strings.Contains(dom, `id="wchrome-close"`) {
				t.Error("no window controls in the rendered page")
			}
		})
	}
}

// findChromium mirrors the sidecar's helper of the same name; the installer is
// a separate package and cannot borrow it.
func findChromium() string {
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}
