//go:build linux

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

func platformClipboardRead() (string, error) {
	return runCmd("xclip", []string{"-selection", "clipboard", "-o"}, "")
}

func platformClipboardWrite(content string) error {
	_, err := runCmd("xclip", []string{"-selection", "clipboard"}, content)
	return err
}

func platformCaptureScreen(outputPath string) error {
	// Try scrot, then import, then gnome-screenshot
	if _, err := runCmd("scrot", []string{outputPath}, ""); err == nil {
		return nil
	}
	if _, err := runCmd("import", []string{"-window", "root", outputPath}, ""); err == nil {
		return nil
	}
	_, err := runCmd("gnome-screenshot", []string{"-f", outputPath}, "")
	return err
}

func platformDefaultShell() string {
	return "sh"
}

// findChromiumExecutable locates a Chromium-based browser to drive: the
// configured override, else the XDG default browser if it is Chromium-based,
// else the first known install found on PATH.
func findChromiumExecutable(cfg *SidecarConfig) (string, error) {
	if p := cfg.Browser.ExecutablePath; p != "" {
		if path, err := exec.LookPath(p); err == nil {
			return path, nil
		}
		return "", fmt.Errorf("configured browser executable not found: %s", p)
	}

	var candidates []string
	if def := linuxDefaultBrowser(); def != "" {
		candidates = append(candidates, def)
	}
	candidates = append(candidates,
		"google-chrome", "google-chrome-stable",
		"chromium", "chromium-browser",
		"brave-browser", "microsoft-edge", "microsoft-edge-stable",
		"vivaldi-stable", "opera",
	)
	for _, c := range candidates {
		if path, err := exec.LookPath(c); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("no Chromium-based browser found (install Chrome, Chromium, Edge or Brave)")
}

// linuxDefaultBrowser returns the executable name of the XDG default web
// browser if it is Chromium-based, otherwise "".
func linuxDefaultBrowser() string {
	out, err := exec.Command("xdg-settings", "get", "default-web-browser").Output()
	if err != nil {
		return ""
	}
	desktop := strings.TrimSuffix(strings.TrimSpace(string(out)), ".desktop")
	switch {
	case strings.Contains(desktop, "chrome"),
		strings.Contains(desktop, "chromium"),
		strings.Contains(desktop, "brave"),
		strings.Contains(desktop, "edge"),
		strings.Contains(desktop, "vivaldi"),
		strings.Contains(desktop, "opera"):
		return desktop
	}
	return ""
}

func platformGetActiveWindow() (appName string, windowTitle string) {
	titleOut, err := exec.Command("xdotool", "getactivewindow", "getwindowname").Output()
	if err != nil {
		return "", ""
	}
	title := strings.TrimSpace(string(titleOut))

	pidOut, err := exec.Command("xdotool", "getactivewindow", "getwindowpid").Output()
	app := ""
	if err == nil {
		pid := strings.TrimSpace(string(pidOut))
		cmdOut, err := exec.Command("ps", "-p", pid, "-o", "comm=").Output()
		if err == nil {
			app = strings.TrimSpace(string(cmdOut))
		}
	}
	if app == "" {
		app = title
	}
	return app, title
}
