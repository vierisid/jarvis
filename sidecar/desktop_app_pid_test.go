package main

import "testing"

// A slice of `ps -axo pid=,comm=` as macOS prints it: the pid right-aligned,
// then the full path of each process's executable. The decoys are what
// `pgrep -n <name>` used to land on, plus a second executable that shares the
// main one's Contents/MacOS.
const psAppsFixture = `    1 /sbin/launchd
  412 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
  901 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  955 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130.0.6723.117/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
  960 /Applications/Visual Studio Code.app/Contents/MacOS/Code
  977 /Applications/Jarvis.app/Contents/MacOS/jarvis
  990 /Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint
 1010 /System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari
 1500 /System/Library/PrivateFrameworks/SafariShared.framework/Versions/A/XPCServices/com.apple.Safari.History.xpc/Contents/MacOS/com.apple.Safari.History
 1600 /usr/local/bin/code
 1700 /System/Library/CoreServices/SafariSupport.bundle/Contents/MacOS/SafariBookmarksSyncAgent
 2001 /Users/me/src/jarvis/sidecar/dist/macos/Jarvis.app/Contents/MacOS/jarvis
 2300 /Applications/Firefox.app/Contents/MacOS/firefox
 2350 /Applications/Firefox.app/Contents/MacOS/pingsender
garbage line

`

func TestAppProcessPidFindsTheAppsMainProcess(t *testing.T) {
	cases := []struct {
		app  string
		want int
		why  string
	}{
		{"Jarvis", 2001, "case differs from the jarvis executable; two instances, newest wins"},
		{"jarvis", 2001, "open -a is case-insensitive, so the lookup must be too"},
		{"Google Chrome", 901, "the newer Chrome helper (955) is not the app"},
		{"google chrome", 901, "case-insensitive with a space in the name"},
		{"Firefox", 2300, "pingsender shares Contents/MacOS and started later, but is not the app"},
		{"Visual Studio Code", 960, "the executable is Code, not the app name"},
		{"Code", 960, "executable-name fallback; /usr/local/bin/code is not an app"},
		{"Microsoft PowerPoint", 990, "longer than the 16-character process name"},
		{"Safari", 1010, "SafariBookmarksSyncAgent and the Safari XPC service are not the app"},
		{"Safari.app", 1010, "bundle name form"},
		{"/Applications/Safari.app/", 1010, "bundle path form"},
		{"Finder", 412, "system app"},
		{"Notion", 0, "not running"},
		{"C++ Builder", 0, "regex metacharacters are plain text"},
		{"", 0, "empty argument"},
		{".app", 0, "nothing left after trimming"},
	}
	for _, c := range cases {
		if got := appProcessPid(psAppsFixture, c.app); got != c.want {
			t.Errorf("appProcessPid(%q) = %d, want %d (%s)", c.app, got, c.want, c.why)
		}
	}
}

// A bundle literally named after the argument beats another app whose
// executable merely shares the name, even when that one is newer.
func TestAppProcessPidPrefersTheBundleName(t *testing.T) {
	ps := "   50 /Applications/Visual Studio Code.app/Contents/MacOS/Code\n" +
		"   40 /Applications/Code.app/Contents/MacOS/CodeEdit\n"
	if got := appProcessPid(ps, "Code"); got != 40 {
		t.Fatalf("appProcessPid(Code) = %d, want 40 (the Code.app bundle)", got)
	}
}
