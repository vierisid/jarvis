//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// validateRemovableInstallDir is the guard between a corrupted HKCU
// InstallLocation value and `rmdir /s /q <anything>`.
func TestValidateRemovableInstallDir(t *testing.T) {
	good := t.TempDir()
	if err := os.WriteFile(filepath.Join(good, sidecarExeName), []byte("MZ"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateRemovableInstallDir(good); err != nil {
		t.Errorf("a real install dir was rejected: %v", err)
	}

	// Marker may also be the uninstaller (a partially removed install).
	onlyUninstaller := t.TempDir()
	if err := os.WriteFile(filepath.Join(onlyUninstaller, uninstallExeName), []byte("MZ"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateRemovableInstallDir(onlyUninstaller); err != nil {
		t.Errorf("dir with only the uninstaller was rejected: %v", err)
	}

	bad := map[string]string{
		"empty":         "",
		"relative":      `Programs\Jarvis`,
		"volume root":   `C:\`,
		"no marker":     t.TempDir(), // exists, but holds neither binary
		"quote":         `C:\a" & del x & "`,
		"ampersand":     `C:\a&b`,
		"pipe":          `C:\a|b`,
		"redirect":      `C:\a>b`,
		"env expansion": `C:\%TEMP%`,
	}
	for name, dir := range bad {
		if err := validateRemovableInstallDir(dir); err == nil {
			t.Errorf("%s: %q accepted for recursive deletion", name, dir)
		}
	}
}
