package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

const (
	logFileName      = "sidecar.log"
	maxLogBytes      = 5 * 1024 * 1024 // rotate once the log passes ~5 MB
	rotatedLogSuffix = ".1"            // the one previous generation kept: sidecar.log.1
)

// rotateLog moves path to path+".1" once it passes limit bytes, replacing any
// older generation, so the log stays bounded.
//
// It keeps one generation instead of deleting because this runs at startup,
// and the startup that matters most is the relaunch after a crash: the
// traceback is the last thing in the old file, and deleting it here threw it
// away before anyone could read it. If the rename fails the file is removed as
// before, so a stuck rename cannot let the log grow without bound.
func rotateLog(path string, limit int64) {
	fi, err := os.Stat(path)
	if err != nil || fi.Size() <= limit {
		return
	}
	if err := os.Rename(path, path+rotatedLogSuffix); err != nil {
		_ = os.Remove(path)
	}
}

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
	rotateLog(logPath, maxLogBytes)
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	// Runtime panics never reach the log package — the runtime writes them to
	// fd 2 directly — so on Windows point the process's stderr handle at this
	// file too. Without it, a panic under -H windowsgui kills the process with
	// nothing written anywhere. When the swap succeeds os.Stderr IS f, so the
	// tee below would double-write every line.
	if redirectStderrToLog(f) {
		log.SetOutput(f)
		return
	}
	// File first so it always receives output even when stderr is a dead handle
	// (the Windows GUI subsystem has no console). MultiWriter stops on the first
	// error, so ordering matters.
	log.SetOutput(io.MultiWriter(f, os.Stderr))
}
