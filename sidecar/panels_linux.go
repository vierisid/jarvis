//go:build linux

package main

/*
#cgo pkg-config: gtk+-3.0

#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <cairo.h>

static void jarvis_panel_apply_flags(
    void* gtkwin_ptr,
    int alwaysOnTop,
    int clickThrough,
    int transparent,
    int frameless,
    int resizable
) {
    if (!gtkwin_ptr) return;
    GtkWindow* w = GTK_WINDOW(gtkwin_ptr);
    if (!GTK_IS_WINDOW(w)) return;

    if (alwaysOnTop) {
        gtk_window_set_keep_above(w, TRUE);
        gtk_window_set_skip_taskbar_hint(w, TRUE);
        gtk_window_set_skip_pager_hint(w, TRUE);
        gtk_window_set_accept_focus(w, FALSE);
    }
    if (frameless) {
        gtk_window_set_decorated(w, FALSE);
        gtk_window_set_type_hint(w, GDK_WINDOW_TYPE_HINT_DOCK);
    }
    if (transparent) {
        GdkScreen* screen = gtk_widget_get_screen(GTK_WIDGET(w));
        if (screen) {
            GdkVisual* visual = gdk_screen_get_rgba_visual(screen);
            if (visual) {
                gtk_widget_set_visual(GTK_WIDGET(w), visual);
            }
        }
        gtk_widget_set_app_paintable(GTK_WIDGET(w), TRUE);
    }
    gtk_window_set_resizable(w, resizable ? TRUE : FALSE);

    if (clickThrough) {
        // The widget must be realized before its GdkWindow exists. webview
        // typically realizes the window before Run(); apply input shape now.
        GdkWindow* gdkw = gtk_widget_get_window(GTK_WIDGET(w));
        if (gdkw) {
            cairo_region_t* empty = cairo_region_create();
            gdk_window_input_shape_combine_region(gdkw, empty, 0, 0);
            cairo_region_destroy(empty);
        }
    }
}

static void jarvis_panel_focus(void* gtkwin_ptr) {
    if (!gtkwin_ptr) return;
    GtkWindow* w = GTK_WINDOW(gtkwin_ptr);
    if (!GTK_IS_WINDOW(w)) return;
    gtk_window_present(w);
}

// Cursor position in screen-root coords. Uses the default GdkDisplay's
// default seat → pointing device, which works on both X11 and Wayland.
static void jarvis_panel_cursor_pos(int* x, int* y) {
    GdkDisplay* display = gdk_display_get_default();
    if (!display) { *x = 0; *y = 0; return; }
    GdkSeat* seat = gdk_display_get_default_seat(display);
    if (!seat) { *x = 0; *y = 0; return; }
    GdkDevice* dev = gdk_seat_get_pointer(seat);
    if (!dev) { *x = 0; *y = 0; return; }
    int gx = 0, gy = 0;
    gdk_device_get_position(dev, NULL, &gx, &gy);
    *x = gx;
    *y = gy;
}

static void jarvis_panel_move_window(void* gtkwin_ptr, int x, int y) {
    if (!gtkwin_ptr) return;
    GtkWindow* w = GTK_WINDOW(gtkwin_ptr);
    if (!GTK_IS_WINDOW(w)) return;
    gtk_window_move(w, x, y);
    // Re-assert keep-above so the window stays on top across focus changes.
    gtk_window_set_keep_above(w, TRUE);
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func boolToCInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

func applyPlatformFlags(handle unsafe.Pointer, spec PanelSpec) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	C.jarvis_panel_apply_flags(
		handle,
		boolToCInt(spec.AlwaysOnTop),
		boolToCInt(spec.ClickThrough),
		boolToCInt(spec.Transparent),
		boolToCInt(spec.Frameless),
		boolToCInt(spec.Resizable),
	)
	return nil
}

func platformFocusWindow(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	C.jarvis_panel_focus(handle)
	return nil
}

func platformGetCursorPos() (int, int, error) {
	var x, y C.int
	C.jarvis_panel_cursor_pos(&x, &y)
	return int(x), int(y), nil
}

func platformMoveWindow(handle unsafe.Pointer, x, y int) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	C.jarvis_panel_move_window(handle, C.int(x), C.int(y))
	return nil
}
