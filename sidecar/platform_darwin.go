//go:build darwin

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
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"google-chrome",
		"chromium",
	}

	profileDir := cfg.Browser.ProfileDir
	if profileDir == "" {
		profileDir = filepath.Join(os.TempDir(), "jarvis-chrome-profile")
	}

	for _, chromePath := range chromePaths {
		cmd := exec.Command(chromePath,
			fmt.Sprintf("--remote-debugging-port=%d", port),
			fmt.Sprintf("--user-data-dir=%s", profileDir),
			"--no-first-run",
			"about:blank",
		)
		if err := cmd.Start(); err == nil {
			log.Printf("[browser] Launched Chrome with CDP on port %d", port)
			time.Sleep(2 * time.Second)
			return
		}
	}

	log.Printf("[browser] Could not launch Chrome — browser tools may not work")
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
