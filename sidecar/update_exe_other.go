//go:build !windows

package main

// moveRunningExeAside is Windows-only: elsewhere a package manager can
// replace the file of a running executable (the process keeps its inode).
func moveRunningExeAside(string) (func(), error) { return func() {}, nil }

func cleanupMovedExe(string) {}
