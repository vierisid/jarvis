//go:build linux

package main

// jarvis:// URL-scheme registration, freedesktop flavor: a NoDisplay .desktop
// entry claiming x-scheme-handler/jarvis, pointed at this binary. Idempotent
// and best-effort (called every launch, like the Windows registry setup in
// notify_windows.go — which is why Windows needs nothing here): a moved
// binary heals its registration on the next run. Browsers route jarvis://
// links here after xdg-mime records the default.

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

const schemeDesktopFile = "jarvis-sidecar-url.desktop"

func registerURLSchemeHandler() {
	exe, err := os.Executable()
	if err != nil {
		log.Printf("[deeplink] scheme registration skipped: %v", err)
		return
	}
	dir := filepath.Join(homeDir(), ".local", "share", "applications")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[deeplink] scheme registration skipped: %v", err)
		return
	}
	entry := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=Jarvis Sidecar (link handler)\n" +
		"Comment=Handles jarvis:// links from the usejarvis connect page\n" +
		"Exec=\"" + exe + "\" %u\n" +
		"NoDisplay=true\n" +
		"StartupNotify=false\n" +
		"MimeType=x-scheme-handler/jarvis;\n"
	path := filepath.Join(dir, schemeDesktopFile)
	if old, rerr := os.ReadFile(path); rerr != nil || string(old) != entry {
		if werr := os.WriteFile(path, []byte(entry), 0o644); werr != nil {
			log.Printf("[deeplink] scheme registration failed: %v", werr)
			return
		}
	}
	// Best-effort: some environments lack these tools; the MimeType= line in
	// the entry still lets desktop databases pick the handler up on rebuild.
	_ = exec.Command("xdg-mime", "default", schemeDesktopFile, "x-scheme-handler/jarvis").Run()
	_ = exec.Command("update-desktop-database", dir).Run()
}
