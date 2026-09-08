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
// configured override, else a trusted install under /Applications or
// ~/Applications, else a PATH fallback (e.g. a Homebrew chromium), else a
// last-resort browser (see browser_candidates_darwin_data.go for why that stage
// is separate and why it must come after every other one).
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

	for _, c := range darwinBundlePaths(darwinBrowserBundles) {
		if isExecutableFile(c) {
			return c, nil
		}
	}
	for _, c := range []string{"google-chrome", "chromium"} {
		if path, err := exec.LookPath(c); err == nil {
			return path, nil
		}
	}
	// AFTER the PATH fallback, not merely last in the bundle list: a Chromium
	// reachable only through PATH is still a browser we trust, and must win.
	for _, c := range darwinBundlePaths(darwinLastResortBundles) {
		if isExecutableFile(c) {
			return c, nil
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
