//go:build windows

package main

// restartAfterSetup is a no-op on Windows: the setup window and the panel
// overlays both use WebView2, which supports multiple instances in one process,
// so there is no GTK-style cross-thread main-loop conflict to avoid. We continue
// in-process after saving the token. (Windows also has no syscall.Exec.)
func restartAfterSetup() {}
