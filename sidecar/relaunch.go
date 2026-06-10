package main

import (
	"os"
	"os/exec"
	"time"
)

// Restart timing. The invariant that keeps a restart clean is:
//
//	restartRelaunchWait  >  restartHealthWindow + restartHandoffDelay
//
// i.e. the NEW process must not touch the mic / global hotkeys / tray icon until
// the OLD process has fully exited and released them — otherwise the two
// contend. The old process's lifetime after spawning the replacement is
// (health window + handoff beat); the new process sleeps restartRelaunchWait
// before grabbing anything, which must be strictly longer.
const (
	// restartHealthWindow is how long the old process watches the replacement
	// before handing off; if the new one exits within it, it crashed on startup
	// and we keep the old one alive instead.
	restartHealthWindow = 300 * time.Millisecond
	// restartHandoffDelay is a brief beat after the health window so the settings
	// UI can render "Restarting…" before this process tears down.
	restartHandoffDelay = 200 * time.Millisecond
	// restartRelaunchWait is how long the NEW process sleeps on startup (gated by
	// the JARVIS_RELAUNCH marker) before initializing services. Must exceed
	// restartHealthWindow + restartHandoffDelay (see invariant above).
	restartRelaunchWait = 800 * time.Millisecond
)

// relaunchSidecar starts a fresh copy of the sidecar executable as an
// independent process (no args, so it reads the just-saved config) and returns
// the command handle so the caller can detect an immediate crash. The
// JARVIS_RELAUNCH marker makes the new process wait restartRelaunchWait on
// startup so the old one releases devices first. The child keeps running after
// this process exits (neither Windows nor Unix kills it on parent exit).
func relaunchSidecar() (*exec.Cmd, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), "JARVIS_RELAUNCH=1")
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}
