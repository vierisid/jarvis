//go:build darwin

package main

// macOS "registration" = retaining an uninstaller. There's no uninstall
// registry here; instead the installer app copies its own bundle to
// ~/Library/Application Support/Jarvis/Uninstall Jarvis.app so uninstall
// survives the DMG being ejected. Never placed inside Jarvis.app — that
// would break its codesign seal.

import (
	"os"
	"path/filepath"
	"strings"
)

const retainedUninstallerName = "Uninstall Jarvis.app"

// uninstallModeByDefault reports whether this process IS the retained
// uninstaller. Finder launches a double-clicked bundle with no arguments, so
// without this the copy would run the install wizard instead of uninstalling.
func uninstallModeByDefault() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	return filepath.Base(bundleRootOf(exe)) == retainedUninstallerName
}

func retainedUninstallerPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "Application Support", "Jarvis", retainedUninstallerName), nil
}

func registerInstall(_, _ string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Resolve our own bundle root (…/Install Jarvis.app/Contents/MacOS/install-jarvis).
	// Console builds run as a bare binary — nothing to retain then.
	bundle := bundleRootOf(exe)
	if bundle == "" {
		logf("note: running unbundled — no uninstaller retained (use jarvis-setup --uninstall)")
		return nil
	}
	dst, err := retainedUninstallerPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	os.RemoveAll(dst)
	return copyTree(bundle, dst)
}

// bundleRootOf walks up from an executable path to the enclosing .app bundle,
// returning "" when the binary doesn't live in one.
func bundleRootOf(exe string) string {
	for dir := filepath.Dir(exe); dir != "/" && dir != "."; dir = filepath.Dir(dir) {
		if strings.HasSuffix(dir, ".app") {
			return dir
		}
	}
	return ""
}
