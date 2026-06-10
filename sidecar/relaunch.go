package main

import (
	"os"
	"os/exec"
)

// relaunchSidecar starts a fresh copy of the sidecar executable as an
// independent process (no args, so it reads the just-saved config). The caller
// shuts the current process down afterward. The JARVIS_RELAUNCH marker tells the
// new process to wait briefly on startup so the old one releases the mic,
// hotkeys, and tray icon first. The child keeps running after this process exits
// (neither Windows nor Unix kills it on parent exit).
func relaunchSidecar() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), "JARVIS_RELAUNCH=1")
	return cmd.Start()
}
