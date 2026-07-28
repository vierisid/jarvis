//go:build linux

package main

// Native pebble overlay — Linux (GTK 3 + Cairo).
//
// W2-T12: mirrors the Windows + macOS implementations. GtkWindow with an
// RGBA visual + decorated=false + keep_above + skip_taskbar gives the
// transparent always-on-top frame; cairo_t in the draw signal renders
// the riso pebble shapes. Pango handles text layout.
//
// IMPORTANT: GTK widgets are NOT thread-safe — every call must happen on
// the main thread. The cgo bridge marshals onto the GLib main loop via
// g_idle_add. Motion + state + lifecycle live in the shared pebbleCore runtime
// (pebble_runtime.go); the frame loop runs on a separate goroutine and pushes
// each eased frame here via jarvisPebblePresent.

/*
#cgo pkg-config: gtk+-3.0

#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <cairo.h>
#include <pango/pango.h>
#include <math.h>
#include <stdlib.h>

// Monochrome Lab (Brand Book III) — mirrors pebble_draw_windows.go / pebble.css.
// The pebble is the glass "drop": translucent white body + colored radial core
// + soft glow + hairline. The state hues are the only chroma.
static const double kInkR   = 0x13/255.0, kInkG   = 0x16/255.0, kInkB   = 0x1A/255.0; // --ink
static const double kInk3R  = 0x67/255.0, kInk3G  = 0x70/255.0, kInk3B  = 0x77/255.0; // --ink3
static const double kRuleR  = 0xE2/255.0, kRuleG  = 0xE7/255.0, kRuleB  = 0xEC/255.0; // --rule
static const double kPaperR = 1.0,        kPaperG = 1.0,        kPaperB = 1.0;        // --raise
static const double kFaintR = 0x9A/255.0, kFaintG = 0xA2/255.0, kFaintB = 0xAB/255.0; // --faint
static const double kListenR = 0xE6/255.0, kListenG = 0x3B/255.0, kListenB = 0x2E/255.0; // --listen
static const double kSpeakR  = 0x2D/255.0, kSpeakG  = 0x78/255.0, kSpeakB  = 0xFF/255.0; // --speak
static const double kHoldR   = 0xEA/255.0, kHoldG   = 0xA4/255.0, kHoldB   = 0x0E/255.0; // --hold
static const double kOkR     = 0x2F/255.0, kOkG     = 0xA4/255.0, kOkB     = 0x5E/255.0; // --ok
// The awareness eye glyph reuses the brand red (was riso vermilion).
static const double kAccR = 0xE6/255.0, kAccG = 0x3B/255.0, kAccB = 0x2E/255.0;
// Drop geometry — matches pebbleDiscR / pebbleSharpR on Windows.
static const double kDropR = 13.0, kSharpR = 5.0;

static const int kWindowW = 360;
static const int kWindowH = 220;
static const double kAnchorX = 40;
static const double kAnchorY = 28;

static GtkWidget* gPebbleWindow = NULL;
static GtkWidget* gPebbleArea   = NULL;
// State + frame tick are pushed every frame by jarvisPebblePresent (the shared
// Go runtime drives motion); draw_pebble reads them. Position/easing/offset
// state moved to pebbleCore (Go) — no gCurX/gOffset/gTimer here anymore.
static int gPebbleState = 0;
static unsigned long long gFrameTick = 0;
// Awareness/answer indicators pushed each frame alongside state (§5.3): gEye =
// awareness/OCR firing, gBlinded = awareness hard-paused (struck-through eye),
// gAnswerOverflow = the speaking bubble should show the "open full" button.
static int gEye = 0;
static int gBlinded = 0;
static int gAnswerOverflow = 0;
// gPebbleBodyText is the dynamic body line (live LLM response). Owned by
// this module — replaced with g_free + g_strdup. NULL means use the
// per-state placeholder.
static gchar* gPebbleBodyText = NULL;

// draw_eye_glyph paints the awareness eye (§5.3): a lens outline + iris dot that
// pulses while awareness fires, muted + struck-through when blinded. Mirrors the
// Windows drawEyeGlyph. Drawn on top of whatever state glyph is showing.
static void draw_eye_glyph(cairo_t* cr) {
    if (!gEye && !gBlinded) return;
    double ex = kAnchorX + 14.0, ey = kAnchorY - 10.0;
    const double lensR = 4.5, irisR = 1.4;
    double r, g, b;
    if (gBlinded) { r = kInk3R; g = kInk3G; b = kInk3B; }
    else          { r = kAccR;  g = kAccG;  b = kAccB;  }

    cairo_set_source_rgba(cr, r, g, b, 220/255.0);
    cairo_set_line_width(cr, 1.0);
    cairo_arc(cr, ex, ey, lensR, 0, 2*M_PI);
    cairo_stroke(cr);

    double irisA = 220/255.0;
    if (gEye && !gBlinded) {
        int cf = 75;
        double ph = (double)(gFrameTick % cf) / cf;
        double v = ph * 2; if (v > 1) v = 2 - v;
        irisA = (178 + 77*v) / 255.0;
    }
    cairo_set_source_rgba(cr, r, g, b, irisA);
    cairo_arc(cr, ex, ey, irisR, 0, 2*M_PI);
    cairo_fill(cr);

    if (gBlinded) {
        cairo_set_source_rgba(cr, kAccR, kAccG, kAccB, 1.0);
        cairo_set_line_width(cr, 1.0);
        cairo_move_to(cr, ex - lensR - 1.5, ey + lensR + 1.5);
        cairo_line_to(cr, ex + lensR + 1.5, ey - lensR - 1.5);
        cairo_stroke(cr);
    }
}

// ── Monochrome Lab glass drop (Cairo; mirrors pebble_draw_windows.go drawDrop) ───────

// c_breathe returns a 0..1 sine over `frames` at 60fps, for state pulses.
static double c_breathe(int frames) {
    if (frames <= 0) return 1.0;
    double ph = (double)(gFrameTick % (unsigned long long)frames) / (double)frames;
    return 0.5 + 0.5 * sin(ph * 2 * M_PI);
}

// drop_path adds the brand "drop" to cr's path: a rounded square with three 50%
// corners + one sharp corner, rotated 45° (built under a rotated CTM, which is
// baked into the device-space path, then restored).
static void drop_path(cairo_t* cr, double cx, double cy, double r, double sharpR) {
    cairo_save(cr);
    cairo_translate(cr, cx, cy);
    cairo_rotate(cr, M_PI / 4.0);
    double x = -r, y = -r, w = 2*r, h = 2*r;
    double rTR = r, rBR = r, rBL = sharpR, rTL = r;
    cairo_new_sub_path(cr);
    cairo_arc(cr, x+w-rTR, y+rTR,   rTR, -M_PI/2, 0);      // top-right
    cairo_arc(cr, x+w-rBR, y+h-rBR, rBR, 0, M_PI/2);        // bottom-right
    cairo_arc(cr, x+rBL,   y+h-rBL, rBL, M_PI/2, M_PI);     // bottom-left (sharp)
    cairo_arc(cr, x+rTL,   y+rTL,   rTL, M_PI, 3*M_PI/2);   // top-left
    cairo_close_path(cr);
    cairo_restore(cr);
}

// radial_fill fills the current target (or clip) with a soft radial gradient
// (innerA at centre → 0 at rad), eased with a mid stop to mimic the Windows t*t.
static void radial_fill(cairo_t* cr, double cx, double cy, double rad,
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

// draw_drop_cairo paints the glass drop: soft glow, neutral shadow, translucent
// white glass body, a colored radial core clipped to the drop, a top-left inner
// shine, and a hairline. coreAlpha / glowAlpha are 0..1.
static void draw_drop_cairo(cairo_t* cr, double cx, double cy,
                            double dr, double dg, double db,
                            double coreAlpha, double glowAlpha) {
    // 1) outer glow.
    if (glowAlpha > 0) radial_fill(cr, cx, cy + 1, kDropR * 2.1, glowAlpha * 150.0/255.0, dr, dg, db);
    // 2) drop shadow.
    drop_path(cr, cx, cy + 2, kDropR, kSharpR);
    cairo_set_source_rgba(cr, kInkR, kInkG, kInkB, 40.0/255.0);
    cairo_fill(cr);
    // 3) glass body.
    drop_path(cr, cx, cy, kDropR, kSharpR);
    cairo_set_source_rgba(cr, 1, 1, 1, 120.0/255.0);
    cairo_fill(cr);
    // 4) colored core — radial, clipped to the drop.
    if (coreAlpha > 0) {
        cairo_save(cr);
        drop_path(cr, cx, cy, kDropR, kSharpR);
        cairo_clip(cr);
        radial_fill(cr, cx, cy, kDropR * 1.05, coreAlpha, dr, dg, db);
        cairo_restore(cr);
    }
    // 5) inner shine — top-left highlight, clipped to the drop.
    cairo_save(cr);
    drop_path(cr, cx, cy, kDropR, kSharpR);
    cairo_clip(cr);
    radial_fill(cr, cx - kDropR*0.32, cy - kDropR*0.34, kDropR*0.7, 150.0/255.0, 1, 1, 1);
    cairo_restore(cr);
    // 6) hairline border.
    drop_path(cr, cx, cy, kDropR, kSharpR);
    cairo_set_source_rgba(cr, kInkR, kInkG, kInkB, 90.0/255.0);
    cairo_set_line_width(cr, 1.0);
    cairo_stroke(cr);
}

// draw_pebble_state paints one state's drop (no eye) at the anchor. Factored
// so the offscreen harness can reuse it; reads gFrameTick for the phase.
static void draw_pebble_state(cairo_t* cr, int state) {
    double cx = kAnchorX, cy = kAnchorY;
    switch (state) {
    case 1: // listening — red drop, no bubble.
        draw_drop_cairo(cr, cx, cy, kListenR, kListenG, kListenB, 0.55 + 0.45*c_breathe(84), 0.5);
        break;
    case 3: // speaking — blue drop, no transcript.
        draw_drop_cairo(cr, cx, cy, kSpeakR, kSpeakG, kSpeakB, 0.6 + 0.4*c_breathe(96), 0.5);
        break;
    case 2: { // thinking — clear glass + orbiting white dot.
        draw_drop_cairo(cr, cx, cy, kInk3R, kInk3G, kInk3B, 0.16, 0);
        double ang = ((double)(gFrameTick % 84) / 84.0) * 2 * M_PI;
        double ox = cx + cos(ang)*kDropR*0.62, oy = cy + sin(ang)*kDropR*0.62;
        cairo_set_source_rgba(cr, 1, 1, 1, 235.0/255.0);
        cairo_arc(cr, ox, oy, 2.0, 0, 2*M_PI);
        cairo_fill(cr);
        break;
    }
    case 4: // working — steady blue.
        draw_drop_cairo(cr, cx, cy, kSpeakR, kSpeakG, kSpeakB, 0.45 + 0.35*c_breathe(144), 0.35);
        break;
    case 5: { // asking — amber + expanding ring.
        draw_drop_cairo(cr, cx, cy, kHoldR, kHoldG, kHoldB, 0.55 + 0.35*c_breathe(120), 0.4);
        double ph = (double)(gFrameTick % 120) / 120.0;
        double ringR = kDropR + ph*9.0;
        cairo_set_source_rgba(cr, kHoldR, kHoldG, kHoldB, (1.0 - ph) * 120.0/255.0);
        cairo_set_line_width(cr, 1.2);
        cairo_arc(cr, cx, cy, ringR, 0, 2*M_PI);
        cairo_stroke(cr);
        break;
    }
    case 6: // done — green flash.
        draw_drop_cairo(cr, cx, cy, kOkR, kOkG, kOkB, 0.9, 0.55);
        break;
    case 7: { // muted — gray glass + diagonal slash.
        draw_drop_cairo(cr, cx, cy, kFaintR, kFaintG, kFaintB, 0.22, 0);
        cairo_set_source_rgba(cr, kInk3R, kInk3G, kInk3B, 210.0/255.0);
        cairo_set_line_width(cr, 1.0);
        cairo_move_to(cr, cx - kDropR*0.6, cy + kDropR*0.6);
        cairo_line_to(cr, cx + kDropR*0.6, cy - kDropR*0.6);
        cairo_stroke(cr);
        break;
    }
    default: // idle — faint neutral breath.
        draw_drop_cairo(cr, cx, cy, kInk3R, kInk3G, kInk3B, 0.18 + 0.16*c_breathe(240), 0);
        break;
    }
}

static gboolean draw_pebble(GtkWidget* widget, cairo_t* cr, gpointer data) {
    // Clear to fully transparent.
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_set_source_rgba(cr, 0, 0, 0, 0);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    draw_pebble_state(cr, gPebbleState);
    draw_eye_glyph(cr);
    return FALSE;
}


// present_idle applies one frame on the GTK main thread: the shared Go runtime
// already eased the position (x,y) and bumped the frame tick; we just push
// state/tick/text and move + redraw. Bridged from the frame-loop goroutine via
// jarvisPebblePresent -> g_idle_add (GTK is main-thread only).
typedef struct {
    int x, y, state;
    unsigned long long tick;
    int eye, blinded, answerOverflow;
    gchar* text;
} PresentArgs;

static gboolean present_idle(gpointer data) {
    PresentArgs* a = (PresentArgs*)data;
    if (gPebbleWindow && gPebbleArea) {
        gPebbleState = a->state;
        gFrameTick = a->tick;
        gEye = a->eye;
        gBlinded = a->blinded;
        gAnswerOverflow = a->answerOverflow;
        if (gPebbleBodyText) { g_free(gPebbleBodyText); gPebbleBodyText = NULL; }
        if (a->text) gPebbleBodyText = g_strdup(a->text);
        gtk_window_move(GTK_WINDOW(gPebbleWindow), a->x, a->y);
        gtk_window_set_keep_above(GTK_WINDOW(gPebbleWindow), TRUE);
        gtk_widget_queue_draw(gPebbleArea);
    }
    if (a->text) g_free(a->text);
    free(a);
    return G_SOURCE_REMOVE;
}

static gboolean spawn_idle(gpointer user_data) {
    if (gPebbleWindow) return G_SOURCE_REMOVE;

    if (!gtk_init_check(NULL, NULL)) {
        g_warning("[pebble] gtk_init_check failed");
        return G_SOURCE_REMOVE;
    }

    gPebbleWindow = gtk_window_new(GTK_WINDOW_POPUP);
    gtk_window_set_default_size(GTK_WINDOW(gPebbleWindow), kWindowW, kWindowH);
    gtk_window_set_decorated(GTK_WINDOW(gPebbleWindow), FALSE);
    gtk_window_set_keep_above(GTK_WINDOW(gPebbleWindow), TRUE);
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(gPebbleWindow), TRUE);
    gtk_window_set_skip_pager_hint(GTK_WINDOW(gPebbleWindow), TRUE);
    gtk_window_set_accept_focus(GTK_WINDOW(gPebbleWindow), FALSE);
    gtk_window_set_type_hint(GTK_WINDOW(gPebbleWindow), GDK_WINDOW_TYPE_HINT_DOCK);
    gtk_widget_set_app_paintable(gPebbleWindow, TRUE);

    GdkScreen* screen = gtk_widget_get_screen(gPebbleWindow);
    GdkVisual* visual = gdk_screen_get_rgba_visual(screen);
    if (visual) gtk_widget_set_visual(gPebbleWindow, visual);

    gPebbleArea = gtk_drawing_area_new();
    gtk_widget_set_size_request(gPebbleArea, kWindowW, kWindowH);
    g_signal_connect(gPebbleArea, "draw", G_CALLBACK(draw_pebble), NULL);
    gtk_container_add(GTK_CONTAINER(gPebbleWindow), gPebbleArea);

    gtk_widget_show_all(gPebbleWindow);

    GdkWindow* gdkw = gtk_widget_get_window(gPebbleWindow);
    if (gdkw) {
        cairo_region_t* empty = cairo_region_create();
        gdk_window_input_shape_combine_region(gdkw, empty, 0, 0);
        cairo_region_destroy(empty);
    }

    // No timer here — runPebbleLoop (Go) ticks at 16ms and calls present()
    // each frame, which g_idle_add's present_idle.
    return G_SOURCE_REMOVE;
}

static gboolean close_idle(gpointer user_data) {
    if (gPebbleWindow) {
        gtk_widget_destroy(gPebbleWindow);
        gPebbleWindow = NULL;
        gPebbleArea = NULL;
    }
    if (gPebbleBodyText) { g_free(gPebbleBodyText); gPebbleBodyText = NULL; }
    return G_SOURCE_REMOVE;
}

// jarvisPebbleSpawn creates the window only — the shared Go loop drives motion
// + repaint via jarvisPebblePresent.
void jarvisPebbleSpawn(void) {
    g_idle_add(spawn_idle, NULL);
}

// jarvisPebblePresent pushes one eased frame from the Go runtime. text may be
// NULL/empty (draw_pebble falls back to the per-state placeholder).
void jarvisPebblePresent(int x, int y, int state, unsigned long long tick,
                         int eye, int blinded, int answerOverflow, const char* text) {
    PresentArgs* a = (PresentArgs*)malloc(sizeof(PresentArgs));
    a->x = x; a->y = y; a->state = state; a->tick = tick;
    a->eye = eye; a->blinded = blinded; a->answerOverflow = answerOverflow;
    a->text = (text && *text) ? g_strdup(text) : NULL;
    g_idle_add(present_idle, a);
}

void jarvisPebbleClose(void) {
    g_idle_add(close_idle, NULL);
}
*/
import "C"

import (
	"log"
	"sync/atomic"
	"unsafe"
)

// pebbleServiceLinux is the GTK adapter for the shared pebbleCore runtime
// (pebble_runtime.go). The shared loop owns motion + state + lifecycle; this
// file owns only the native window + drawing (the cgo block above) and bridges
// each frame onto the GTK main loop.
type pebbleServiceLinux struct {
	pebbleCore
	summonCallback    atomic.Value // func(); re-assigned per reconnect, read by the hotkey goroutine
	paletteCallback   atomic.Value // func()
	hotkeyStop        func()       // summon hotkey listener stop
	paletteHotkeyStop func()       // palette hotkey listener stop
}

func NewPebbleService() PebbleService {
	// The GLib main loop runs on its own goroutine (gtk_main blocks, dispatching
	// the g_idle_add callbacks). The shared frame loop (runPebbleLoop) runs on a
	// separate thread and bridges to GTK via g_idle_add — GTK is main-thread only.
	s := &pebbleServiceLinux{}
	s.state.Store(PebbleIdle)
	s.bubbleText.Store("")
	// Start (once) the shared process-wide GTK main loop that also drives the
	// sub-pebble + region overlays. The shared frame loop (runPebbleLoop) runs on
	// a separate thread and bridges to GTK via g_idle_add — GTK is main-thread only.
	ensureGTKMain()
	return s
}

func (s *pebbleServiceLinux) Spawn(spec PebbleSpec) error {
	if !s.spawned.CompareAndSwap(false, true) {
		return nil
	}
	s.spec = spec
	if s.spec.CursorOffsetX == 0 && s.spec.CursorOffsetY == 0 {
		s.spec.CursorOffsetX, s.spec.CursorOffsetY = 22, 26
	}
	// Seed the eased position at the cursor so the pebble doesn't fly in from
	// the screen corner on the first frame.
	if cx, cy, err := platformGetCursorPos(); err == nil {
		s.curX = float64(cx + s.spec.CursorOffsetX)
		s.curY = float64(cy + s.spec.CursorOffsetY)
	}
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	go runPebbleLoop(&s.pebbleCore, s)

	// Global hotkeys (§5.4): summon (Ctrl+Space) + palette (Ctrl+K). X11 only;
	// a failed grab logs and is non-fatal (the disc click is the fallback once
	// pebble input wiring lands).
	if s.spec.SummonHotkey != "" {
		if stop, err := startHotkeyListener(s.spec.SummonHotkey, func() {
			if cb, ok := s.summonCallback.Load().(func()); ok && cb != nil {
				cb()
			}
		}); err != nil {
			log.Printf("[pebble] summon hotkey %q not registered: %v", s.spec.SummonHotkey, err)
		} else {
			s.hotkeyStop = stop
			log.Printf("[pebble] summon hotkey %q registered", s.spec.SummonHotkey)
		}
	}
	if s.spec.PaletteHotkey != "" {
		if stop, err := startHotkeyListener(s.spec.PaletteHotkey, func() {
			if cb, ok := s.paletteCallback.Load().(func()); ok && cb != nil {
				cb()
			}
		}); err != nil {
			log.Printf("[pebble] palette hotkey %q not registered: %v", s.spec.PaletteHotkey, err)
		} else {
			s.paletteHotkeyStop = stop
			log.Printf("[pebble] palette hotkey %q registered", s.spec.PaletteHotkey)
		}
	}
	return nil
}

// ─── pebblePlatform primitives (all GTK work marshals to the main loop) ──────

func (s *pebbleServiceLinux) createWindow() error { C.jarvisPebbleSpawn(); return nil }
func (s *pebbleServiceLinux) pumpMessages()       {} // gtk_main pumps for us

func (s *pebbleServiceLinux) present() error {
	// advanceFrame() already eased + published renderedX/renderedY + frameTick.
	state, _ := s.state.Load().(PebbleState)
	text, _ := s.bubbleText.Load().(string)
	var cstr *C.char
	if text != "" {
		cstr = C.CString(text)
		defer C.free(unsafe.Pointer(cstr))
	}
	answerID, _ := s.answerOverflowID.Load().(string)
	C.jarvisPebblePresent(
		C.int(s.renderedX.Load()), C.int(s.renderedY.Load()),
		C.int(pebbleStateToInt(state)), C.ulonglong(s.frameTick),
		boolToCInt(s.eyeActive.Load()), boolToCInt(s.blinded.Load()),
		boolToCInt(answerID != ""), cstr,
	)
	return nil
}

func (s *pebbleServiceLinux) destroyWindow() { C.jarvisPebbleClose() }

func (s *pebbleServiceLinux) Close() error {
	if !s.spawned.CompareAndSwap(true, false) {
		return nil
	}
	if s.hotkeyStop != nil {
		s.hotkeyStop()
		s.hotkeyStop = nil
	}
	if s.paletteHotkeyStop != nil {
		s.paletteHotkeyStop()
		s.paletteHotkeyStop = nil
	}
	close(s.stopCh)
	<-s.doneCh
	return nil
}

// SetState / SetText / PointAt / SetEye / SetBlinded / SetAnswerOverflow are
// promoted from the embedded pebbleCore (pebble_runtime.go); present() pushes
// the state to the renderer each frame. draw_pebble now renders
// idle/listening/thinking/speaking/working + bubble text + the eye / blinded
// strike / answer-overflow button (§5.3). The pointing label is already handled
// (PointAt sets state=listening + bubbleText=label).

func (s *pebbleServiceLinux) OnSummon(callback func())  { s.summonCallback.Store(callback) }
func (s *pebbleServiceLinux) OnPalette(callback func()) { s.paletteCallback.Store(callback) }

// OnBlindToggle / OnAnswerOpen — the callbacks are accepted; the summon/palette
// hotkeys fire via X11. The disc long-press (blind-toggle) and the
// answer-button click still need the pebble window to catch input (it is
// currently fully click-through); that input wiring is a documented residual
// follow-up.
func (s *pebbleServiceLinux) OnBlindToggle(callback func())      { _ = callback }
func (s *pebbleServiceLinux) OnAnswerOpen(callback func(string)) { _ = callback }
