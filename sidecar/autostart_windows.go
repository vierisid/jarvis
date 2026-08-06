//go:build windows

package main

import (
	"os"

	"github.com/jarvis/sidecar/internal/autostart"
)

// platformSetAutoStart registers (or removes) this executable in the per-user
// Windows "Run" key so it launches at login. Logic lives in internal/autostart
// so the installer/uninstaller shares it.
func platformSetAutoStart(enabled bool) error {
	exe := ""
	if enabled {
		var err error
		exe, err = os.Executable()
		if err != nil {
			return err
		}
	}
	return autostart.Set(exe, enabled)
}
