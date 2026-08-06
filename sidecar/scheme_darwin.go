//go:build darwin

package main

// The jarvis:// scheme itself is claimed by the app bundle's Info.plist
// (CFBundleURLTypes) — a bare binary cannot register one at runtime. What the
// PROCESS must do every launch is install the Apple Event handler that
// receives the opens (deeplink_darwin.go): macOS delivers URL opens to the
// running app as kAEGetURL, never argv, so the Linux/Windows argv forwarding
// path never fires here.
func registerURLSchemeHandler() {
	installURLOpenHandler()
}
