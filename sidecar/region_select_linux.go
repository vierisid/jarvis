//go:build linux

package main

// Linux region-selection overlay (GTK 3 + Cairo + GdkPixbuf).
//
// Mirrors region_select_windows.go:
//   1. Snapshot the whole root window (virtual screen) BEFORE the overlay shows,
//      so the final crop doesn't include our dim/outline.
//   2. Spawn a fullscreen always-on-top overlay covering the root window. It
//      catches mouse + key events (NOT click-through).
//   3. Paint a translucent dim; while dragging, clear the selection rect (live
//      screen shows through) and stroke a vermilion outline.
//   4. On mouse-up, hand the drag corners to Go (shared normalizeRegionRect /
//      regionDragTooSmall), crop the snapshot, PNG-encode, fire onCapture. On
//      Esc / right-click / zero-area drag, fire onCancel.
//
// All GTK/GDK work runs on the shared gtk_main loop (gtk_main_linux.go). The
// event handlers themselves run on that loop, so goRegionFinish/goRegionCancel
// (called from them) are already main-thread and may call the crop/close C
// helpers directly.

/*
#cgo pkg-config: gtk+-3.0

#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <cairo.h>
#include <stdlib.h>
#include <string.h>

extern void goRegionFinish(int x0, int y0, int x1, int y1);
extern void goRegionCancel(void);

// Riso vermilion outline (matches the Windows accent).
#define REG_ACC_R (194.0/255.0)
#define REG_ACC_G (58.0/255.0)
#define REG_ACC_B (42.0/255.0)

static GtkWidget*  gRegionWin   = NULL;
static GtkWidget*  gRegionArea  = NULL;
static GdkPixbuf*  gRegionShot  = NULL;
static int         gRegW = 0, gRegH = 0;
static gboolean    gDragging = FALSE;
static int         gSx = 0, gSy = 0, gCx = 0, gCy = 0;

static gboolean region_draw(GtkWidget* widget, cairo_t* cr, gpointer data) {
    // Translucent dim over everything (~43%).
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
    cairo_set_source_rgba(cr, 30/255.0, 30/255.0, 30/255.0, 0.43);
    cairo_paint(cr);

    if (gDragging) {
        int x0 = gSx, y0 = gSy, x1 = gCx, y1 = gCy;
        if (x1 < x0) { int t = x0; x0 = x1; x1 = t; }
        if (y1 < y0) { int t = y0; y0 = y1; y1 = t; }
        // Clear the selection interior so the live screen shows through.
        cairo_save(cr);
        cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
        cairo_set_source_rgba(cr, 0, 0, 0, 0);
        cairo_rectangle(cr, x0, y0, x1 - x0, y1 - y0);
        cairo_fill(cr);
        cairo_restore(cr);
        // Vermilion hairline outline.
        cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
        cairo_set_source_rgba(cr, REG_ACC_R, REG_ACC_G, REG_ACC_B, 1.0);
        cairo_set_line_width(cr, 1.5);
        cairo_rectangle(cr, x0 + 0.5, y0 + 0.5, (x1 - x0) - 1, (y1 - y0) - 1);
        cairo_stroke(cr);
    }
    return FALSE;
}

static gboolean region_button_press(GtkWidget* w, GdkEventButton* e, gpointer d) {
    if (e->button == 3) { // right-click cancels
        goRegionCancel();
        return TRUE;
    }
    if (e->button == 1) {
        gDragging = TRUE;
        gSx = (int)e->x; gSy = (int)e->y;
        gCx = (int)e->x; gCy = (int)e->y;
        gtk_widget_queue_draw(gRegionArea);
    }
    return TRUE;
}

static gboolean region_motion(GtkWidget* w, GdkEventMotion* e, gpointer d) {
    if (gDragging) {
        gCx = (int)e->x; gCy = (int)e->y;
        gtk_widget_queue_draw(gRegionArea);
    }
    return TRUE;
}

static gboolean region_button_release(GtkWidget* w, GdkEventButton* e, gpointer d) {
    if (e->button == 1 && gDragging) {
        gDragging = FALSE;
        goRegionFinish(gSx, gSy, (int)e->x, (int)e->y);
    }
    return TRUE;
}

static gboolean region_key_press(GtkWidget* w, GdkEventKey* e, gpointer d) {
    if (e->keyval == GDK_KEY_Escape) {
        goRegionCancel();
        return TRUE;
    }
    return FALSE;
}

static gboolean region_start_idle(gpointer data) {
    GdkDisplay* disp = gdk_display_get_default();
    GdkWindow* root = gdk_get_default_root_window();
    if (!root) { goRegionCancel(); return G_SOURCE_REMOVE; }
    gRegW = gdk_window_get_width(root);
    gRegH = gdk_window_get_height(root);

    // Snapshot the root window BEFORE the overlay appears.
    if (gRegionShot) { g_object_unref(gRegionShot); gRegionShot = NULL; }
    gRegionShot = gdk_pixbuf_get_from_window(root, 0, 0, gRegW, gRegH);

    GtkWidget* win = gtk_window_new(GTK_WINDOW_POPUP);
    gtk_window_set_decorated(GTK_WINDOW(win), FALSE);
    gtk_window_set_keep_above(GTK_WINDOW(win), TRUE);
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(win), TRUE);
    gtk_window_set_accept_focus(GTK_WINDOW(win), TRUE);
    gtk_widget_set_app_paintable(win, TRUE);
    // Key events go to the focused toplevel; mouse events go to the drawing
    // area's GdkWindow, so masks + handlers are split accordingly.
    gtk_widget_add_events(win, GDK_KEY_PRESS_MASK);

    GdkScreen* screen = gtk_widget_get_screen(win);
    GdkVisual* visual = gdk_screen_get_rgba_visual(screen);
    if (visual) gtk_widget_set_visual(win, visual);

    GtkWidget* area = gtk_drawing_area_new();
    gtk_widget_set_size_request(area, gRegW, gRegH);
    gtk_widget_add_events(area, GDK_BUTTON_PRESS_MASK | GDK_BUTTON_RELEASE_MASK | GDK_POINTER_MOTION_MASK);
    g_signal_connect(area, "draw", G_CALLBACK(region_draw), NULL);
    gtk_container_add(GTK_CONTAINER(win), area);

    g_signal_connect(area, "button-press-event",   G_CALLBACK(region_button_press),   NULL);
    g_signal_connect(area, "button-release-event", G_CALLBACK(region_button_release), NULL);
    g_signal_connect(area, "motion-notify-event",  G_CALLBACK(region_motion),         NULL);
    g_signal_connect(win,  "key-press-event",      G_CALLBACK(region_key_press),      NULL);

    gRegionWin = win;
    gRegionArea = area;

    gtk_window_move(GTK_WINDOW(win), 0, 0);
    gtk_window_resize(GTK_WINDOW(win), gRegW, gRegH);
    gtk_widget_show_all(win);
    gtk_window_present(GTK_WINDOW(win));
    gtk_widget_grab_focus(win);

    // Crosshair cursor over the overlay.
    GdkWindow* gw = gtk_widget_get_window(win);
    if (gw && disp) {
        GdkCursor* cur = gdk_cursor_new_for_display(disp, GDK_CROSSHAIR);
        if (cur) { gdk_window_set_cursor(gw, cur); g_object_unref(cur); }
    }
    return G_SOURCE_REMOVE;
}

// jarvisRegionStart shows the overlay (called from an arbitrary goroutine).
static void jarvisRegionStart(void) {
    g_idle_add(region_start_idle, NULL);
}

// jarvisRegionClose tears the overlay down. Called from goRegionFinish/Cancel,
// which run on the GTK main thread, so it can run directly.
static void jarvisRegionClose(void) {
    if (gRegionWin) { gtk_widget_destroy(gRegionWin); gRegionWin = NULL; gRegionArea = NULL; }
    if (gRegionShot) { g_object_unref(gRegionShot); gRegionShot = NULL; }
    gDragging = FALSE;
}

// jarvisRegionCrop crops the snapshot to (x,y,w,h) and PNG-encodes it. Returns a
// g_malloc'd buffer (caller frees via g_free) and sets *outLen. NULL on failure.
static guchar* jarvisRegionCrop(int x, int y, int w, int h, int* outLen) {
    *outLen = 0;
    if (!gRegionShot) return NULL;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > gRegW) w = gRegW - x;
    if (y + h > gRegH) h = gRegH - y;
    if (w <= 0 || h <= 0) return NULL;

    GdkPixbuf* sub = gdk_pixbuf_new_subpixbuf(gRegionShot, x, y, w, h);
    if (!sub) return NULL;
    gchar* buf = NULL; gsize len = 0; GError* err = NULL;
    gboolean ok = gdk_pixbuf_save_to_buffer(sub, &buf, &len, "png", &err, NULL);
    g_object_unref(sub);
    if (!ok) { if (err) g_error_free(err); return NULL; }
    *outLen = (int)len;
    return (guchar*)buf;
}

static void jarvisRegionFree(guchar* p) { if (p) g_free(p); }
*/
import "C"

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"unsafe"
)

type regionSelectionLinux struct {
	mu        sync.Mutex
	active    atomic.Bool
	onCapture func([]byte, int, int)
	onCancel  func()
}

// Single active selection at a time — the C overlay is a process singleton, and
// the //export bridges route through this pointer.
var activeRegionLinux atomic.Pointer[regionSelectionLinux]

func NewRegionSelectionService() RegionSelectionService {
	ensureGTKMain()
	return &regionSelectionLinux{}
}

func (s *regionSelectionLinux) Start(onCapture func([]byte, int, int), onCancel func()) error {
	if !s.active.CompareAndSwap(false, true) {
		return fmt.Errorf("region selection already in progress")
	}
	s.mu.Lock()
	s.onCapture = onCapture
	s.onCancel = onCancel
	s.mu.Unlock()
	activeRegionLinux.Store(s)
	C.jarvisRegionStart()
	return nil
}

// finishCapture/cancel run on the GTK main thread (invoked from the //export
// bridges, which the C event handlers call), so the C crop/close helpers are
// safe to call directly here.

func (s *regionSelectionLinux) cancel() {
	cb := s.onCancel
	C.jarvisRegionClose()
	activeRegionLinux.Store(nil)
	s.reset()
	if cb != nil {
		cb()
	}
}

func (s *regionSelectionLinux) finish(x0, y0, x1, y1 int) {
	x, y, w, h := normalizeRegionRect(x0, y0, x1, y1)
	if regionDragTooSmall(w, h) {
		s.cancel()
		return
	}
	var outLen C.int
	ptr := C.jarvisRegionCrop(C.int(x), C.int(y), C.int(w), C.int(h), &outLen)
	if ptr == nil || outLen <= 0 {
		log.Printf("[region] crop failed")
		s.cancel()
		return
	}
	png := C.GoBytes(unsafe.Pointer(ptr), outLen)
	C.jarvisRegionFree(ptr)
	cb := s.onCapture
	C.jarvisRegionClose()
	activeRegionLinux.Store(nil)
	s.reset()
	log.Printf("[region] captured %dx%d, %d PNG bytes", w, h, len(png))
	if cb != nil {
		cb(png, w, h)
	}
}

func (s *regionSelectionLinux) reset() {
	s.mu.Lock()
	s.onCapture = nil
	s.onCancel = nil
	s.mu.Unlock()
	s.active.Store(false)
}
