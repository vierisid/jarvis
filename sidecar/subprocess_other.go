//go:build !windows

package main

import "os/exec"

// hideSubprocessWindow is a no-op on non-Windows platforms. Subprocesses
// inherit the controlling terminal / process group normally there.
func hideSubprocessWindow(_ *exec.Cmd) {}
