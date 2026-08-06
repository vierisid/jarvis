//go:build darwin

package webviewui

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

static void webviewui_set_visible(void* nswindow_ptr, int visible) {
    NSWindow* w = (NSWindow*)nswindow_ptr;
    if (!w) return;
    if (visible) [w makeKeyAndOrderFront:nil]; else [w orderOut:nil];
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// setWindowVisible shows/hides an NSWindow — same semantics as the sidecar
// panels' platformSetWindowVisible. Call from the UI thread (webview bindings
// and Dispatch closures already are).
func setWindowVisible(handle unsafe.Pointer, visible bool) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	v := C.int(0)
	if visible {
		v = 1
	}
	C.webviewui_set_visible(handle, v)
	return nil
}
