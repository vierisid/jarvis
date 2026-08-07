package webviewui

import (
	"log"
	"runtime"

	webview "github.com/webview/webview_go"
)

// RunWindow hosts a small local-HTML webview window, owning its creation,
// event loop (Run()), and teardown. The reveal-on-load hook is installed here
// (before build, per its contract); build registers bindings and sets the
// page before Run().
//
// Callers must own the process's UI loop: do not call this from the sidecar
// while the tray is running — on macOS the tray owns [NSApp run] and the
// sidecar uses its piggybacking darwin runner instead (local_webview_darwin.go).
// Standalone processes (the installer, the sidecar's pre-tray --setup mode)
// call this from the main goroutine.
// Returns false when no window could be opened, so callers can degrade to a
// non-GUI path instead of exiting silently.
func RunWindow(title string, width, height int, hint webview.Hint, build func(webview.WebView)) bool {
	runtime.LockOSThread()
	// Unlock on the way out: the sidecar's Windows --setup path returns here
	// and continues into normal startup, and leaving the main goroutine pinned
	// to one OS thread past the window's life is not intended.
	defer runtime.UnlockOSThread()
	wv := webview.New(false)
	// NOT `wv == nil`: webview.New always returns a non-nil interface value,
	// even when the underlying webview_t is NULL, so that check never fires and
	// the code proceeds to drive a NULL handle. Under -H windowsgui the symptom
	// is the installer doing nothing at all when double-clicked, with no
	// message anywhere. Window() exposes the real handle.
	if wv == nil || wv.Window() == nil {
		log.Printf("[ui] could not open %q (webview runtime missing or failed to start?)", title)
		return false
	}
	defer wv.Destroy()
	wv.SetTitle(title)
	wv.SetSize(width, height, hint)
	stop := RevealOnLoad(wv)
	// LIFO with the Destroy above: a window closed within the reveal timeout
	// must join the timeout goroutine BEFORE the engine is freed, or its
	// pending Dispatch lands on a dangling pointer.
	defer stop()
	build(wv)
	wv.Run()
	return true
}
