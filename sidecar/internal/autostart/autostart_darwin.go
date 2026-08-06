//go:build darwin

package autostart

import (
	"fmt"
	"os"
	"path/filepath"
)

// PlistPath returns the per-user LaunchAgent plist path. Exported so the
// uninstaller can remove it.
func PlistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", "com.jarvis.sidecar.plist"), nil
}

// Set writes (or removes) a per-user LaunchAgent plist so exePath launches at
// login. exePath is ignored when enabled is false.
func Set(exePath string, enabled bool) error {
	plist, err := PlistPath()
	if err != nil {
		return err
	}

	if !enabled {
		if err := os.Remove(plist); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(plist), 0755); err != nil {
		return err
	}
	content := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.jarvis.sidecar</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`, exePath)
	return os.WriteFile(plist, []byte(content), 0644)
}
