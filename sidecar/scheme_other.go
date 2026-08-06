//go:build !linux

package main

// jarvis:// URL-scheme registration, non-Linux:
//   - Windows: already registered every startup by windowsSetupNotifications
//     (notify_windows.go writes HKCU\Software\Classes\jarvis -> this exe for
//     notification protocol activation; enroll links ride the same scheme).
//   - macOS: a bare binary cannot claim a URL scheme at runtime — the scheme
//     is declared by the .app bundle's Info.plist (CFBundleURLTypes, scheme
//     "jarvis"), owned by packaging. Nothing to do here.
func registerURLSchemeHandler() {}
