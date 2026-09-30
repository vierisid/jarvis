//go:build windows

package main

import (
	"fmt"
	"os"
)

// moveRunningExeAside renames the running executable to <exe>.old so a
// package manager can write the new one in its place: Windows refuses to
// overwrite or delete an executing image but does allow renaming it. The
// returned restore puts the original back after a failed update (moving any
// half-written replacement out of the way first).
func moveRunningExeAside(exe string) (restore func(), err error) {
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return nil, fmt.Errorf("could not move the running sidecar aside for the update: %w", err)
	}
	return func() {
		if _, err := os.Stat(exe); err == nil {
			failed := exe + ".failed"
			os.Remove(failed)
			if os.Rename(exe, failed) != nil {
				return // keep whatever is there rather than lose both copies
			}
		}
		_ = os.Rename(old, exe)
	}, nil
}

// cleanupMovedExe drops what moveRunningExeAside left behind once the new
// process is running (the old image is no longer executing by then).
func cleanupMovedExe(exe string) {
	os.Remove(exe + ".old")
	os.Remove(exe + ".failed")
}
