//go:build linux

package main

// Native sub-pebble overlay — Linux (GTK 3 + Cairo).
//
// Mirrors sub_pebble_overlay_windows.go on the shared sub_pebble_runtime.go
// contract: one small transparent always-on-top GTK window per background task,
// docked on the right rail, eased toward its slot by the shared runtime. This
// file implements only the subPebblePlatform primitives (window / paint / slot
// geometry / destroy) + the multi-instance SubPebbleService.
//
// GTK is main-thread only, so every widget call marshals onto the shared GTK
// main loop (gtk_main_linux.go) via g_idle_add; the per-overlay frame goroutine
// just pushes eased frames.
//
// FIRST CUT: renders the colored state disc + routes disc clicks to OnClick.
// The click-to-inspect bubble + "open full" button (Windows Phase B) are NOT
// drawn here yet — SetExpanded still records state so the API is unchanged, but
// the card + OnOpenFull wiring is a documented follow-up (mirror the bubble math
// in sub_pebble_draw_windows.go).

/*
#cgo pkg-config: gtk+-3.0

#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <cairo.h>
#include <math.h>
#include <stdlib.h>

// Go-side bridges (defined via //export in sub_pebble_bridge_linux.go). Declared
// here (declaration only — this file has C definitions, so it must not also
// define exported functions).
extern void goSubPebbleClick(unsigned long long handle, int x, int y);
extern void goSubSetMonitorRight(unsigned long long handle, int right);

// Small window; the disc is centred so it can ease to any slot. The interactive
// (click-catching) area is just the disc box — the rest stays click-through via
// the input shape.
#define SUBW 44
#define SUBH 44
#define SUB_CX 22.0
#define SUB_CY 22.0
#define SUB_HIT 16

typedef struct {
    GtkWidget*         window;
    GtkWidget*         area;
    double             r, g, b;       // accent (0..1)
    int                state;         // pebbleStateToInt
    unsigned long long tick;
    int                seedX, seedY;  // cursor at spawn (for monitor lookup)
    unsigned long long handle;        // == (uintptr)self, the Go-side key
} SubWin;

// ── Monochrome Lab mini glass drop (self-contained; the main pebble's Cairo helpers
//    live in a different cgo translation unit). ──
static void sub_drop_path(cairo_t* cr, double cx, double cy, double r, double sharpR) {
    cairo_save(cr);
    cairo_translate(cr, cx, cy);
    cairo_rotate(cr, M_PI / 4.0);
    double x = -r, y = -r, w = 2*r, h = 2*r;
    cairo_new_sub_path(cr);
    cairo_arc(cr, x+w-r,      y+r,          r,      -M_PI/2, 0);    // top-right
    cairo_arc(cr, x+w-r,      y+h-r,        r,      0, M_PI/2);      // bottom-right
    cairo_arc(cr, x+sharpR,   y+h-sharpR,   sharpR, M_PI/2, M_PI);   // bottom-left (sharp)
    cairo_arc(cr, x+r,        y+r,          r,      M_PI, 3*M_PI/2); // top-left
    cairo_close_path(cr);
    cairo_restore(cr);
}
static void sub_radial(cairo_t* cr, double cx, double cy, double rad,
                       double innerA, double rr, double gg, double bb) {
    if (innerA <= 0 || rad <= 0) return;
    cairo_pattern_t* pat = cairo_pattern_create_radial(cx, cy, 0, cx, cy, rad);
    cairo_pattern_add_color_stop_rgba(pat, 0.0, rr, gg, bb, innerA);
    cairo_pattern_add_color_stop_rgba(pat, 0.5, rr, gg, bb, innerA * 0.25);
    cairo_pattern_add_color_stop_rgba(pat, 1.0, rr, gg, bb, 0.0);
    cairo_set_source(cr, pat);
    cairo_paint(cr);
    cairo_pattern_destroy(pat);
}

static gboolean sub_draw(GtkWidget* widget, cairo_t* cr, gpointer data) {
    SubWin* sw = (SubWin*)data;
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_set_source_rgba(cr, 0, 0, 0, 0);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    const double cx = SUB_CX, cy = SUB_CY, dR = 11.5, sR = 4.5;
    double r = sw->r, g = sw->g, b = sw->b;
    if (sw->state == 6) { r = 0x2F/255.0; g = 0xA4/255.0; b = 0x5E/255.0; } // done → ok

    double core = 0.42, glow = 0.0; int spinning = 0;
    if (sw->state == 0) { core = 0.40; }                    // idle — dim glass
    else if (sw->state == 6) { core = 0.92; glow = 0.55; }  // done — bright green
    else {                                                  // active — pulse + spinner
        const int cf = 75;
        double phase = (double)(sw->tick % cf) / (double)cf;
        double v = phase * 2; if (v > 1) v = 2 - v;
        core = 0.6 + 0.4*v; glow = 0.45; spinning = 1;
    }

    if (glow > 0) sub_radial(cr, cx, cy+1, dR*2.0, glow*150.0/255.0, r, g, b);
    sub_drop_path(cr, cx, cy+2, dR, sR);
    cairo_set_source_rgba(cr, 0x13/255.0, 0x16/255.0, 0x1A/255.0, 34.0/255.0);
    cairo_fill(cr);
    sub_drop_path(cr, cx, cy, dR, sR);
    cairo_set_source_rgba(cr, 1, 1, 1, 120.0/255.0);
    cairo_fill(cr);
    cairo_save(cr); sub_drop_path(cr, cx, cy, dR, sR); cairo_clip(cr);
    sub_radial(cr, cx, cy, dR, core, r, g, b);
    cairo_restore(cr);
    cairo_save(cr); sub_drop_path(cr, cx, cy, dR, sR); cairo_clip(cr);
    sub_radial(cr, cx - dR*0.32, cy - dR*0.34, dR*0.7, 140.0/255.0, 1, 1, 1);
    cairo_restore(cr);
    sub_drop_path(cr, cx, cy, dR, sR);
    cairo_set_source_rgba(cr, 0x13/255.0, 0x16/255.0, 0x1A/255.0, 85.0/255.0);
    cairo_set_line_width(cr, 1.0);
    cairo_stroke(cr);
    if (spinning) {
        const int sf = 66;
        double ang = (double)(sw->tick % sf) / (double)sf * 2 * M_PI;
        double ox = cx + cos(ang)*dR*0.66, oy = cy + sin(ang)*dR*0.66;
        cairo_set_source_rgba(cr, 1, 1, 1, 235.0/255.0);
        cairo_arc(cr, ox, oy, 1.9, 0, 2*M_PI);
        cairo_fill(cr);
    }
    return FALSE;
}

static gboolean sub_button(GtkWidget* widget, GdkEventButton* e, gpointer data) {
    SubWin* sw = (SubWin*)data;
    if (e->button == 1) {
        // e->x/e->y are window-local; Go does the disc hit-test (shared geometry).
        goSubPebbleClick(sw->handle, (int)e->x, (int)e->y);
    }
    return TRUE;
}

static gboolean sub_create_idle(gpointer data) {
    SubWin* sw = (SubWin*)data;

    GtkWidget* win = gtk_window_new(GTK_WINDOW_POPUP);
    gtk_window_set_default_size(GTK_WINDOW(win), SUBW, SUBH);
    gtk_window_set_decorated(GTK_WINDOW(win), FALSE);
    gtk_window_set_keep_above(GTK_WINDOW(win), TRUE);
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(win), TRUE);
    gtk_window_set_skip_pager_hint(GTK_WINDOW(win), TRUE);
    gtk_window_set_accept_focus(GTK_WINDOW(win), FALSE);
    gtk_window_set_type_hint(GTK_WINDOW(win), GDK_WINDOW_TYPE_HINT_DOCK);
    gtk_widget_set_app_paintable(win, TRUE);

    GdkScreen* screen = gtk_widget_get_screen(win);
    GdkVisual* visual = gdk_screen_get_rgba_visual(screen);
    if (visual) gtk_widget_set_visual(win, visual);

    GtkWidget* area = gtk_drawing_area_new();
    gtk_widget_set_size_request(area, SUBW, SUBH);
    // The drawing area fills the window and owns the GdkWindow that receives
    // clicks, so the button mask + handler go on the area, not the toplevel.
    gtk_widget_add_events(area, GDK_BUTTON_PRESS_MASK);
    g_signal_connect(area, "draw", G_CALLBACK(sub_draw), sw);
    g_signal_connect(area, "button-press-event", G_CALLBACK(sub_button), sw);
    gtk_container_add(GTK_CONTAINER(win), area);

    sw->window = win;
    sw->area = area;
    gtk_widget_show_all(win);

    // Click-through everywhere except the disc box.
    GdkWindow* gw = gtk_widget_get_window(win);
    if (gw) {
        cairo_rectangle_int_t rect = { (int)(SUB_CX - SUB_HIT), (int)(SUB_CY - SUB_HIT), SUB_HIT*2, SUB_HIT*2 };
        cairo_region_t* reg = cairo_region_create_rectangle(&rect);
        gdk_window_input_shape_combine_region(gw, reg, 0, 0);
        cairo_region_destroy(reg);
    }

    // Resolve the monitor under the spawn cursor and hand its right edge back to
    // Go so the rail anchors to the right display (GDK is main-thread only, so
    // we query it here, not from the frame goroutine).
    GdkDisplay* d = gdk_display_get_default();
    if (d) {
        GdkMonitor* m = gdk_display_get_monitor_at_point(d, sw->seedX, sw->seedY);
        if (!m) m = gdk_display_get_primary_monitor(d);
        if (m) {
            GdkRectangle geo;
            gdk_monitor_get_geometry(m, &geo);
            goSubSetMonitorRight(sw->handle, geo.x + geo.width);
        }
    }
    return G_SOURCE_REMOVE;
}

typedef struct {
    SubWin*            sw;
    int                x, y, state;
    double             r, g, b;
    unsigned long long tick;
} SubPresent;

static gboolean sub_present_idle(gpointer data) {
    SubPresent* p = (SubPresent*)data;
    SubWin* sw = p->sw;
    if (sw && sw->window) {
        sw->r = p->r; sw->g = p->g; sw->b = p->b;
        sw->state = p->state;
        sw->tick = p->tick;
        gtk_window_move(GTK_WINDOW(sw->window), p->x, p->y);
        gtk_window_set_keep_above(GTK_WINDOW(sw->window), TRUE);
        if (sw->area) gtk_widget_queue_draw(sw->area);
    }
    free(p);
    return G_SOURCE_REMOVE;
}

static gboolean sub_destroy_idle(gpointer data) {
    SubWin* sw = (SubWin*)data;
    if (sw->window) gtk_widget_destroy(sw->window);
    free(sw);
    return G_SOURCE_REMOVE;
}

// jarvisSubCreate allocates the handle synchronously (so Go gets it back) and
// builds the GTK widgets on the main loop. seedX/seedY are the spawn cursor.
static SubWin* jarvisSubCreate(int seedX, int seedY) {
    SubWin* sw = (SubWin*)calloc(1, sizeof(SubWin));
    sw->seedX = seedX;
    sw->seedY = seedY;
    sw->handle = (unsigned long long)(uintptr_t)sw;
    g_idle_add(sub_create_idle, sw);
    return sw;
}

static void jarvisSubPresent(SubWin* sw, int x, int y, int r, int g, int b, int state, unsigned long long tick) {
    SubPresent* p = (SubPresent*)malloc(sizeof(SubPresent));
    p->sw = sw; p->x = x; p->y = y;
    p->r = r/255.0; p->g = g/255.0; p->b = b/255.0;
    p->state = state; p->tick = tick;
    g_idle_add(sub_present_idle, p);
}

static void jarvisSubDestroy(SubWin* sw) {
    if (sw) g_idle_add(sub_destroy_idle, sw);
}
*/
import "C"

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"unsafe"
)

// Disc anchor inside the small Linux overlay window (centre).
const subPebbleLinuxAnchor = 22

// Handle → entry registry so the C click bridge can resolve which sub-pebble was
// clicked (and the create idle can report its monitor). Keyed by the C SubWin*
// value (also stored in entry.hwnd).
var subPebbleByHandleLinux sync.Map // uintptr -> *subPebbleEntry

// Handle → *C.SubWin so paint/destroy reach the native window without converting
// a uintptr back to an unsafe.Pointer (which go vet flags). The C pointer is
// owned by C; storing it in Go memory is fine.
var subPebbleWinLinux sync.Map // uintptr -> *C.SubWin

// Click callback, set via OnClick. Package-global (atomic) so the //export
// bridge can reach it without holding a service reference, mirroring Windows.
var subPebbleClickCallbackLinux atomic.Value // func(id string)

type subPebbleServiceLinux struct {
	mu    sync.Mutex
	items map[string]*subPebbleEntry
}

// NewSubPebbleService returns the GTK-native multi-overlay service.
func NewSubPebbleService() SubPebbleService {
	ensureGTKMain()
	return &subPebbleServiceLinux{items: make(map[string]*subPebbleEntry)}
}

func (s *subPebbleServiceLinux) Spawn(spec SubPebbleSpec) error {
	if spec.ID == "" {
		return fmt.Errorf("sub_pebble.spawn: id is required")
	}
	s.mu.Lock()
	if _, exists := s.items[spec.ID]; exists {
		s.mu.Unlock()
		return nil // idempotent
	}
	if spec.State == "" {
		spec.State = PebbleWorking
	}
	entry := &subPebbleEntry{
		id:     spec.ID,
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
	entry.slot.Store(int32(spec.Slot))
	entry.color.Store(spec.Color)
	entry.state.Store(spec.State)
	entry.label.Store(spec.Label)
	entry.task.Store("")
	entry.result.Store("")
	// Seed the animated position from the cursor so the disc "flies out" toward
	// its slot. monitorRight is filled in once the create idle resolves the
	// display (goSubSetMonitorRight); until then slotPosition falls back.
	if cx, cy, err := platformGetCursorPos(); err == nil {
		entry.curX.Store(int32(cx - subPebbleLinuxAnchor))
		entry.curY.Store(int32(cy - subPebbleLinuxAnchor))
	}
	s.items[spec.ID] = entry
	s.mu.Unlock()

	go runSubPebbleOverlay(entry, s)
	log.Printf("[sub-pebble] spawned id=%s color=%s slot=%d state=%s", spec.ID, spec.Color, spec.Slot, spec.State)
	return nil
}

func (s *subPebbleServiceLinux) SetState(id string, state PebbleState) error {
	return s.withEntry(id, func(e *subPebbleEntry) { e.state.Store(state) })
}

func (s *subPebbleServiceLinux) SetColor(id string, color SubPebbleColor) error {
	return s.withEntry(id, func(e *subPebbleEntry) { e.color.Store(color) })
}

func (s *subPebbleServiceLinux) SetLabel(id string, label string) error {
	return s.withEntry(id, func(e *subPebbleEntry) { e.label.Store(label) })
}

func (s *subPebbleServiceLinux) SetExpanded(id string, expanded bool, agent, task, result string, elapsedS int) error {
	// State recorded for parity; the bubble card is not yet drawn on Linux (§5.2).
	return s.withEntry(id, func(e *subPebbleEntry) {
		if agent != "" {
			e.label.Store(agent)
		}
		if task != "" {
			e.task.Store(task)
		}
		e.result.Store(result)
		e.elapsedS.Store(int64(elapsedS))
		e.expanded.Store(expanded)
	})
}

func (s *subPebbleServiceLinux) withEntry(id string, fn func(*subPebbleEntry)) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("sub-pebble %q not found", id)
	}
	fn(entry)
	return nil
}

func (s *subPebbleServiceLinux) Close(id string) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	if ok {
		delete(s.items, id)
		// Slot reflow: shift every lower sub-pebble up one; each eases to its new
		// slot target over the next frames.
		closedSlot := entry.slot.Load()
		for _, other := range s.items {
			if other.slot.Load() > closedSlot {
				other.slot.Add(-1)
			}
		}
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	close(entry.stopCh)
	<-entry.doneCh
	log.Printf("[sub-pebble] closed id=%s", id)
	return nil
}

func (s *subPebbleServiceLinux) CloseAll() error {
	s.mu.Lock()
	ids := make([]string, 0, len(s.items))
	for id := range s.items {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		_ = s.Close(id)
	}
	return nil
}

func (s *subPebbleServiceLinux) OnClick(callback func(id string)) {
	subPebbleClickCallbackLinux.Store(callback)
}

// OnOpenFull — accepted but never fired yet: the "open full" button lives in the
// expand bubble, which the Linux renderer does not draw yet (§5.2).
func (s *subPebbleServiceLinux) OnOpenFull(callback func(id string)) { _ = callback }

// ─── subPebblePlatform primitives ───────────────────────────────────────────

func (s *subPebbleServiceLinux) createOverlayWindow(entry *subPebbleEntry) error {
	cx, cy := 0, 0
	if x, y, err := platformGetCursorPos(); err == nil {
		cx, cy = x, y
	}
	sw := C.jarvisSubCreate(C.int(cx), C.int(cy))
	if sw == nil {
		return fmt.Errorf("jarvisSubCreate returned nil")
	}
	entry.hwnd = uintptr(unsafe.Pointer(sw))
	subPebbleByHandleLinux.Store(entry.hwnd, entry)
	subPebbleWinLinux.Store(entry.hwnd, sw)
	return nil
}

func (s *subPebbleServiceLinux) pumpMessages() {} // shared gtk_main pumps for us

func (s *subPebbleServiceLinux) paint(entry *subPebbleEntry) error {
	v, ok := subPebbleWinLinux.Load(entry.hwnd)
	if !ok {
		return nil
	}
	sw := v.(*C.SubWin)
	entry.frameTick++
	state, _ := entry.state.Load().(PebbleState)
	color, _ := entry.color.Load().(SubPebbleColor)
	r, g, b := subPebbleRGB(color)
	C.jarvisSubPresent(
		sw,
		C.int(entry.curX.Load()), C.int(entry.curY.Load()),
		C.int(r), C.int(g), C.int(b),
		C.int(pebbleStateToInt(state)), C.ulonglong(entry.frameTick),
	)
	return nil
}

func (s *subPebbleServiceLinux) slotPosition(entry *subPebbleEntry) (int, int) {
	right := int(entry.monitorRight.Load())
	if right <= 0 {
		right = 1920 // fallback until the create idle reports the real monitor
	}
	slot := int(entry.slot.Load())
	winX := right - subPebbleRightMargin - subPebbleLinuxAnchor
	winY := subPebbleTopMargin + slot*subPebbleSlotSpacing - subPebbleLinuxAnchor
	return winX, winY
}

func (s *subPebbleServiceLinux) destroyOverlay(entry *subPebbleEntry) {
	if entry.hwnd == 0 {
		return
	}
	subPebbleByHandleLinux.Delete(entry.hwnd)
	if v, ok := subPebbleWinLinux.LoadAndDelete(entry.hwnd); ok {
		C.jarvisSubDestroy(v.(*C.SubWin))
	}
	entry.hwnd = 0
}
