//go:build !windows

package main

import "os"

// redirectStderrToLog is a no-op off Windows: stderr is a live terminal when
// run from a shell, and the launchd/systemd cases already capture it. See the
// Windows implementation for why that platform needs the handle swapped.
func redirectStderrToLog(*os.File) bool { return false }
