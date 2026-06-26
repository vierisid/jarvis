//go:build darwin

package main

import (
	"fmt"
	"os/exec"
)

func checkTerminal(cfg *SidecarConfig) string {
	shell := cfg.Terminal.DefaultShell
	if shell == "" {
		shell = "sh"
	}
	if _, err := exec.LookPath(shell); err != nil {
		return fmt.Sprintf("shell %q not found", shell)
	}
	return ""
}

func checkClipboard() string {
	// pbpaste/pbcopy are built-in on macOS
	if _, err := exec.LookPath("pbpaste"); err != nil {
		return "pbpaste not found"
	}
	return ""
}

func checkScreenshot() string {
	// screencapture is built-in on macOS
	if _, err := exec.LookPath("screencapture"); err != nil {
		return "screencapture not found"
	}
	return ""
}

func checkAwareness() string {
	// osascript is built-in on macOS
	if _, err := exec.LookPath("osascript"); err != nil {
		return "osascript not found"
	}
	return ""
}

func checkProcesses() string {
	// ps is built-in on macOS
	if _, err := exec.LookPath("ps"); err != nil {
		return "ps not found"
	}
	return ""
}

func checkNotifications() string {
	// macOS notifications live in a sandboxed NotificationCenter store with no
	// stable, unprivileged read path. Not supported until a native listener
	// lands; the observer no-ops here.
	return "notification monitoring is not supported on macOS"
}

func checkBrowser(cfg *SidecarConfig) string {
	if _, err := findChromiumExecutable(cfg); err != nil {
		return err.Error()
	}
	return ""
}

func checkDesktop() string {
	// macOS always has a display server when running GUI apps
	return ""
}
