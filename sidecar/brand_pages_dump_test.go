package main

// Temporary helper: dumps the local pages to JARVIS_PAGE_DUMP_DIR for visual
// QA in a real browser. Not part of the suite (skips without the env var).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDumpBrandPages(t *testing.T) {
	dir := os.Getenv("JARVIS_PAGE_DUMP_DIR")
	if dir == "" {
		t.Skip("set JARVIS_PAGE_DUMP_DIR to dump the local pages")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	demoURL := "https://app.usejarvis.dev/connect?handshake=3KcshMk_demo_nonce_x8Qw2v0hV5uJ9pTz4rLb6nA1eYdC7fGm"
	pages := map[string]string{
		"hosted.html": hostedShellHTML,
		"hosted-browser.html": strings.Replace(hostedShellHTML, "/*__BOOT__*/",
			"window.__browserOpened(true, '"+demoURL+"');", 1),
		"hosted-err.html":           hostedShellWithError("Could not reach usejarvis. Check your connection and try again."),
		"hosted-selfhost-hint.html": hostedShellWithSelfHostHint(),
		"setup.html":                setupWindowHTML,
		"account.html":              accountShellHTML,
		"settings.html":             settingsWindowHTML,
		"logs.html":                 logViewerHTML,
	}
	for name, html := range pages {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(html), 0644); err != nil {
			t.Fatal(err)
		}
		// Force the dark tokens AND dark UA form controls (color-scheme), so
		// checkboxes/scrollbars in the dump match a real dark-OS window.
		dark := strings.ReplaceAll(html, "@media (prefers-color-scheme: dark)", "@media all")
		dark = strings.Replace(dark, "color-scheme: light dark", "color-scheme: dark", 1)
		if err := os.WriteFile(filepath.Join(dir, "dark-"+name), []byte(dark), 0644); err != nil {
			t.Fatal(err)
		}
	}
}
