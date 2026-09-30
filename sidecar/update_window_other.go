//go:build !darwin

package main

import webview "github.com/webview/webview_go"

// closeLocalWindow closes a runLocalWebview window from one of its bindings.
// Terminate must run on the window's own thread (it posts WM_QUIT to the
// calling thread — see panels_runtime.go), which Dispatch guarantees; Run
// then returns and runLocalWebview's deferred Destroy frees the window.
func closeLocalWindow(w webview.WebView) {
	w.Dispatch(w.Terminate)
}
