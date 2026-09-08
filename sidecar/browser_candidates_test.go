package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Which browser gets driven, and whether it is driving the profile we told it
// to. Both are asserted against real data rather than parsed source, so they
// run on every platform even though the selection itself is darwin-only.

func TestDarwinLastResortBrowsersLoseToEveryTrustedOne(t *testing.T) {
	// The safety argument for auto-detecting Arc is entirely "it cannot be
	// picked while a browser we trust is installed". If a last-resort bundle
	// ever appears among the trusted ones, that argument is gone and a user
	// with Chrome silently starts having their automation driven through Arc.
	trusted := map[string]bool{}
	for _, b := range darwinBrowserBundles {
		trusted[b] = true
	}
	for _, b := range darwinLastResortBundles {
		if trusted[b] {
			t.Errorf("%s is both trusted and last-resort; last-resort browsers must not be in the trusted list", b)
		}
	}
	if len(darwinLastResortBundles) == 0 {
		t.Skip("no last-resort browsers configured")
	}
	if len(darwinBrowserBundles) == 0 {
		t.Fatal("no trusted browsers configured; the last-resort stage would become the only stage")
	}
}

func TestDarwinBundlePathsSearchPerUserApplicationsToo(t *testing.T) {
	// Chrome's installer offers "install for this user only", which lands in
	// ~/Applications. Searching only /Applications is what made a machine with
	// Chrome installed report no browser at all -- and after adding a
	// last-resort browser it would silently hand that user the last resort.
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}
	paths := darwinBundlePaths(darwinBrowserBundles)

	var sawSystem, sawUser bool
	for _, p := range paths {
		if strings.HasPrefix(p, "/Applications/") {
			sawSystem = true
		}
		if strings.HasPrefix(p, filepath.Join(home, "Applications")+string(filepath.Separator)) {
			sawUser = true
		}
	}
	if !sawSystem {
		t.Error("no /Applications candidates")
	}
	if !sawUser {
		t.Errorf("no ~/Applications candidates; a per-user Chrome install would be invisible")
	}
	if want := len(darwinBrowserBundles) * len(darwinApplicationDirs); len(paths) != want {
		t.Errorf("got %d candidate paths, want %d (every bundle in every Applications dir)", len(paths), want)
	}
}

func TestDarwinBundlePathsKeepsPreferenceOrder(t *testing.T) {
	// Chrome before Vivaldi wherever they are installed: a user with Vivaldi in
	// /Applications and Chrome in ~/Applications should still get Chrome.
	paths := darwinBundlePaths(darwinBrowserBundles)
	first := strings.Index(strings.Join(paths, "\n"), "Google Chrome")
	last := strings.Index(strings.Join(paths, "\n"), "Vivaldi")
	if first == -1 || last == -1 {
		t.Skip("expected browsers not configured")
	}
	if first > last {
		t.Error("Vivaldi is preferred over Chrome; bundle order must win over directory order")
	}
}

// The profile guard. Its false-negative cost is refusing a browser that works,
// so both directions get pinned.
func TestProfileDirUsed(t *testing.T) {
	t.Run("a browser that wrote into the profile passes immediately", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "Local State"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		used, err := profileDirUsed(dir)
		if err != nil || !used {
			t.Fatalf("used=%v err=%v, want true/nil", used, err)
		}
		if time.Since(start) > profileDirWriteGrace {
			t.Error("waited out the grace period on the happy path")
		}
	})

	t.Run("any file counts, not a particular one", func(t *testing.T) {
		// Filename-agnostic on purpose: requiring "Local State" would risk
		// refusing a Chromium build that lays its profile out differently.
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "whatever"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		used, err := profileDirUsed(dir)
		if err != nil || !used {
			t.Fatalf("used=%v err=%v, want true/nil", used, err)
		}
	})

	t.Run("an empty profile means the browser went somewhere else", func(t *testing.T) {
		// The failure this guard exists for: the browser ignored --user-data-dir
		// and is driving the user's own logged-in profile instead.
		used, err := profileDirUsed(t.TempDir())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if used {
			t.Error("an empty profile dir reported as used")
		}
	})

	t.Run("a profile dir that was never created is not an error", func(t *testing.T) {
		used, err := profileDirUsed(filepath.Join(t.TempDir(), "never-made"))
		if err != nil {
			t.Fatalf("absent dir should not be an error, got %v", err)
		}
		if used {
			t.Error("an absent profile dir reported as used")
		}
	})
}

// The "no browser found" message is the only thing an affected user sees, and
// it had drifted out of step with the list it describes on all three platforms:
// each named fewer browsers than its own code accepts, and none mentioned the
// config override that takes any Chromium build. Keep them together.
func TestBrowserNotFoundMessageNamesWhatWeAccept(t *testing.T) {
	for _, tc := range []struct {
		file  string
		names []string
	}{
		{"platform_darwin.go", []string{"Chrome", "Chromium", "Edge", "Brave", "Vivaldi", "Arc"}},
		{"platform_linux.go", []string{"Chrome", "Chromium", "Edge", "Brave", "Vivaldi", "Opera"}},
		// Windows accepts Chromium via windowsChromiumCandidates and Opera via
		// the default-browser handler; the first version of this list missed
		// both, which is the drift the test is here to stop.
		{"platform_windows.go", []string{"Chrome", "Chromium", "Edge", "Brave", "Vivaldi", "Opera"}},
	} {
		src, err := os.ReadFile(tc.file)
		if err != nil {
			t.Fatalf("read %s: %v", tc.file, err)
		}
		text := string(src)
		// Anchor on the Errorf, not the bare phrase: a doc comment quoting the
		// message would otherwise capture the assertion.
		i := strings.Index(text, `fmt.Errorf("no Chromium-based browser found`)
		if i == -1 {
			t.Errorf("%s: not-found message missing", tc.file)
			continue
		}
		// Bound at the end of the call so the window cannot bleed into
		// unrelated code that happens to contain these words.
		j := strings.Index(text[i:], ")\n")
		if j == -1 {
			t.Errorf("%s: could not find the end of the not-found Errorf", tc.file)
			continue
		}
		msg := text[i : i+j]
		for _, name := range tc.names {
			if !strings.Contains(msg, name) {
				t.Errorf("%s: the not-found message does not mention %s, which it accepts", tc.file, name)
			}
		}
		if !strings.Contains(msg, "browser.executable_path") {
			t.Errorf("%s: the message should point at browser.executable_path, which accepts "+
				"any Chromium build and is the answer for anything unlisted", tc.file)
		}
	}
}
