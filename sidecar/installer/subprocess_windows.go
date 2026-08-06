//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// createNoWindow is CREATE_NO_WINDOW: the child gets no console.
const createNoWindow = 0x08000000

// hideSubprocessWindow keeps a shelled-out command from flashing a console
// window. Required because the installer is compiled -H windowsgui — without
// it every powershell.exe / taskkill.exe / npm.cmd invocation pops a visible
// black console. Mirrors the sidecar's subprocess_windows.go.
func hideSubprocessWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
