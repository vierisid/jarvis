//go:build !windows && !darwin

package main

// uninstallModeByDefault: no uninstaller copy is retained on other platforms.
func uninstallModeByDefault() bool { return false }
