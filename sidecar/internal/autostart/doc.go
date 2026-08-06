// Package autostart registers (or removes) a binary as a login item for the
// current user: HKCU Run key on Windows, a LaunchAgent plist on macOS, an XDG
// autostart .desktop entry elsewhere. Shared by the sidecar (registering
// itself) and the installer/uninstaller (registering the installed sidecar,
// cleaning up on uninstall).
package autostart
