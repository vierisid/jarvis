//go:build windows

package update

import (
	"os/exec"
	"syscall"
)

// createNoWindow is CREATE_NO_WINDOW: the child gets no console.
const createNoWindow = 0x08000000

// hideSubprocessWindow keeps a shelled-out command from flashing a console
// window. Both the installer and the sidecar are built -H windowsgui, so
// without it every powershell.exe / npm.cmd invocation pops a visible black
// console. Mirrors the sidecar's and the installer's own copies.
func hideSubprocessWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
