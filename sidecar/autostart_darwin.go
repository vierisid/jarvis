//go:build darwin

package main

import (
	"os"

	"github.com/jarvis/sidecar/internal/autostart"
)

// platformSetAutoStart writes (or removes) a per-user LaunchAgent plist so the
// sidecar launches at login. Logic lives in internal/autostart so the
// installer/uninstaller shares it.
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
