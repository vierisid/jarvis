//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
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
	if _, err := exec.LookPath("xclip"); err == nil {
		return ""
	}
	if _, err := exec.LookPath("xsel"); err == nil {
		return ""
	}
	return "xclip or xsel not found"
}

func checkScreenshot() string {
	for _, tool := range []string{"scrot", "import", "gnome-screenshot"} {
		if _, err := exec.LookPath(tool); err == nil {
			return ""
		}
	}
	return "no screenshot tool found (need scrot, import, or gnome-screenshot)"
}

func checkAwareness() string {
	reasons := []string{}
	if r := checkScreenshot(); r != "" {
		reasons = append(reasons, r)
	}
	if _, err := exec.LookPath("xdotool"); err != nil {
		reasons = append(reasons, "xdotool not found (needed for window tracking)")
	}
	if len(reasons) > 0 {
		return strings.Join(reasons, "; ")
	}
	return ""
}

func checkBrowser(cfg *SidecarConfig) string {
	for _, bin := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
		if _, err := exec.LookPath(bin); err == nil {
			return ""
		}
	}
	return "no Chrome/Chromium browser found"
}

func checkDesktop() string {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return "no display server (DISPLAY/WAYLAND_DISPLAY not set)"
	}
	if _, err := exec.LookPath("xdotool"); err != nil {
		return "xdotool not found (required for desktop automation)"
	}
	return ""
}
