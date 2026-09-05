//go:build !windows && !darwin && !linux

package main

import webview "github.com/webview/webview_go"

// installPanelExternalNav is a no-op where no webview new-window hook is wired.
func installPanelExternalNav(wv webview.WebView) { _ = wv }
