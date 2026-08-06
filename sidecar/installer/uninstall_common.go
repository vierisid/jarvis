package main

// Uninstall helpers shared by the Windows and macOS paths.

import (
	"os"
	"path/filepath"
)

// maybeRemoveConfig asks about ~/.jarvis (silent mode always keeps it) and on
// consent removes ONLY the sidecar-owned files — never the directory, which
// the brain shares (the sidecar's config.go documents the layout).
func maybeRemoveConfig(silent bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	cfgDir := filepath.Join(home, ".jarvis")
	if _, err := os.Stat(cfgDir); err != nil {
		return
	}
	if silent {
		logf("keeping %s (enrollment + settings); delete sidecar.yaml there to unenroll", cfgDir)
		return
	}
	if !confirm("Uninstall Jarvis",
		"Also delete this machine's enrollment and sidecar settings?\n\n"+
			cfgDir+"\n\nChoose No to keep them for a future reinstall.") {
		return
	}
	removeIgnoreMissing(filepath.Join(cfgDir, "sidecar.yaml"))
	removeIgnoreMissing(filepath.Join(cfgDir, "sidecar.log"))
	logf("removed sidecar enrollment + log (kept %s itself — the brain shares it)", cfgDir)
}

func removeIgnoreMissing(path string) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		logf("warning: could not remove %s: %v", path, err)
	}
}
