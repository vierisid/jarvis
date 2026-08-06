//go:build !windows

package webview2

// Ensure is Windows-only; webview backends elsewhere (WebKitGTK, WKWebView)
// ship with the OS or are package-manager dependencies.
func Ensure() bool { return true }

// Installed mirrors Ensure on non-Windows platforms.
func Installed() bool { return true }
