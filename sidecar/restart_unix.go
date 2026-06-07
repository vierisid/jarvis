//go:build !windows

package main

import (
	"log"
	"os"
	"syscall"
)

// restartAfterSetup replaces the current process with a fresh copy of the
// sidecar (no args, so it reads the just-saved token from config).
//
// Why: the first-run setup window uses webkit2gtk (it runs gtk_main on the main
// thread). The pebble overlay then runs its OWN gtk_main on a goroutine. Two GTK
// main loops on different threads in one process is fragile, so after the window
// collects the token we re-exec into a clean process where the overlays are the
// only GTK user. syscall.Exec keeps the same PID + stdio (the terminal/log
// stream is uninterrupted) and does not return on success; on any error we fall
// through and let main() continue in-process.
func restartAfterSetup() {
	exe, err := os.Executable()
	if err != nil {
		log.Printf("[sidecar] could not resolve own path for restart (%v) — continuing in-process", err)
		return
	}
	log.Println("[sidecar] restarting with the saved token...")
	if err := syscall.Exec(exe, []string{exe}, os.Environ()); err != nil {
		log.Printf("[sidecar] restart failed (%v) — continuing in-process", err)
	}
}
