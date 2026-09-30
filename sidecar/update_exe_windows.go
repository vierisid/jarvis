//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// asideDir is where the running exe is parked during a package-manager
// update: outside the package tree, because npm and bun replace the whole
// package directory, which Windows refuses while an image inside it is still
// mapped. Same volume as the profile in the common case, so the move is a
// rename (allowed for a running exe).
func asideDir() string { return filepath.Join(configDir, "update") }

// moveRunningExeAside moves the running executable out of the package tree
// so a package manager can replace it: Windows refuses to overwrite or delete
// an executing image but does allow moving it. When the profile sits on
// another volume (the move would be a copy), it falls back to renaming it in
// place. The returned restore puts the original back after a failed update,
// moving any half-written replacement out of the way first.
func moveRunningExeAside(exe string) (restore func(), err error) {
	aside := ""
	if err := os.MkdirAll(asideDir(), 0700); err == nil {
		candidate := filepath.Join(asideDir(), fmt.Sprintf("jarvis-%d.exe.old", os.Getpid()))
		os.Remove(candidate)
		if os.Rename(exe, candidate) == nil {
			aside = candidate
		}
	}
	if aside == "" {
		aside = exe + ".old"
		os.Remove(aside)
		if err := os.Rename(exe, aside); err != nil {
			return nil, fmt.Errorf("could not move the running sidecar aside for the update: %w", err)
		}
	}
	return func() {
		if _, err := os.Stat(exe); err == nil {
			failed := fmt.Sprintf("%s.failed-%d", exe, time.Now().UnixNano())
			if os.Rename(exe, failed) != nil {
				return // keep whatever is there rather than lose both copies
			}
		}
		_ = os.Rename(aside, exe)
	}, nil
}

// cleanupMovedExe drops what moveRunningExeAside left behind once the new
// process is running (the old image is no longer executing by then). A copy
// still in use is skipped silently and goes on a later start.
func cleanupMovedExe(exe string) {
	os.Remove(exe + ".old")
	if leftovers, err := filepath.Glob(exe + ".failed-*"); err == nil {
		for _, f := range leftovers {
			os.Remove(f)
		}
	}
	if parked, err := filepath.Glob(filepath.Join(asideDir(), "jarvis-*.exe.old")); err == nil {
		for _, f := range parked {
			os.Remove(f)
		}
	}
}
