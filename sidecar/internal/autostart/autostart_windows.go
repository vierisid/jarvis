//go:build windows

package autostart

import "golang.org/x/sys/windows/registry"

// ValueName is the HKCU\...\Run value that points at the sidecar executable.
// Exported so the uninstaller can remove it.
const ValueName = "JarvisSidecar"

// Set registers (or removes) exePath in the per-user Windows "Run" key so it
// launches at login. exePath is ignored when enabled is false.
func Set(exePath string, enabled bool) error {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()

	if !enabled {
		if err := k.DeleteValue(ValueName); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	// Quote the path so spaces in the install dir don't break the command.
	return k.SetStringValue(ValueName, `"`+exePath+`"`)
}
