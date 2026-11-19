//go:build !darwin

package main

// platformPermissionProbe: only macOS has a permission whose answer a running
// program cannot see change (notch_keys_darwin.go).
func platformPermissionProbe() bool { return false }
