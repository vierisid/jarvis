//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// redirectStderrToLog points the process's STD_ERROR_HANDLE at the log file.
//
// The log package never sees a runtime panic: the Go runtime writes its
// traceback straight to fd 2, and on Windows that resolves through
// GetStdHandle(STD_ERROR_HANDLE) on EVERY write (runtime/os_windows.go
// write1). Under -H windowsgui there is no console, so that handle is dead
// and a panic — or any fatal runtime error — leaves NO trace anywhere: the
// process simply disappears while sidecar.log ends mid-sentence, which reads
// as "it crashed with no error" when in fact the error was written to a
// handle that goes nowhere.
//
// Because the runtime re-resolves the handle per write rather than caching it
// at startup, replacing it here is enough to capture tracebacks that have not
// happened yet. Returns false if the swap failed, so the caller can keep the
// normal stderr tee rather than losing output entirely.
func redirectStderrToLog(f *os.File) bool {
	if err := windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd())); err != nil {
		return false
	}
	// Keep Go-level writers (os.Stderr) pointed at the same place as the
	// runtime's fd 2, so the two cannot diverge.
	os.Stderr = f
	return true
}
