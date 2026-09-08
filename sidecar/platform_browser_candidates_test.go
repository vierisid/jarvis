package main

import (
	"os"
	"strings"
	"testing"
)

// Arc's POSITION in the macOS candidate list is the whole safety argument for
// including it, so it gets a test even though the list itself is darwin-only
// (this reads the source, like run_loop_ownership_test.go, because a Linux CI
// runner cannot call the function).
//
// Arc is Chromium but the most customized shell we auto-detect, and nobody has
// confirmed it honours --remote-debugging-pipe or --user-data-dir. Last means it
// is reachable only on a machine with no browser we trust -- which today gets no
// browser capability at all, so there is nothing to regress. Move it up and a
// user with Chrome installed silently starts having their automation driven
// through Arc instead, which is a regression nobody would think to look for.
func TestArcIsTheLastBrowserCandidateOnDarwin(t *testing.T) {
	src, err := os.ReadFile("platform_darwin.go")
	if err != nil {
		t.Fatalf("read platform_darwin.go: %v", err)
	}
	text := string(src)

	start := strings.Index(text, "candidates := []string{")
	if start == -1 {
		t.Fatal("candidate list not found; did findChromiumExecutable change shape?")
	}
	end := strings.Index(text[start:], "\n\t}")
	if end == -1 {
		t.Fatal("candidate list is not terminated where expected")
	}
	block := text[start : start+end]

	var paths []string
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, `"/Applications/`) {
			paths = append(paths, line)
		}
	}
	if len(paths) < 2 {
		t.Fatalf("expected several browser candidates, found %d", len(paths))
	}
	if !strings.Contains(paths[len(paths)-1], "Arc.app") {
		t.Errorf("Arc must be the LAST candidate so it never displaces a browser we "+
			"trust; last is %s", paths[len(paths)-1])
	}
	for _, p := range paths[:len(paths)-1] {
		if strings.Contains(p, "Arc.app") {
			t.Errorf("Arc appears before the end of the candidate list: %s", p)
		}
	}
}

// The "no browser found" message is the only thing an affected user sees, and it
// drifted out of step with the list it describes: it named four browsers while
// the code accepted five, and never mentioned that browser.executable_path
// accepts any Chromium build. Keep the two together.
func TestBrowserNotFoundMessageNamesWhatWeAccept(t *testing.T) {
	for _, tc := range []struct {
		file  string
		names []string
	}{
		{"platform_darwin.go", []string{"Chrome", "Chromium", "Edge", "Brave", "Vivaldi", "Arc"}},
		{"platform_linux.go", []string{"Chrome", "Chromium", "Edge", "Brave", "Vivaldi", "Opera"}},
		{"platform_windows.go", []string{"Chrome", "Edge", "Brave", "Vivaldi"}},
	} {
		src, err := os.ReadFile(tc.file)
		if err != nil {
			t.Fatalf("read %s: %v", tc.file, err)
		}
		text := string(src)
		i := strings.Index(text, "no Chromium-based browser found")
		if i == -1 {
			t.Errorf("%s: not-found message missing", tc.file)
			continue
		}
		msg := text[i:min(i+240, len(text))]
		for _, name := range tc.names {
			if !strings.Contains(msg, name) {
				t.Errorf("%s: the not-found message does not mention %s, which it accepts", tc.file, name)
			}
		}
		if !strings.Contains(msg, "browser.executable_path") {
			t.Errorf("%s: the not-found message should point at browser.executable_path, "+
				"which accepts any Chromium build and is the answer for anything unlisted", tc.file)
		}
	}
}
