//go:build !windows && !darwin

package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/jarvis/sidecar/internal/update"
)

// A freshly installed version that keeps starting without reaching the brain
// is rolled back on its third start; one that reaches it clears the marker.
func TestPendingUpdateRollsBackAfterUnprovenStarts(t *testing.T) {
	prevDir, prevVer, prevRelaunch := configDir, sidecarVersion, relaunchRestored
	t.Cleanup(func() { configDir, sidecarVersion, relaunchRestored = prevDir, prevVer, prevRelaunch })
	configDir = t.TempDir()
	sidecarVersion = "0.10.0"
	var relaunched []string
	relaunchRestored = func(exe string) error { relaunched = append(relaunched, exe); return nil }

	install, staged := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(install, "jarvis"), []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staged, "jarvis"), []byte("new"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := update.Swap(staged, install); err != nil {
		t.Fatal(err)
	}
	if err := writePendingUpdate(install, "0.9.7", "0.10.0"); err != nil {
		t.Fatal(err)
	}

	for start := 1; start < maxUnprovenStarts; start++ {
		if checkPendingUpdate() {
			t.Fatalf("rolled back on start %d", start)
		}
	}
	if !checkPendingUpdate() {
		t.Fatal("no rollback after the last unproven start")
	}
	if b, _ := os.ReadFile(filepath.Join(install, "jarvis")); string(b) != "old" {
		t.Errorf("live binary after rollback = %q, want old", b)
	}
	if len(relaunched) != 1 || relaunched[0] != update.ExecutableIn(install) {
		t.Errorf("relaunched %v", relaunched)
	}
	if _, err := os.Stat(pendingUpdatePath()); !os.IsNotExist(err) {
		t.Error("marker left behind after the rollback")
	}
}

func TestPendingUpdateClearedForOtherVersions(t *testing.T) {
	prevDir, prevVer := configDir, sidecarVersion
	t.Cleanup(func() { configDir, sidecarVersion = prevDir, prevVer })
	configDir = t.TempDir()
	sidecarVersion = "0.9.7" // the previous version is running again
	if err := writePendingUpdate(t.TempDir(), "0.9.7", "0.10.0"); err != nil {
		t.Fatal(err)
	}
	if checkPendingUpdate() {
		t.Fatal("rolled back while the previous version runs")
	}
	if _, err := os.Stat(pendingUpdatePath()); !os.IsNotExist(err) {
		t.Error("stale marker kept")
	}
}
