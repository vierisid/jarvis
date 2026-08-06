//go:build linux

package webviewui

/*
#cgo pkg-config: gtk+-3.0

#include <gtk/gtk.h>

static void webviewui_set_visible(void* gtkwin_ptr, int visible) {
    if (!gtkwin_ptr || !GTK_IS_WIDGET(gtkwin_ptr)) return;
    GtkWidget* w = GTK_WIDGET(gtkwin_ptr);
    if (visible) gtk_widget_show(w); else gtk_widget_hide(w);
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// setWindowVisible shows/hides a GtkWindow — same semantics as the sidecar
// panels' platformSetWindowVisible. Call from the UI thread (webview bindings
// and Dispatch closures already are).
func setWindowVisible(handle unsafe.Pointer, visible bool) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	v := C.int(0)
	if visible {
		v = 1
	}
	C.webviewui_set_visible(handle, v)
	return nil
}
