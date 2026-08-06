// Package webviewui holds the small webview-window plumbing shared by the
// sidecar's local pages (settings, logs, account) and the standalone
// installer: reveal-on-load and a Run()-based window host.
package webviewui

import (
	"sync"
	"sync/atomic"
	"time"

	webview "github.com/webview/webview_go"
)

// RevealOnLoad reveals a hidden window once its page fires `load` (with a
// short settle for first paint and a timeout fallback so it can never stay
// stuck hidden). The vendored webview_go is patched (on Windows) to create
// its window HIDDEN, so there's no empty-window flash during WebView2 init;
// each webview owner is then responsible for revealing the window once its
// page is ready. Must be called BEFORE SetHtml/Navigate + Run so the injected
// script applies to the loaded document.
//
// The returned stop func cancels the timeout fallback, WAITS for its
// goroutine to exit, and flags the reveal dead. The join guarantees no
// Dispatch CALL can happen after Destroy — the use-after-free a window
// closed inside the timeout used to hit. The flag covers the residue the
// join can't: when the timer wins the select race concurrently with stop,
// the closure is already posted and outlives teardown (GTK idle sources
// survive gtk_main_quit and run in the process's next main loop; the Cocoa
// main queue outlives the AppKit-released window), so show() re-checks the
// flag before touching the handle. Callers MUST invoke stop after the window
// closes and before Destroy(). stop is idempotent, and never blocks
// meaningfully: Dispatch is a non-blocking post on every platform, so the
// goroutine can't wedge between the select firing and finished closing.
func RevealOnLoad(w webview.WebView) (stop func()) {
	handle := w.Window()
	var shown atomic.Bool
	var stopped atomic.Bool
	show := func() {
		if stopped.Load() {
			return
		}
		if shown.CompareAndSwap(false, true) {
			_ = setWindowVisible(handle, true)
		}
	}
	w.Init(`(function(){try{var r=function(){if(window.__jarvis_reveal)window.__jarvis_reveal();};` +
		`if(document.readyState==='complete'){setTimeout(r,80);}` +
		`else{window.addEventListener('load',function(){setTimeout(r,80);});}}catch(e){}})();`)
	_ = w.Bind("__jarvis_reveal", func() { show() })

	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		select {
		case <-time.After(5 * time.Second):
			w.Dispatch(func() { show() })
		case <-done:
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			stopped.Store(true)
			close(done)
		})
		<-finished
	}
}
