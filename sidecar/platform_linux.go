//go:build linux

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
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

func launchChromeIfNeeded(cfg *SidecarConfig) {
	port := cfg.Browser.CDPPort
	if port == 0 {
		port = 9222
	}

	// Check if Chrome is already listening
	url := fmt.Sprintf("http://localhost:%d/json/version", port)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
		return
	}

	chromePaths := []string{
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
	}

	profileDir := cfg.Browser.ProfileDir
	if profileDir == "" {
		profileDir = filepath.Join(os.TempDir(), "jarvis-chrome-profile")
	}

	for _, chromePath := range chromePaths {
		if _, err := exec.LookPath(chromePath); err != nil {
			continue
		}
		cmd := exec.Command(chromePath,
			fmt.Sprintf("--remote-debugging-port=%d", port),
			fmt.Sprintf("--user-data-dir=%s", profileDir),
			"--no-first-run",
			"about:blank",
		)
		if err := cmd.Start(); err == nil {
			log.Printf("[browser] Launched %s with CDP on port %d", chromePath, port)
			time.Sleep(2 * time.Second)
			return
		}
	}

	log.Printf("[browser] Could not launch Chrome — browser tools may not work")
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
