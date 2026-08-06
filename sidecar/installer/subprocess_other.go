//go:build !windows

package main

import "os/exec"

// hideSubprocessWindow is a no-op outside Windows (no console to hide).
func hideSubprocessWindow(*exec.Cmd) {}
