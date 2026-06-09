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

static void jarvis_panel_destroy(void* gtkwin_ptr) {
    if (!gtkwin_ptr) return;
    GtkWindow* w = GTK_WINDOW(gtkwin_ptr);
    if (!GTK_IS_WINDOW(w)) return;
    gtk_widget_destroy(GTK_WIDGET(w));
}

// 0=normal, 1=minimized, 2=maximized — matches platformSetWindowState.
static void jarvis_panel_set_window_state(void* gtkwin_ptr, int state) {
    if (!gtkwin_ptr) return;
    GtkWindow* w = GTK_WINDOW(gtkwin_ptr);
    if (!GTK_IS_WINDOW(w)) return;
    if (state == 1) {
        gtk_window_iconify(w);
    } else if (state == 2) {
        gtk_window_deiconify(w);
        gtk_window_maximize(w);
    } else {
        gtk_window_deiconify(w);
        gtk_window_unmaximize(w);
        gtk_window_present(w);
    }
}

static void jarvis_panel_set_visible(void* gtkwin_ptr, int visible) {
    if (!gtkwin_ptr) return;
    GtkWidget* w = GTK_WIDGET(gtkwin_ptr);
    if (!GTK_IS_WIDGET(w)) return;
    if (visible) gtk_widget_show(w); else gtk_widget_hide(w);
}

static void jarvis_panel_set_click_through(void* gtkwin_ptr, int clickThrough) {
    if (!gtkwin_ptr) return;
    GtkWindow* w = GTK_WINDOW(gtkwin_ptr);
    if (!GTK_IS_WINDOW(w)) return;
    GdkWindow* gdkw = gtk_widget_get_window(GTK_WIDGET(w));
    if (!gdkw) return;
    if (clickThrough) {
        cairo_region_t* empty = cairo_region_create();
        gdk_window_input_shape_combine_region(gdkw, empty, 0, 0);
        cairo_region_destroy(empty);
    } else {
        // NULL = remove input shape, restoring full clickability.
        gdk_window_input_shape_combine_region(gdkw, NULL, 0, 0);
    }
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

// rects is a flat array of 4 ints per rectangle (x, y, w, h). count is the
// rectangle count. Sets both the input shape (clicks pass through outside
// the union) and the visible shape on X11 (pixels outside aren't drawn).
static void jarvis_panel_set_regions(void* gtkwin_ptr, int* rects, int count) {
    if (!gtkwin_ptr) return;
    GtkWindow* w = GTK_WINDOW(gtkwin_ptr);
    if (!GTK_IS_WINDOW(w)) return;
    GdkWindow* gdkw = gtk_widget_get_window(GTK_WIDGET(w));
    if (!gdkw) return;
    cairo_region_t* region = cairo_region_create();
    for (int i = 0; i < count; i++) {
        cairo_rectangle_int_t rect = {
            rects[i*4],
            rects[i*4+1],
            rects[i*4+2],
            rects[i*4+3],
        };
        cairo_region_union_rectangle(region, &rect);
    }
    gdk_window_input_shape_combine_region(gdkw, region, 0, 0);
    // gtk_widget_shape_combine_region is deprecated in GTK 3.16+ but still
    // works on X11; on Wayland the visible shape is controlled differently.
    gtk_widget_shape_combine_region(GTK_WIDGET(w), region);
    cairo_region_destroy(region);
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

// platformGetWindowRect — Linux port deferred (needs gtk_window_get_position
// + gtk_window_get_size CGO bridge). Returning an error causes the poll to
// skip without spamming the daemon. W3 state persistence is Windows-first.
func platformGetWindowRect(handle unsafe.Pointer) (int, int, int, int, error) {
	return 0, 0, 0, 0, fmt.Errorf("platformGetWindowRect not implemented on linux")
}

// platformMoveWindowKeepZOrder — GTK doesn't impose a topmost reassertion
// inside platformMoveWindow, so the plain move is already z-order safe.
func platformMoveWindowKeepZOrder(handle unsafe.Pointer, x, y int) error {
	return platformMoveWindow(handle, x, y)
}

func platformSetClickThrough(handle unsafe.Pointer, clickThrough bool) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	C.jarvis_panel_set_click_through(handle, boolToCInt(clickThrough))
	return nil
}

func platformGetScreenSize() (int, int) {
	// Stub — fullscreen mode is Windows-only for now.
	return 1920, 1080
}

func platformGetVirtualScreenOrigin() (int, int) {
	return 0, 0
}

func platformReassertTopmost(handle unsafe.Pointer) error {
	if handle == nil {
		return nil
	}
	C.jarvis_panel_focus(handle)
	return nil
}

func platformDestroyWindow(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	C.jarvis_panel_destroy(handle)
	return nil
}

func platformSetWindowState(handle unsafe.Pointer, state PanelWindowState) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	var s C.int
	switch state {
	case PanelWindowMinimized:
		s = 1
	case PanelWindowMaximized:
		s = 2
	case PanelWindowNormal:
		s = 0
	default:
		return fmt.Errorf("unknown window state: %q", state)
	}
	C.jarvis_panel_set_window_state(handle, s)
	return nil
}

// platformWindowAlive — best-effort on Linux (the GTK handle can't be safely
// probed once freed). Returns true so the Windows-only close watcher is a no-op
// here; GTK's own destroy → terminate path handles cleanup.
func platformWindowAlive(handle unsafe.Pointer) bool { return handle != nil }

// registerPanelCloseWatch is macOS-only (NSWindowWillCloseNotification); the
// Windows/Linux close watcher polls platformWindowAlive instead.
func registerPanelCloseWatch(_ unsafe.Pointer, _ *panelImpl) {}

func platformSetWindowVisible(handle unsafe.Pointer, visible bool) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	v := C.int(0)
	if visible {
		v = 1
	}
	C.jarvis_panel_set_visible(handle, v)
	return nil
}

func platformSetInteractiveRegions(handle unsafe.Pointer, rects []PanelRect) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	if len(rects) == 0 {
		// Empty region — apply via 0-count call so cairo creates the empty
		// region inside the C side.
		C.jarvis_panel_set_regions(handle, nil, 0)
		return nil
	}
	flat := make([]C.int, 0, len(rects)*4)
	for _, r := range rects {
		flat = append(flat,
			C.int(r.X),
			C.int(r.Y),
			C.int(r.W),
			C.int(r.H),
		)
	}
	C.jarvis_panel_set_regions(handle, &flat[0], C.int(len(rects)))
	return nil
}
