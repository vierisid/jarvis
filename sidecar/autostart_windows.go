//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows/registry"
)

// autoStartValueName is the HKCU\...\Run value that points at this executable.
const autoStartValueName = "JarvisSidecar"

// platformSetAutoStart registers (or removes) the sidecar in the per-user
// Windows "Run" key so it launches at login.
func platformSetAutoStart(enabled bool) error {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()

	if !enabled {
		if err := k.DeleteValue(autoStartValueName); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Quote the path so spaces in the install dir don't break the command.
	return k.SetStringValue(autoStartValueName, `"`+exe+`"`)
}
