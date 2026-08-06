package main

import (
	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/webviewui"
)

// revealWebviewOnLoad — moved to internal/webviewui (RevealOnLoad) so the
// installer binary can reuse it; this shim keeps the sidecar's webview hosts
// (settings, logs, account, hosted first-run) unchanged. See webviewui for
// the reveal/teardown contract. The panels keep their own reveal (with focus)
// inline in panels_runtime.go.
func revealWebviewOnLoad(w webview.WebView) (stop func()) {
	return webviewui.RevealOnLoad(w)
}
