package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

const (
	logFileName = "sidecar.log"
	maxLogBytes = 5 * 1024 * 1024 // start fresh once the log passes ~5 MB
)

// setupLogging routes log output to <configDir>/sidecar.log so the sidecar can
// run without a visible console — the Windows binary is built for the GUI
// subsystem (-H windowsgui), so there is no console window and stderr goes
// nowhere. On platforms still attached to a terminal (Linux/macOS run from a
// shell) it also tees to stderr.
//
// Best-effort: any failure leaves the default stderr logging in place.
func setupLogging() {
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return
	}
	logPath := filepath.Join(configDir, logFileName)
	if fi, err := os.Stat(logPath); err == nil && fi.Size() > maxLogBytes {
		_ = os.Remove(logPath)
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	// File first so it always receives output even when stderr is a dead handle
	// (the Windows GUI subsystem has no console). MultiWriter stops on the first
	// error, so ordering matters.
	log.SetOutput(io.MultiWriter(f, os.Stderr))
}
