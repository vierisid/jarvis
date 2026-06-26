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

// draw_answer_button paints the "open full ↗" overflow button at the bubble's
// bottom-right (§5.3). by1 is the auto-fitted bubble bottom; speaking picks the
// light-on-dark tint. Mirrors the Windows drawAnswerOverflowButton geometry.
static void draw_answer_button(cairo_t* cr, double by1, gboolean speaking) {
    const double btnW = 108, btnH = 22, insetR = 10, insetB = 8;
    const double kBubbleX1 = 340;
    double bxL = kBubbleX1 - insetR - btnW;
    double byTop = by1 - insetB - btnH;
    double tr = speaking ? kPaperR : kAccR;
    double tg = speaking ? kPaperG : kAccG;
    double tb = speaking ? kPaperB : kAccB;

    rounded_rect(cr, bxL, byTop, btnW, btnH, 5.0);
    cairo_set_source_rgba(cr, tr, tg, tb, speaking ? 32/255.0 : 36/255.0);
    cairo_fill(cr);
    rounded_rect(cr, bxL, byTop, btnW, btnH, 5.0);
    cairo_set_source_rgba(cr, tr, tg, tb, speaking ? 200/255.0 : 220/255.0);
    cairo_set_line_width(cr, 1.0);
    cairo_stroke(cr);
    draw_text_layout(cr, bxL + 12, byTop + 4, "open full ↗", "Inter Tight 9", tr, tg, tb);
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
        draw_eye_glyph(cr);
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
        if (gAnswerOverflow) draw_answer_button(cr, by1, speaking);
        draw_eye_glyph(cr);
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
        draw_eye_glyph(cr);
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
	hotkeyStop        func() // summon hotkey listener stop
	paletteHotkeyStop func() // palette hotkey listener stop
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
