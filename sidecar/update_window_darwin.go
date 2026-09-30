//go:build darwin

package main

import webview "github.com/webview/webview_go"

// closeLocalWindow closes a runLocalWebview window from one of its bindings.
// macOS never calls Terminate under the tray's shared run loop (that would
// stop the loop, see local_webview_darwin.go): the NSWindow is closed
// instead, which fires the close watcher runLocalWebview is waiting on.
// Dispatched so the binding returns to the page before the window goes.
func closeLocalWindow(w webview.WebView) {
	w.Dispatch(func() {
		if h := w.Window(); h != nil {
			_ = platformDestroyWindow(h)
		}
	})
}
