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
	out := make([]string, 0, len(bundles)*len(darwinApplicationDirs))
	for _, b := range bundles {
		for _, dir := range darwinApplicationDirs {
			if strings.HasPrefix(dir, "~/") {
				home, err := os.UserHomeDir()
				if err != nil {
					continue
				}
				dir = filepath.Join(home, strings.TrimPrefix(dir, "~/"))
			}
			out = append(out, filepath.Join(dir, b))
		}
	}
	return out
}
