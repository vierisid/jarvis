//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
)

// uninstallModeByDefault reports whether this process IS the uninstaller copy
// dropped in the install directory. The registry's UninstallString passes
// --uninstall explicitly, but a user who double-clicks uninstall.exe in
// Explorer passes nothing — without this they'd get the install wizard.
func uninstallModeByDefault() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	return strings.EqualFold(filepath.Base(exe), uninstallExeName)
}
