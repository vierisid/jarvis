//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideSubprocessWindow makes a subprocess run without allocating a console
// window. Required when the sidecar is compiled with `-H windowsgui` (GUI
// subsystem) — without this flag, every shelled-out invocation of
// powershell.exe / cmd.exe / etc. pops a visible black console window.
//
// CREATE_NO_WINDOW (0x08000000) tells the Windows process loader to not
// allocate a console for the child. HideWindow=true is the older API path
// kept for clarity / safety.
const createNoWindow = 0x08000000

func hideSubprocessWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
