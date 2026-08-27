package webviewui

import (
	"log"
	"runtime"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/winchrome"
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
//
// titleBar chooses between the system title bar and one the page draws itself
// (winchrome; custom is Windows-only and degrades to native elsewhere). Ask
// for winchrome.CustomTitleBar only for a window showing LOCAL html: it binds
// window controls, which a remote document must never reach.
//
// Returns false when no window could be opened, so callers can degrade to a
// non-GUI path instead of exiting silently.
func RunWindow(title string, width, height int, hint webview.Hint, titleBar winchrome.TitleBar, build func(webview.WebView)) bool {
	runtime.LockOSThread()
	// Unlock on the way out: the sidecar's Windows --setup path returns here
	// and continues into normal startup, and leaving the main goroutine pinned
	// to one OS thread past the window's life is not intended.
	defer runtime.UnlockOSThread()
	wv := webview.New(false)
	// `wv == nil` is the real guard: the vendored binding returns a nil
	// interface when webview_create returned NULL (third_party/webview_go,
	// JARVIS_PATCH.md). It MUST come first — Window() is not NULL-safe either
	// (webview_get_window dereferences the handle), so it would fault on the
	// very case being checked. It stays as a second condition for a handle
	// that is null without create having reported failure. Under -H windowsgui
	// the symptom of getting this wrong is the installer doing nothing at all
	// when double-clicked, with no message anywhere.
	if wv == nil || wv.Window() == nil {
		log.Printf("[ui] could not open %q (webview runtime missing or failed to start?)", title)
		return false
	}
	defer wv.Destroy()
	wv.SetTitle(title)
	wv.SetSize(width, height, hint)
	if titleBar == winchrome.CustomTitleBar {
		// Before RevealOnLoad and before build's SetHtml: the window is still
		// hidden, so the native bar is never composited, and the marker script
		// Install injects only reaches documents loaded after it.
		winchrome.Install(wv)
	}
	stop := RevealOnLoad(wv)
	// LIFO with the Destroy above: a window closed within the reveal timeout
	// must join the timeout goroutine BEFORE the engine is freed, or its
	// pending Dispatch lands on a dangling pointer.
	defer stop()
	build(wv)
	wv.Run()
	return true
}
