//go:build !windows && !darwin

package autostart

import (
	"fmt"
	"os"
	"path/filepath"
)

// DesktopPath returns the XDG autostart .desktop entry path. Exported so the
// uninstaller can remove it.
func DesktopPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "autostart", "jarvis-sidecar.desktop"), nil
}

// Set writes (or removes) an XDG autostart .desktop entry so exePath launches
// at login on Linux desktops. exePath is ignored when enabled is false.
func Set(exePath string, enabled bool) error {
	desktop, err := DesktopPath()
	if err != nil {
		return err
	}

	if !enabled {
		if err := os.Remove(desktop); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(desktop), 0755); err != nil {
		return err
	}
	// Quote the Exec path so a binary path containing spaces parses correctly per
	// the XDG Desktop Entry spec.
	content := fmt.Sprintf("[Desktop Entry]\n"+
		"Type=Application\n"+
		"Name=JARVIS Sidecar\n"+
		"Exec=%q\n"+
		"X-GNOME-Autostart-enabled=true\n", exePath)
	return os.WriteFile(desktop, []byte(content), 0644)
}
