//go:build !windows

package winchrome

import webview "github.com/webview/webview_go"

// Install is a no-op off Windows: macOS and Linux keep their native window
// decoration, and the page keeps its native title bar because the
// data-chrome="custom" marker is never stamped. Reports false so callers can
// tell whether custom chrome is live.
func Install(w webview.WebView) bool { return false }
