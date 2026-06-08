package main

// Shared "reveal a hidden webview once its page loads" helper.
//
// The vendored webview_go is patched (on Windows) to create its window HIDDEN,
// so there's no empty-window flash during WebView2 init. Each webview owner is
// then responsible for revealing the window once its page is ready. This helper
// does that for the simple local-HTML windows (setup window, log viewer); the
// panels have their own reveal (with focus) inline in panels_runtime.go.

import (
	"sync/atomic"
	"time"

	webview "github.com/webview/webview_go"
)

// revealWebviewOnLoad reveals the window once its page fires `load` (with a
// short settle for first paint and a timeout fallback so it can never stay
// stuck hidden). Must be called BEFORE SetHtml/Navigate + Run so the injected
// script applies to the loaded document.
func revealWebviewOnLoad(w webview.WebView) {
	handle := w.Window()
	var shown atomic.Bool
	show := func() {
		if shown.CompareAndSwap(false, true) {
			_ = platformSetWindowVisible(handle, true)
		}
	}
	w.Init(`(function(){try{var r=function(){if(window.__jarvis_reveal)window.__jarvis_reveal();};` +
		`if(document.readyState==='complete'){setTimeout(r,80);}` +
		`else{window.addEventListener('load',function(){setTimeout(r,80);});}}catch(e){}})();`)
	_ = w.Bind("__jarvis_reveal", func() { show() })
	go func() {
		time.Sleep(5 * time.Second)
		w.Dispatch(func() { show() })
	}()
}
