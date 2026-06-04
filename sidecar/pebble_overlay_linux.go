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
// g_idle_add. The pebble's run goroutine pumps a 60fps timer.

/*
#cgo pkg-config: gtk+-3.0

#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <cairo.h>
#include <pango/pango.h>
#include <math.h>
#include <stdlib.h>

// Riso colours.
static const double kPaperR = 245.0/255.0, kPaperG = 242.0/255.0, kPaperB = 235.0/255.0;
static const double kInkR   = 26.0/255.0,  kInkG   = 26.0/255.0,  kInkB   = 26.0/255.0;
static const double kInk3R  = 106.0/255.0, kInk3G  = 103.0/255.0, kInk3B  = 96.0/255.0;
static const double kRuleR  = 203.0/255.0, kRuleG  = 195.0/255.0, kRuleB = 178.0/255.0;
static const double kAccR   = 194.0/255.0, kAccG   = 58.0/255.0,  kAccB   = 42.0/255.0;
static const double kWarmR  = 138.0/255.0, kWarmG  = 106.0/255.0, kWarmB  = 31.0/255.0;

static const int kWindowW = 360;
static const int kWindowH = 220;
static const double kAnchorX = 40;
static const double kAnchorY = 28;

static GtkWidget* gPebbleWindow = NULL;
static GtkWidget* gPebbleArea   = NULL;
static int gPebbleState = 0;
static int gOffsetX = 22;
static int gOffsetY = 26;
static double gCurX = 0;
static double gCurY = 0;
static unsigned long long gFrameTick = 0;
static guint gTimerId = 0;
// gPebbleBodyText is the dynamic body line (live LLM response). Owned by
// this module — replaced with g_free + g_strdup. NULL means use the
// per-state placeholder.
static gchar* gPebbleBodyText = NULL;

static void rounded_rect(cairo_t* cr, double x, double y, double w, double h, double r) {
    cairo_new_sub_path(cr);
    cairo_arc(cr, x+w-r, y+r,   r, -M_PI/2, 0);
    cairo_arc(cr, x+w-r, y+h-r, r, 0, M_PI/2);
    cairo_arc(cr, x+r,   y+h-r, r, M_PI/2, M_PI);
    cairo_arc(cr, x+r,   y+r,   r, M_PI, 3*M_PI/2);
    cairo_close_path(cr);
}

static void draw_text_layout(cairo_t* cr, double x, double y, const char* text,
                              const char* font_desc, double r, double g, double b) {
    PangoLayout* layout = pango_cairo_create_layout(cr);
    pango_layout_set_text(layout, text, -1);
    PangoFontDescription* desc = pango_font_description_from_string(font_desc);
    pango_layout_set_font_description(layout, desc);
    pango_font_description_free(desc);
    cairo_set_source_rgba(cr, r, g, b, 1.0);
    cairo_move_to(cr, x, y);
    pango_cairo_show_layout(cr, layout);
    g_object_unref(layout);
}

// draw_text_wrapped renders multi-line body copy inside (x,y,w,h). Pango
// handles word wrapping. Used for the bubble body where transcripts can
// overflow a single line.
static void draw_text_wrapped(cairo_t* cr, double x, double y, double w, double h,
                              const char* text, const char* font_desc,
                              double r, double g, double b) {
    PangoLayout* layout = pango_cairo_create_layout(cr);
    pango_layout_set_text(layout, text, -1);
    PangoFontDescription* desc = pango_font_description_from_string(font_desc);
    pango_layout_set_font_description(layout, desc);
    pango_font_description_free(desc);
    pango_layout_set_width(layout, (int)(w * PANGO_SCALE));
    pango_layout_set_height(layout, (int)(h * PANGO_SCALE));
    pango_layout_set_wrap(layout, PANGO_WRAP_WORD_CHAR);
    pango_layout_set_ellipsize(layout, PANGO_ELLIPSIZE_END);
    cairo_set_source_rgba(cr, r, g, b, 1.0);
    cairo_move_to(cr, x, y);
    pango_cairo_show_layout(cr, layout);
    g_object_unref(layout);
}

// measure_text_height returns the wrapped height (px) the body text needs
// at the given inner width + font. Mirrors Win32 DT_CALCRECT / Cocoa
// boundingRectWithSize so the bubble can auto-fit identically across OSes.
static int measure_text_height(cairo_t* cr, double w, const char* text, const char* font_desc) {
    PangoLayout* layout = pango_cairo_create_layout(cr);
    pango_layout_set_text(layout, text, -1);
    PangoFontDescription* desc = pango_font_description_from_string(font_desc);
    pango_layout_set_font_description(layout, desc);
    pango_font_description_free(desc);
    pango_layout_set_width(layout, (int)(w * PANGO_SCALE));
    pango_layout_set_wrap(layout, PANGO_WRAP_WORD_CHAR);
    int pw = 0, ph = 0;
    pango_layout_get_pixel_size(layout, &pw, &ph);
    g_object_unref(layout);
    return ph;
}

static gboolean draw_pebble(GtkWidget* widget, cairo_t* cr, gpointer data) {
    // Clear to fully transparent.
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_set_source_rgba(cr, 0, 0, 0, 0);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    double cx = kAnchorX, cy = kAnchorY;
    double phase4s     = (double)(gFrameTick % 240) / 240.0;
    double phaseListen = (double)(gFrameTick % 57)  / 57.0;
    double phaseThink  = (double)(gFrameTick % 78)  / 78.0;
    double phaseWork   = (double)(gFrameTick % 96)  / 96.0;

    if (gPebbleState == 0) {
        const double discR = 8.0, dotR = 2.0, shadowOffset = 2.0;
        // shadow
        cairo_set_source_rgba(cr, kInkR, kInkG, kInkB, 0.10);
        cairo_arc(cr, cx+shadowOffset, cy+shadowOffset, discR, 0, 2*M_PI);
        cairo_fill(cr);
        // disc
        cairo_set_source_rgba(cr, kPaperR, kPaperG, kPaperB, 1.0);
        cairo_arc(cr, cx, cy, discR, 0, 2*M_PI);
        cairo_fill(cr);
        // border
        cairo_set_source_rgba(cr, kRuleR, kRuleG, kRuleB, 1.0);
        cairo_set_line_width(cr, 1.0);
        cairo_arc(cr, cx, cy, discR, 0, 2*M_PI);
        cairo_stroke(cr);
        // breathing dot
        double breathe = 0.5 + 0.5*sin(phase4s * 2 * M_PI);
        double dotAlpha = 0.5 + 0.5*breathe;
        cairo_set_source_rgba(cr, kInk3R, kInk3G, kInk3B, dotAlpha);
        cairo_arc(cr, cx, cy, dotR, 0, 2*M_PI);
        cairo_fill(cr);
        return FALSE;
    }

    if (gPebbleState == 1 || gPebbleState == 3) {
        gboolean speaking = (gPebbleState == 3);
        double pillW = 36, pillH = 9, shadowOffset = 2;
        double bgR  = speaking ? kInkR  : kPaperR;
        double bgG  = speaking ? kInkG  : kPaperG;
        double bgB  = speaking ? kInkB  : kPaperB;
        double brR  = speaking ? kInkR  : kAccR;
        double brG  = speaking ? kInkG  : kAccG;
        double brB  = speaking ? kInkB  : kAccB;
        double barR = speaking ? kPaperR : kAccR;
        double barG = speaking ? kPaperG : kAccG;
        double barB = speaking ? kPaperB : kAccB;

        // pill shadow
        rounded_rect(cr, cx-pillW+shadowOffset, cy-pillH+shadowOffset, pillW*2, pillH*2, pillH);
        cairo_set_source_rgba(cr, kInkR, kInkG, kInkB, 0.10);
        cairo_fill(cr);
        // pill
        rounded_rect(cr, cx-pillW, cy-pillH, pillW*2, pillH*2, pillH);
        cairo_set_source_rgba(cr, bgR, bgG, bgB, 1.0);
        cairo_fill_preserve(cr);
        cairo_set_source_rgba(cr, brR, brG, brB, 1.0);
        cairo_set_line_width(cr, 1.0);
        cairo_stroke(cr);
        // wave bars
        const int barCount = 4;
        const double barW = 2.0, barGap = 2.5;
        double totalW = barCount*barW + (barCount-1)*barGap;
        double startX = cx - totalW/2;
        for (int i = 0; i < barCount; i++) {
            double bx = startX + i*(barW+barGap);
            double phase = phaseListen + i*0.18;
            double v = 0.5 + 0.5*sin(phase * 2 * M_PI);
            double barH = 2.5 + v*5.5;
            rounded_rect(cr, bx, cy-barH/2, barW, barH, barW/2);
            cairo_set_source_rgba(cr, barR, barG, barB, 1.0);
            cairo_fill(cr);
        }

        // Resolve body text first so we can measure for auto-fit.
        const char* body;
        if (gPebbleBodyText && *gPebbleBodyText) {
            body = gPebbleBodyText;
        } else {
            body = speaking ? "speaking…" : "listening — go ahead.";
        }

        // Auto-fit bubble height: measure wrapped text height inside the
        // bubble's inner width, then size the card to fit. Mirrors the
        // Win32 computeBubbleBottom math.
        const double kBubbleX0 = 12, kBubbleY0 = 50, kBubbleX1 = 340;
        const double kBubbleY1Min = 108, kBubbleY1Max = 200;
        const double kBodyX0 = 26, kBodyX1 = 326, kBodyY0 = 80, kBubbleBottomP = 12;
        int textH = measure_text_height(cr, kBodyX1-kBodyX0, body, "Inter Tight 11");
        double by1 = kBodyY0 + (double)textH + kBubbleBottomP;
        if (by1 < kBubbleY1Min) by1 = kBubbleY1Min;
        if (by1 > kBubbleY1Max) by1 = kBubbleY1Max;

        // bubble (auto-fit)
        double cornerR = 6, bs = 4;
        rounded_rect(cr, kBubbleX0+bs, kBubbleY0+bs, kBubbleX1-kBubbleX0, by1-kBubbleY0, cornerR);
        cairo_set_source_rgba(cr, kInkR, kInkG, kInkB, 0.12);
        cairo_fill(cr);
        rounded_rect(cr, kBubbleX0, kBubbleY0, kBubbleX1-kBubbleX0, by1-kBubbleY0, cornerR);
        cairo_set_source_rgba(cr, bgR, bgG, bgB, 1.0);
        cairo_fill_preserve(cr);
        cairo_set_source_rgba(cr,
            speaking ? kInkR : kRuleR,
            speaking ? kInkG : kRuleG,
            speaking ? kInkB : kRuleB, 1.0);
        cairo_set_line_width(cr, 1.0);
        cairo_stroke(cr);

        // text
        double textR = speaking ? kPaperR : kInkR;
        double textG = speaking ? kPaperG : kInkG;
        double textB = speaking ? kPaperB : kInkB;
        double eyR = speaking ? kPaperR : kAccR;
        double eyG = speaking ? kPaperG : kAccG;
        double eyB = speaking ? kPaperB : kAccB;
        draw_text_layout(cr, 26, 60, "JARVIS", "JetBrains Mono Medium 8", eyR, eyG, eyB);
        // Body draw height tracks the auto-fitted card.
        double bodyDrawH = by1 - kBodyY0 - kBubbleBottomP/2.0;
        draw_text_wrapped(cr, kBodyX0, kBodyY0, kBodyX1-kBodyX0, bodyDrawH,
                          body, "Inter Tight 11", textR, textG, textB);
        return FALSE;
    }

    if (gPebbleState == 2) {
        double pillW=14, pillH=6, shadowOffset=2;
        rounded_rect(cr, cx-pillW+shadowOffset, cy-pillH+shadowOffset, pillW*2, pillH*2, pillH);
        cairo_set_source_rgba(cr, kInkR, kInkG, kInkB, 0.10);
        cairo_fill(cr);
        rounded_rect(cr, cx-pillW, cy-pillH, pillW*2, pillH*2, pillH);
        cairo_set_source_rgba(cr, kPaperR, kPaperG, kPaperB, 1.0);
        cairo_fill_preserve(cr);
        cairo_set_source_rgba(cr, kRuleR, kRuleG, kRuleB, 1.0);
        cairo_set_line_width(cr, 1.0);
        cairo_stroke(cr);

        const int dotCount=3;
        const double dotR=1.4, dotGap=4.0;
        double startX = cx - (dotCount-1)*dotGap/2;
        for (int i=0; i<dotCount; i++) {
            double ph = phaseThink + i*0.15;
            double bounce = sin(ph*2*M_PI);
            double dy = -bounce*1.5;
            double alpha = 0.35 + 0.65 * fmax(0.0, bounce);
            cairo_set_source_rgba(cr, kInk3R, kInk3G, kInk3B, alpha);
            cairo_arc(cr, startX+i*dotGap, cy+dy, dotR, 0, 2*M_PI);
            cairo_fill(cr);
        }
        return FALSE;
    }

    if (gPebbleState == 4) {
        double pillW=18, pillH=7, shadowOffset=2;
        rounded_rect(cr, cx-pillW+shadowOffset, cy-pillH+shadowOffset, pillW*2, pillH*2, pillH);
        cairo_set_source_rgba(cr, kInkR, kInkG, kInkB, 0.10);
        cairo_fill(cr);
        rounded_rect(cr, cx-pillW, cy-pillH, pillW*2, pillH*2, pillH);
        cairo_set_source_rgba(cr, kPaperR, kPaperG, kPaperB, 1.0);
        cairo_fill_preserve(cr);
        cairo_set_source_rgba(cr, kRuleR, kRuleG, kRuleB, 1.0);
        cairo_set_line_width(cr, 1.0);
        cairo_stroke(cr);

        double pulse = 0.85 + 0.15*sin(phaseWork * 2 * M_PI);
        double dotR = 2.5 * pulse;
        cairo_set_source_rgba(cr, kWarmR, kWarmG, kWarmB, 1.0);
        cairo_arc(cr, cx-pillW+5, cy, dotR, 0, 2*M_PI);
        cairo_fill(cr);
    }
    return FALSE;
}

// MIGRATION (shared runtime): REMOVE this whole tick() + its g_timeout_add.
// The eased physics now live in pebbleCore.advanceFrame() (Go). Replace with a
// jarvisPebblePresent(x,y,state,frameTick) that g_idle_add's a handler doing
// gtk_window_move + gtk_widget_queue_draw at the position Go already computed.
static gboolean tick(gpointer user_data) {
    if (!gPebbleWindow || !gPebbleArea) return G_SOURCE_REMOVE;

    GdkDisplay* d = gdk_display_get_default();
    GdkSeat* seat = gdk_display_get_default_seat(d);
    GdkDevice* dev = gdk_seat_get_pointer(seat);
    int mx = 0, my = 0;
    gdk_device_get_position(dev, NULL, &mx, &my);

    double tgtX = (double)mx + gOffsetX;
    double tgtY = (double)my + gOffsetY;
    const double followFactor = 0.18;
    gCurX += (tgtX - gCurX) * followFactor;
    gCurY += (tgtY - gCurY) * followFactor;
    gFrameTick++;

    int wx = (int)(gCurX - kAnchorX);
    int wy = (int)(gCurY - kAnchorY);
    gtk_window_move(GTK_WINDOW(gPebbleWindow), wx, wy);
    gtk_window_set_keep_above(GTK_WINDOW(gPebbleWindow), TRUE);

    gtk_widget_queue_draw(gPebbleArea);
    return G_SOURCE_CONTINUE;
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

    // MIGRATION (shared runtime): REMOVE this timer — runPebbleLoop (Go) ticks
    // at 16ms and calls present() each frame. createWindow() should only create
    // the window; the Go loop drives motion + repaint.
    gTimerId = g_timeout_add(16, tick, NULL);
    return G_SOURCE_REMOVE;
}

static gboolean close_idle(gpointer user_data) {
    if (gTimerId) { g_source_remove(gTimerId); gTimerId = 0; }
    if (gPebbleWindow) {
        gtk_widget_destroy(gPebbleWindow);
        gPebbleWindow = NULL;
        gPebbleArea = NULL;
    }
    return G_SOURCE_REMOVE;
}

static gboolean set_state_idle(gpointer user_data) {
    int s = GPOINTER_TO_INT(user_data);
    gPebbleState = s;
    if (gPebbleArea) gtk_widget_queue_draw(gPebbleArea);
    return G_SOURCE_REMOVE;
}

// set_text_idle takes ownership of user_data — a heap-allocated UTF-8
// string previously dup'd by jarvisPebbleSetText (or NULL). Replaces the
// current body text and triggers a repaint.
static gboolean set_text_idle(gpointer user_data) {
    if (gPebbleBodyText) {
        g_free(gPebbleBodyText);
        gPebbleBodyText = NULL;
    }
    if (user_data) {
        gPebbleBodyText = (gchar*)user_data; // takes ownership
    }
    if (gPebbleArea) gtk_widget_queue_draw(gPebbleArea);
    return G_SOURCE_REMOVE;
}

void jarvisPebbleSpawn(int offsetX, int offsetY) {
    gOffsetX = offsetX;
    gOffsetY = offsetY;
    g_idle_add(spawn_idle, NULL);
}

void jarvisPebbleSetState(int state) {
    g_idle_add(set_state_idle, GINT_TO_POINTER(state));
}

void jarvisPebbleSetText(const char* utf8) {
    // Dup so the Go-side buffer can be freed immediately. The idle handler
    // takes ownership and frees the previous text on replacement.
    gchar* copy = (utf8 && *utf8) ? g_strdup(utf8) : NULL;
    g_idle_add(set_text_idle, copy);
}

void jarvisPebbleClose(void) {
    g_idle_add(close_idle, NULL);
}
*/
import "C"

import (
	"runtime"
	"sync/atomic"
	"unsafe"
)

/*
=============================================================================
 MIGRATION: adopt the shared pebbleCore runtime (pebble_runtime.go)  — TODO
=============================================================================
This Linux renderer still runs its OWN frame loop + easing inside C (the
g_timeout_add `tick` below). It works, but it duplicates the motion + pointing
logic that now lives once in pebbleCore.advanceFrame(). Windows is already
migrated (pebble_overlay_windows.go); this file should follow so all three
platforms share one loop + state machine. Nothing here is wired yet — this is
the roadmap, with the concrete shape of the new adapter.

Target (mirrors pebble_overlay_windows.go). The struct EMBEDS pebbleCore so
field accesses promote and the shared runtime can drive them:

    type pebbleServiceLinux struct {
        pebbleCore
        summonCallback  func()
        paletteCallback func()
    }

    func NewPebbleService() PebbleService {
        // Keep starting the GLib main loop on its own goroutine (gtk_main
        // below); the shared frame loop runs on a *separate* Go thread and
        // bridges to GTK via g_idle_add (GTK is not thread-safe).
        s := &pebbleServiceLinux{}
        s.state.Store(PebbleIdle); s.bubbleText.Store("")
        go func() { C.gtk_init(nil, nil); C.gtk_main() }()
        return s
    }

    func (s *pebbleServiceLinux) Spawn(spec PebbleSpec) error {
        if !s.spawned.CompareAndSwap(false, true) { return nil }
        s.spec = spec
        if s.spec.CursorOffsetX == 0 && s.spec.CursorOffsetY == 0 { s.spec.CursorOffsetX, s.spec.CursorOffsetY = 22, 26 }
        if cx, cy, err := platformGetCursorPos(); err == nil { s.curX, s.curY = float64(cx+s.spec.CursorOffsetX), float64(cy+s.spec.CursorOffsetY) }
        s.stopCh, s.doneCh = make(chan struct{}), make(chan struct{})
        go runPebbleLoop(&s.pebbleCore, s)
        return nil
    }

    // pebblePlatform primitives — all GTK work marshals onto the main loop:
    func (s *pebbleServiceLinux) createWindow() error { C.jarvisPebbleSpawn(...); return nil } // window ONLY, no timer
    func (s *pebbleServiceLinux) pumpMessages()       {}                                       // gtk_main pumps for us
    func (s *pebbleServiceLinux) present() error {
        // advanceFrame() already eased + published renderedX/renderedY + frameTick.
        C.jarvisPebblePresent(C.int(s.renderedX.Load()), C.int(s.renderedY.Load()),
            C.int(pebbleStateInt(s.state.Load())), C.ulonglong(s.frameTick) + eye/blinded/overflow/bodyText args)
        return nil
    }
    func (s *pebbleServiceLinux) destroyWindow() { C.jarvisPebbleClose() }

    // SetState/SetText/PointAt/SetEye/SetBlinded/SetAnswerOverflow STOP calling
    // C and just store onto the embedded core (s.state, s.bubbleText, s.pointing
    // /pointX/..., s.eyeActive, ...). present() reads them each frame. This is
    // what gives Linux PointAt + eye + blinded "for free" — ONCE draw_pebble is
    // extended to render them (see below).

C-side changes required:
  - REMOVE `tick`'s easing + cursor read + gtk_window_move, and the
    `g_timeout_add(16, tick, …)` in spawn_idle — the Go loop ticks now.
  - REMOVE globals gCurX/gCurY/gFrameTick/gOffsetX/gOffsetY/gTimerId (position +
    frame come from Go via jarvisPebblePresent).
  - ADD `void jarvisPebblePresent(int x,int y,int state,unsigned long long tick,…)`
    that g_idle_add's a handler doing: set gPebbleState/gFrameTick,
    gtk_window_move(x,y), gtk_widget_queue_draw.
  - KEEP draw_pebble (renderer) and EXTEND it for eye / blinded / answer-overflow
    "open full" button / pointing label so it matches the Windows visual set.

Hotkeys (summon/palette) + long-press blind-toggle stay platform-specific
(hotkeys_linux.go / a GTK button-event handler) and wire into core via OnSummon
/ OnPalette / OnBlindToggle, exactly as on Windows.
=============================================================================
*/

type pebbleServiceLinux struct {
	spawned        atomic.Bool
	summonCallback func()
}

func NewPebbleService() PebbleService {
	// Lock to a thread that will pump the GTK main loop.
	runtime.LockOSThread()
	go func() {
		// Run the GLib main loop on a dedicated goroutine. gtk_init is
		// called in the spawn handler. gtk_main blocks; idle callbacks
		// fire on this goroutine's thread.
		C.gtk_init(nil, nil)
		C.gtk_main()
	}()
	return &pebbleServiceLinux{}
}

func (s *pebbleServiceLinux) Spawn(spec PebbleSpec) error {
	if !s.spawned.CompareAndSwap(false, true) {
		return nil
	}
	ox := spec.CursorOffsetX
	oy := spec.CursorOffsetY
	if ox == 0 && oy == 0 {
		ox, oy = 22, 26
	}
	C.jarvisPebbleSpawn(C.int(ox), C.int(oy))
	return nil
}

func (s *pebbleServiceLinux) SetState(state PebbleState) error {
	var i C.int
	switch state {
	case PebbleListening:
		i = 1
	case PebbleThinking:
		i = 2
	case PebbleSpeaking:
		i = 3
	case PebbleWorking:
		i = 4
	default:
		i = 0
	}
	C.jarvisPebbleSetState(i)
	return nil
}

func (s *pebbleServiceLinux) SetText(text string) error {
	if text == "" {
		C.jarvisPebbleSetText(nil)
		return nil
	}
	cstr := C.CString(text)
	defer C.free(unsafe.Pointer(cstr))
	C.jarvisPebbleSetText(cstr)
	return nil
}

// PointAt / SetEye / SetBlinded / SetAnswerOverflow — currently no-op stubs on
// Linux. MIGRATION (shared runtime): once this file embeds pebbleCore, these
// become one-liners that store onto the core (s.pointing/pointX/pointY/
// pointUntilMs/prevState/prevText, s.eyeActive, s.blinded, s.answerOverflowID)
// — identical to pebble_overlay_windows.go — and pebbleCore.advanceFrame() +
// present() do the rest. They work "for free" once draw_pebble renders the
// glyphs. See the migration block near the top of this file.
func (s *pebbleServiceLinux) PointAt(_, _ int, _ string, _ int) error {
	return nil
}
func (s *pebbleServiceLinux) SetEye(_ bool) error              { return nil }
func (s *pebbleServiceLinux) SetBlinded(_ bool) error          { return nil }
func (s *pebbleServiceLinux) SetAnswerOverflow(_ string) error { return nil }

func (s *pebbleServiceLinux) Close() error {
	if !s.spawned.CompareAndSwap(true, false) {
		return nil
	}
	C.jarvisPebbleClose()
	return nil
}

func (s *pebbleServiceLinux) OnSummon(callback func()) {
	s.summonCallback = callback
	// Linux X11 hotkey integration (XGrabKey on the root window) lives
	// in hotkeys_linux.go (currently stubbed). Wiring it lands in the
	// Linux hotkey ticket.
}

func (s *pebbleServiceLinux) OnPalette(callback func()) {
	// Linux palette hotkey is gated on the X11 hotkey port (T8b/T19b
	// Linux work) — stubbed for now.
	_ = callback
}

// OnBlindToggle — W6 stub on Linux. Long-press detection needs GTK
// button-event handler ported.
func (s *pebbleServiceLinux) OnBlindToggle(callback func()) {
	_ = callback
}

func (s *pebbleServiceLinux) OnAnswerOpen(callback func(string)) {
	_ = callback
}
