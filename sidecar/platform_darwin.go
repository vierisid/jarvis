//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func platformClipboardRead() (string, error) {
	return runCmd("pbpaste", nil, "")
}

func platformClipboardWrite(content string) error {
	_, err := runCmd("pbcopy", nil, content)
	return err
}

func platformCaptureScreen(outputPath string) error {
	_, err := runCmd("screencapture", []string{"-x", outputPath}, "")
	return err
}

func platformDefaultShell() string {
	return "sh"
}

// findChromiumExecutable locates a Chromium-based browser to drive: the
// configured override, else the first known install under /Applications, else
// a PATH fallback (e.g. a Homebrew chromium).
func findChromiumExecutable(cfg *SidecarConfig) (string, error) {
	if p := cfg.Browser.ExecutablePath; p != "" {
		if isExecutableFile(p) {
			return p, nil
		}
		if lp, err := exec.LookPath(p); err == nil {
			return lp, nil
		}
		return "", fmt.Errorf("configured browser executable not found: %s", p)
	}

	candidates := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
		// Arc is Chromium, but it is the most heavily customized shell in this
		// list and nobody here has confirmed it honours the two flags that
		// matter: --remote-debugging-pipe (or the whole capability is dead) and
		// --user-data-dir (or automation lands in the user's own session
		// instead of the throwaway profile). So it goes LAST, where it can only
		// be picked when no browser we trust is installed -- an Arc-only
		// machine, which today gets no browser capability at all. That user
		// trades a fast "unavailable" for a chance it works and a slow launch
		// error if it does not; anyone with Chrome alongside is unaffected.
		// Promote it once someone has driven it.
		"/Applications/Arc.app/Contents/MacOS/Arc",
	}
	for _, c := range candidates {
		if isExecutableFile(c) {
			return c, nil
		}
	}
	for _, c := range []string{"google-chrome", "chromium"} {
		if path, err := exec.LookPath(c); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("no Chromium-based browser found (install Chrome, Chromium, Edge, Brave, Vivaldi or Arc, " +
		"or point browser.executable_path at one)")
}

func isExecutableFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func platformGetActiveWindow() (appName string, windowTitle string) {
	out, err := exec.Command("osascript", "-e",
		`tell application "System Events" to get name of first process whose frontmost is true`).Output()
	if err != nil {
		return "", ""
	}
	app := strings.TrimSpace(string(out))

	titleOut, err := exec.Command("osascript", "-e",
		`tell application "System Events" to get title of front window of first process whose frontmost is true`).Output()
	title := ""
	if err == nil {
		title = strings.TrimSpace(string(titleOut))
	}
	return app, title
}
