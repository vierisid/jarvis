//go:build !windows && !darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// platformSetAutoStart writes (or removes) an XDG autostart .desktop entry so
// the sidecar launches at login on Linux desktops.
func platformSetAutoStart(enabled bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".config", "autostart")
	desktop := filepath.Join(dir, "jarvis-sidecar.desktop")

	if !enabled {
		if err := os.Remove(desktop); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	// Quote the Exec path so a binary path containing spaces parses correctly per
	// the XDG Desktop Entry spec.
	content := fmt.Sprintf("[Desktop Entry]\n"+
		"Type=Application\n"+
		"Name=JARVIS Sidecar\n"+
		"Exec=%q\n"+
		"X-GNOME-Autostart-enabled=true\n", exe)
	return os.WriteFile(desktop, []byte(content), 0644)
}
