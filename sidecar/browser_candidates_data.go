package main

import (
	"os"
	"path/filepath"
	"strings"
)

// macOS browser-bundle candidates and the pure path expansion over them, in a
// file with NO build tag on purpose (and named so nothing here can be mistaken
// for a _darwin GOOS suffix).
//
// findChromiumExecutable is darwin-only, so on a Linux CI runner nothing can
// call it and the only way to test its selection order used to be parsing this
// file's source. That test went blind the moment the list grew a shape it did
// not expect. Keeping the lists here, compiled everywhere, lets the test assert
// the real slices on any platform. They cost a few strings of dead data off
// macOS.

// darwinBrowserBundles are the Chromium browsers we are willing to drive
// unattended, relative to an Applications directory. Order is preference.
var darwinBrowserBundles = []string{
	"Google Chrome.app/Contents/MacOS/Google Chrome",
	"Chromium.app/Contents/MacOS/Chromium",
	"Brave Browser.app/Contents/MacOS/Brave Browser",
	"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"Vivaldi.app/Contents/MacOS/Vivaldi",
}

// darwinApplicationDirs are searched in order for each bundle above. The
// per-user directory is not decoration: Chrome's installer offers "install for
// this user only", which lands in ~/Applications, and a machine with Chrome
// there previously reported no browser at all -- the same symptom that started
// this. It also has to be searched BEFORE any last-resort browser, or such a
// user silently gets driven through the last resort while Chrome sits
// installed.
var darwinApplicationDirs = []string{"/Applications", "~/Applications"}

// darwinLastResortBundles are tried only when nothing above matched and the
// PATH fallback found nothing either.
//
// Arc is Chromium, but it is the most heavily customized shell here and nobody
// has confirmed it honours the two flags this code depends on:
// --remote-debugging-pipe (without it the capability is dead) and
// --user-data-dir (without it automation would run inside the user's own
// logged-in profile, which is why launchCDP verifies the profile directory was
// actually used before handing the browser to anyone).
//
// Last resort means it is reachable only on a machine that has no browser we
// trust and therefore no browser capability today, so nothing can regress.
// Promote it once someone has driven it.
var darwinLastResortBundles = []string{
	"Arc.app/Contents/MacOS/Arc",
}

// darwinBundlePaths expands bundle-relative paths across every Applications
// directory, preserving bundle order within each directory.
func darwinBundlePaths(bundles []string) []string {
	// Resolved once: os.UserHomeDir is a syscall and the answer cannot change
	// between bundles. An unresolvable home drops only the ~/ entries.
	dirs := make([]string, 0, len(darwinApplicationDirs))
	for _, dir := range darwinApplicationDirs {
		if rest, ok := strings.CutPrefix(dir, "~/"); ok {
			home, err := os.UserHomeDir()
			if err != nil {
				continue
			}
			dir = filepath.Join(home, rest)
		}
		dirs = append(dirs, dir)
	}

	// Bundle in the OUTER loop: preference between browsers outranks preference
	// between directories, so a Chrome in ~/Applications beats a Vivaldi in
	// /Applications. Inverting these two loops is a silent regression, which is
	// why the test asserts the full expansion rather than relative positions.
	out := make([]string, 0, len(bundles)*len(dirs))
	for _, b := range bundles {
		for _, dir := range dirs {
			out = append(out, filepath.Join(dir, b))
		}
	}
	return out
}

// darwinPathFallbacks are looked up on PATH when no bundle matched -- a
// Homebrew chromium, say. Still a browser we trust, so it outranks the
// last-resort bundles.
var darwinPathFallbacks = []string{"google-chrome", "chromium"}

// pickDarwinBrowser is the whole selection order, as a pure function so it can
// be tested off macOS: trusted bundles, then PATH, then last resort. Returns ""
// when nothing matched.
//
// The stage order is the guarantee this file exists to make -- a last-resort
// browser must lose to every trusted one, wherever that one is installed -- and
// it lives here rather than in the darwin-tagged file precisely so a Linux test
// run can hold it to that.
func pickDarwinBrowser(exists func(string) bool, lookPath func(string) (string, error)) string {
	for _, c := range darwinBundlePaths(darwinBrowserBundles) {
		if exists(c) {
			return c
		}
	}
	for _, c := range darwinPathFallbacks {
		if p, err := lookPath(c); err == nil {
			return p
		}
	}
	for _, c := range darwinBundlePaths(darwinLastResortBundles) {
		if exists(c) {
			return c
		}
	}
	return ""
}
