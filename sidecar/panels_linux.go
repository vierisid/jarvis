//go:build linux

package main

/*
#cgo pkg-config: gtk+-3.0

#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <cairo.h>

// Every function here touches GTK, so it must run on the shared GTK main loop's
// thread. The Go wrappers below get it there (onGTKWindow, gtkInvokeSync).

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

	webview "github.com/webview/webview_go"
)

func boolToCInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

// Linux panels live under the one shared GTK main loop (gtk_main_linux.go),
// beside the pebble overlays. GTK may only be touched on that loop's thread,
// but the functions below are called from RPC goroutines, the cursor-follow
// goroutine, and the loop's own thread (webview bindings, Dispatch closures).
// onGTKWindow runs fn on the loop's thread (inline when already there) and
// only while the window is still alive, checked on that same thread: a call
// that queued behind Close() or the user's close button must not reach a
// freed widget.
func onGTKWindow(handle unsafe.Pointer, fn func()) error {
	if handle == nil {
		return fmt.Errorf("nil GtkWindow*")
	}
	alive := false
	if !gtkInvokeSync(func() {
		if alive = gtkWindowAlive(handle); alive {
			fn()
		}
	}) {
		return errGTKUnavailable
	}
	if !alive {
		return errPanelWindowClosed
	}
	return nil
}

// newPanelWebview creates a panel's webview on the shared loop's thread.
// Upstream's GTK engine initialises GTK and builds its widgets on whatever
// thread constructs it, so constructing it on a panel goroutine is exactly the
// two-threads-in-GTK crash. The window is tracked in the same callback, before
// anything else can run on the loop, so onGTKWindow and
// registerPanelCloseWatch always know about it. Returns nil when there is no
// loop (no display).
func newPanelWebview(debug bool) webview.WebView {
	var wv webview.WebView
	gtkInvokeSync(func() {
		wv = webview.New(debug)
		if wv == nil {
			return
		}
		win := wv.Window()
		gtkTrackWindow(win)
		// The engine shows its window as it builds it. Hide it again in this
		// same callback, before the loop can paint a blank default-size window;
		// Spawn's setup shows it once it is sized, flagged and loaded (overlays
		// right away), which is what Windows gets by creating windows hidden.
		C.jarvis_panel_set_visible(win, 0)
	})
	return wv
}

// runOnSharedUIThread runs fn on the loop's thread for uiSync (inline when
// already there) and reports that it handled the call. With no loop fn does not
// run, and there is no panel window for it to act on anyway.
func runOnSharedUIThread(fn func()) bool {
	gtkInvokeSync(fn)
	return true
}

// withPanelWindow resolves a panel's GtkWindow on the loop's thread and runs fn
// with it there. Read anywhere else, wv.Window() races the destroy handler that
// clears it, and a pointer carried across the hop could by then name a newer
// window GTK allocated at the same address. Read on the loop's thread it is nil
// for a destroyed panel and can only name that panel's own live window.
func withPanelWindow(wv webview.WebView, fn func(handle unsafe.Pointer) error) error {
	err := errGTKUnavailable
	gtkInvokeSync(func() {
		h := wv.Window()
		if h == nil {
			err = errPanelWindowClosed
			return
		}
		err = fn(h)
	})
	return err
}

// withFollowedWindow is withPanelWindow for the cursor-follow goroutine, which
// on Linux ignores the handle it captured at spawn for the same reason.
func withFollowedWindow(wv webview.WebView, _ unsafe.Pointer, fn func(handle unsafe.Pointer) error) error {
	return withPanelWindow(wv, fn)
}

func applyPlatformFlags(handle unsafe.Pointer, spec PanelSpec) error {
	return onGTKWindow(handle, func() {
		C.jarvis_panel_apply_flags(
			handle,
			boolToCInt(spec.AlwaysOnTop),
			boolToCInt(spec.ClickThrough),
			boolToCInt(spec.Transparent),
			boolToCInt(spec.Frameless),
			boolToCInt(spec.Resizable),
		)
	})
}

func platformFocusWindow(handle unsafe.Pointer) error {
	return onGTKWindow(handle, func() { C.jarvis_panel_focus(handle) })
}

func platformGetCursorPos() (int, int, error) {
	var x, y C.int
	if !gtkInvokeSync(func() { C.jarvis_panel_cursor_pos(&x, &y) }) {
		return 0, 0, errGTKUnavailable
	}
	return int(x), int(y), nil
}

func platformMoveWindow(handle unsafe.Pointer, x, y int) error {
	return onGTKWindow(handle, func() { C.jarvis_panel_move_window(handle, C.int(x), C.int(y)) })
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
	return onGTKWindow(handle, func() { C.jarvis_panel_set_click_through(handle, boolToCInt(clickThrough)) })
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
	return onGTKWindow(handle, func() { C.jarvis_panel_focus(handle) })
}

func platformDestroyWindow(handle unsafe.Pointer) error {
	return onGTKWindow(handle, func() { C.jarvis_panel_destroy(handle) })
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
	return onGTKWindow(handle, func() { C.jarvis_panel_set_window_state(handle, s) })
}

// platformWindowAlive feeds the Windows close watcher, which polls. Nothing
// needs polling here, since registerPanelCloseWatch hears GTK's destroy signal,
// so this only reports whether there is a handle at all: a panel whose setup
// found its window already gone has none, and the watcher then ends it too.
func platformWindowAlive(handle unsafe.Pointer) bool { return handle != nil }

// registerPanelCloseWatch signals impl's teardown when GTK destroys its window
// (the user's close button, or Close()). Panels run no loop of their own here,
// so nothing else would notice the window going away and the registry would
// keep a stale entry that a reopen then focuses. Spawn calls it on the loop's
// thread; if the window is already gone by then the signal fires at once.
func registerPanelCloseWatch(handle unsafe.Pointer, impl *panelImpl) {
	if impl == nil {
		return
	}
	signal := func() { impl.uiCloseOnce.Do(func() { close(impl.uiClosed) }) }
	if handle == nil {
		signal()
		return
	}
	gtkInvokeSync(func() { gtkOnWindowDestroyed(handle, signal) })
}

func platformSetWindowVisible(handle unsafe.Pointer, visible bool) error {
	return onGTKWindow(handle, func() { C.jarvis_panel_set_visible(handle, boolToCInt(visible)) })
}

func platformSetInteractiveRegions(handle unsafe.Pointer, rects []PanelRect) error {
	if len(rects) == 0 {
		// Empty region — apply via 0-count call so cairo creates the empty
		// region inside the C side.
		return onGTKWindow(handle, func() { C.jarvis_panel_set_regions(handle, nil, 0) })
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
	return onGTKWindow(handle, func() { C.jarvis_panel_set_regions(handle, &flat[0], C.int(len(rects))) })
}
