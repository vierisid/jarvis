//go:build !windows && !darwin

package main

import (
	"os"

	"github.com/jarvis/sidecar/internal/autostart"
)

// platformSetAutoStart writes (or removes) an XDG autostart .desktop entry so
// the sidecar launches at login on Linux desktops. Logic lives in
// internal/autostart so the installer/uninstaller shares it.
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
