//go:build windows

package main

// System registration: the HKCU uninstall entry (what puts Jarvis in
// Settings → Apps → Installed apps with a working Uninstall button), the
// Start Menu shortcut, and the uninstaller copy. All per-user — no UAC.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	displayName      = "Jarvis"
	publisherName    = "Jarvis"
	uninstallExeName = "uninstall.exe"
	startMenuLnkName = "Jarvis.lnk"
)

// registerInstall writes the uninstall key, drops the Start Menu shortcut,
// and copies this installer into the install dir as uninstall.exe.
func registerInstall(installDir, version string) error {
	exePath := filepath.Join(installDir, sidecarExeName)
	uninstallPath := filepath.Join(installDir, uninstallExeName)

	// The uninstall key comes first and the uninstaller copy is best-effort:
	// a transient sharing violation on the copy must not cost the user their
	// Add/Remove Programs entry entirely.
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKeyPath, registry.ALL_ACCESS)
	if err != nil {
		return fmt.Errorf("uninstall key: %w", err)
	}
	defer k.Close()
	setters := []error{
		k.SetStringValue("DisplayName", displayName),
		k.SetStringValue("DisplayVersion", version),
		k.SetStringValue("Publisher", publisherName),
		k.SetStringValue("DisplayIcon", exePath+",0"),
		k.SetStringValue("InstallLocation", installDir),
		k.SetStringValue("UninstallString", fmt.Sprintf(`"%s" --uninstall`, uninstallPath)),
		k.SetStringValue("QuietUninstallString", fmt.Sprintf(`"%s" --uninstall --silent`, uninstallPath)),
		k.SetDWordValue("EstimatedSize", dirSizeKB(installDir)),
		k.SetDWordValue("NoModify", 1),
		k.SetDWordValue("NoRepair", 1),
	}
	for _, err := range setters {
		if err != nil {
			return fmt.Errorf("uninstall key values: %w", err)
		}
	}

	var problems []string
	if self, err := os.Executable(); err == nil {
		if err := copyFilePreserve(self, uninstallPath); err != nil {
			problems = append(problems, fmt.Sprintf("uninstaller copy: %v", err))
		}
	}
	if err := createStartMenuShortcut(exePath, installDir); err != nil {
		problems = append(problems, fmt.Sprintf("start menu shortcut: %v", err))
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func dirSizeKB(dir string) uint32 {
	var total int64
	_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	kb := total / 1024
	if kb > int64(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(kb)
}

func startMenuLnkPath() (string, error) {
	appdata := os.Getenv("APPDATA")
	if appdata == "" {
		return "", fmt.Errorf("APPDATA is not set")
	}
	return filepath.Join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", startMenuLnkName), nil
}
