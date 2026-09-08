//go:build !windows && !darwin && !linux

package main

import webview "github.com/webview/webview_go"

// installPanelExternalNav is a no-op where no webview new-window hook is wired.
// No new-window routing on this platform, so the page must not be told there
// is any: window.open returning null here means it genuinely failed.
func installPanelExternalNav(wv webview.WebView) bool { _ = wv; return false }
