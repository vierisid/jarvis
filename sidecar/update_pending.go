package main

// Startup rollback for a native self-update. The hand-off's health window
// (relaunch.go) only catches a new binary that cannot be launched at all: the
// relaunched process then waits for the old one to exit before doing anything,
// so a version that crashes later in its startup would otherwise stay
// installed, with autostart relaunching it at every login. So the update
// leaves a marker, every start of the new version counts itself against it,
// and the first registration the brain acknowledges clears it. A version that
// keeps starting without ever getting that far is rolled back to the copy the
// swap kept.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"

	"github.com/jarvis/sidecar/internal/update"
)

// maxUnprovenStarts is how many starts a freshly installed version gets to
// reach the brain before it is rolled back. More than one, so a single start
// with the brain offline (and then a quit) does not undo a good update.
const maxUnprovenStarts = 3

type pendingUpdate struct {
	InstallDir string `json:"install_dir"`
	From       string `json:"from"`
	To         string `json:"to"`
	Starts     int    `json:"starts"`
}

func pendingUpdatePath() string { return filepath.Join(configDir, "update", "pending.json") }

// writePendingUpdate records a native update about to hand off.
func writePendingUpdate(installDir, from, to string) error {
	b, err := json.Marshal(pendingUpdate{InstallDir: installDir, From: from, To: to})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(pendingUpdatePath()), 0700); err != nil {
		return err
	}
	return os.WriteFile(pendingUpdatePath(), b, 0600)
}

func clearPendingUpdate() { os.Remove(pendingUpdatePath()) }

// relaunchRestored starts the restored previous version (a seam for tests).
var relaunchRestored = func(exe string) error {
	_, err := relaunchSidecar(exe)
	return err
}

// checkPendingUpdate runs early at startup. It returns true when it rolled
// back and launched the previous version, in which case this process exits.
func checkPendingUpdate() bool {
	raw, err := os.ReadFile(pendingUpdatePath())
	if err != nil {
		return false
	}
	var p pendingUpdate
	if json.Unmarshal(raw, &p) != nil || p.InstallDir == "" {
		clearPendingUpdate()
		return false
	}
	if sidecarVersion != p.To {
		// The previous version is running again (rolled back, or reinstalled
		// by hand): nothing is pending any more.
		clearPendingUpdate()
		return false
	}
	p.Starts++
	if p.Starts < maxUnprovenStarts {
		if b, err := json.Marshal(p); err == nil {
			_ = os.WriteFile(pendingUpdatePath(), b, 0600)
		}
		return false
	}
	clearPendingUpdate()
	if !update.HasOld(p.InstallDir) {
		log.Printf("[update] sidecar %s never reached the brain, but there is no previous version to restore", p.To)
		return false
	}
	log.Printf("[update] sidecar %s started %d times without reaching the brain; restoring %s", p.To, p.Starts, p.From)
	if err := update.Rollback(p.InstallDir); err != nil {
		log.Printf("[update] restoring %s failed: %v", p.From, err)
		return false
	}
	_ = update.RefreshRegistration(p.InstallDir, p.From)
	if err := relaunchRestored(update.ExecutableIn(p.InstallDir)); err != nil {
		log.Printf("[update] could not start the restored sidecar %s: %v", p.From, err)
		return false
	}
	return true
}
