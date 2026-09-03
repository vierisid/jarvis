package webview

/*
#include "webview.h"
*/
import "C"

import "unsafe"

// PATCHED (jarvis): expose the native browser controller.
//
// The C library has implemented webview_get_native_handle since 0.11 (see
// webview.h), but upstream's Go binding never bound it — Window() surrenders
// the HWND and nothing else. That leaves the engine's own object graph
// unreachable from Go, and with it every WebView2 setting: the library sets
// AreDevToolsEnabled and IsStatusBarEnabled inside embed() and offers no way
// to touch the rest.
//
// internal/winchrome needs exactly one of them. A window that draws its own
// title bar is trapped by a reload — the document loaded with SetHtml comes
// back as about:blank, with no strip and no caption — so it turns
// AreBrowserAcceleratorKeysEnabled off, which needs ICoreWebView2Settings3,
// which needs this pointer.
//
// A new FILE rather than a hunk in webview.go, and a free function rather than
// a method on the WebView interface: this touches no upstream source, so it
// has nothing to conflict with when the monthly bot re-vendors, and it cannot
// collide with an upstream NativeHandle of a different shape.
//
// What comes back is the platform's controller object, unretained and owned by
// the engine — ICoreWebView2Controller* on Windows, WKWebView* on macOS,
// WebKitWebView* on GTK. Callers must not Release it, and must not outlive w.
//
// nil when there is none. On Windows there always is one after a successful
// New: the jarvis patch to webview_create already refuses to build an engine
// whose browser_controller() is NULL, so a non-nil WebView means a live
// controller.
func BrowserController(w WebView) unsafe.Pointer {
	iw, ok := w.(*webview)
	if !ok || iw == nil || iw.w == nil {
		return nil
	}
	return unsafe.Pointer(C.webview_get_native_handle(iw.w, C.WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER))
}
