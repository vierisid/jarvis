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
