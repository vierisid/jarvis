//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
)

func platformClipboardRead() (string, error) {
	return runCmd("pbpaste", nil, "")
}

func platformClipboardWrite(content string) error {
	_, err := runCmd("pbcopy", nil, content)
	return err
}

// screenAsked is set once macOS has been asked for the Screen Recording
// permission by this process.
var screenAsked atomic.Bool

// platformCaptureScreen takes a picture of the screen with the system's own
// tool. Without the Screen Recording permission it does not try.
//
// It used to: the tool then fails, and on a recent macOS every such try puts
// the system's "Jarvis would like to record this computer's screen" window up
// again. What watches the screen takes a picture every 15 seconds, so the
// window came back every 15 seconds, forty times in thirteen minutes on the
// third run on a real Mac (19 November 2026): "the mac os pop up keeps on
// opening". Now macOS is asked once in the life of the program, which also
// puts Jarvis in the list where the permission is given, and after that the
// answer is simply no until the permission is there.
func platformCaptureScreen(outputPath string) error {
	if !setupScreenAllowed() {
		if screenAsked.CompareAndSwap(false, true) {
			setupRequestPermission("screen")
		}
		return errScreenNotAllowed
	}
	_, err := runCmd("screencapture", []string{"-x", outputPath}, "")
	return err
}

func platformDefaultShell() string {
	return "sh"
}

// findChromiumExecutable locates a Chromium-based browser to drive: the
// configured override, else a trusted install under /Applications or
// ~/Applications, else a PATH fallback (e.g. a Homebrew chromium), else a
// last-resort browser (see browser_candidates_data.go for why that stage
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

	// The stage order (trusted bundles, PATH, then last resort) lives in
	// browser_candidates_data.go so it can be tested off macOS.
	if p := pickDarwinBrowser(isExecutableFile, exec.LookPath); p != "" {
		return p, nil
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
