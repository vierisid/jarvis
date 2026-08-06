//go:build !windows && !darwin

package main

// registerInstall has real work only on Windows (uninstall registry entry,
// Start Menu) and macOS (retained uninstaller).
func registerInstall(string, string) error { return nil }
