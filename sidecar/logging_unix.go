//go:build !windows

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// redirectStderrToLog points fd 2 at the log file when fd 2 is /dev/null.
//
// The same failure as on Windows, reached a different way. The Go runtime
// writes a panic or fatal error straight to fd 2, and a sidecar started by
// LaunchServices or the macOS login LaunchAgent (which sets no
// StandardErrorPath) gets /dev/null there, as can a desktop session's XDG
// autostart on Linux. A crash then left no trace at all: sidecar.log just
// stopped, and macOS wrote no DiagnosticReports entry either, because the
// runtime catches the signal and exits instead of dying from it.
//
// Only /dev/null is replaced. A terminal is someone watching, and a pipe or a
// journal socket is someone capturing the output on purpose (`jarvis --token`
// run from a script prints its failure there), so those keep stderr and the
// caller keeps teeing to it. When the dup succeeds, os.Stderr (still fd 2)
// lands in the file too, so the caller must stop teeing or every line doubles.
func redirectStderrToLog(f *os.File) bool {
	fd := int(os.Stderr.Fd())
	if !fdIsDevNull(fd) {
		return false
	}
	return unix.Dup2(int(f.Fd()), fd) == nil
}

// fdIsDevNull reports whether fd is open on /dev/null, by device and inode
// rather than by any path the descriptor was opened through.
func fdIsDevNull(fd int) bool {
	var got, null unix.Stat_t
	if unix.Fstat(fd, &got) != nil || unix.Stat(os.DevNull, &null) != nil {
		return false
	}
	return got.Dev == null.Dev && got.Ino == null.Ino
}
