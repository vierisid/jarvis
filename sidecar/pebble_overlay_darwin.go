//go:build darwin

package main

// Native pebble overlay — macOS (AppKit NSWindow + NSView, Core Graphics).
//
// W2-T11: mirror of pebble_overlay_windows.go / pebble_overlay_linux.go.
// NSWindow has true OS-level transparency natively (clear backgroundColor +
// isOpaque=false), so we just override drawRect: and paint with CGContext.
//
// Motion + state + the [POINT:..] machine + lifecycle live in the shared
// pebbleCore runtime (pebble_runtime.go); the frame loop runs on its own
// goroutine and pushes each eased frame here via jarvisPebblePresent. This file
// owns only the native window + drawing.
//
// IMPORTANT: AppKit windows + drawing are MAIN THREAD ONLY. The cgo bridge here
// marshals everything that touches NSApp/NSWindow onto the main queue via
// dispatch_async(dispatch_get_main_queue(), ...). The process's Cocoa main
// runloop must be running for those blocks to drain (the panels webview service
// arranges that on macOS, as it did before this migration).

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework AppKit -framework CoreGraphics

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <string.h>
#include <stdlib.h>

// Global state shared across the AppKit objects (one pebble per process).
// Position/easing/offset moved to pebbleCore (Go) — no gCurX/gCurY/gOffset/
// gTimer here anymore. State + frame tick are pushed every frame by
// jarvisPebblePresent (the shared Go runtime drives motion); drawRect: reads them.
static NSWindow*  gPebbleWindow      = nil;
static NSView*    gPebbleView        = nil;
static int        gPebbleState       = 0; // 0=idle, 1=listening, 2=thinking, 3=speaking, 4=working
static unsigned long long gFrameTick = 0;
// Awareness/answer indicators pushed each frame (§5.3): gEye = awareness/OCR
// firing, gBlinded = awareness hard-paused (struck-through eye), gAnswerOverflow
// = the speaking bubble should show the "open full" button.
static int        gEye               = 0;
static int        gBlinded           = 0;
static int        gAnswerOverflow    = 0;
// gPebbleBodyText is the dynamic bubble copy (the live LLM transcript while
// speaking). nil falls back to the per-state placeholder ("speaking…",
// "listening — go ahead."). ARC manages the strong reference.
static NSString*  gPebbleBodyText    = nil;

// Monochrome Lab (Brand Book III) — mirrors pebble_draw_windows.go / pebble.css.
// The pebble is the glass "drop": a translucent lens that breathes one state
// hue at a time (translucent white body + colored radial core + soft glow +
// hairline). The state hues are the only chroma.
static const CGFloat kInkR   = 0x13/255.0, kInkG   = 0x16/255.0, kInkB   = 0x1A/255.0; // --ink
static const CGFloat kInk3R  = 0x67/255.0, kInk3G  = 0x70/255.0, kInk3B  = 0x77/255.0; // --ink3
static const CGFloat kRuleR  = 0xE2/255.0, kRuleG  = 0xE7/255.0, kRuleB  = 0xEC/255.0; // --rule
static const CGFloat kPaperR = 1.0,        kPaperG = 1.0,        kPaperB = 1.0;        // --raise
static const CGFloat kFaintR = 0x9A/255.0, kFaintG = 0xA2/255.0, kFaintB = 0xAB/255.0; // --faint
static const CGFloat kListenR = 0xE6/255.0, kListenG = 0x3B/255.0, kListenB = 0x2E/255.0; // --listen
static const CGFloat kSpeakR  = 0x2D/255.0, kSpeakG  = 0x78/255.0, kSpeakB  = 0xFF/255.0; // --speak
static const CGFloat kHoldR   = 0xEA/255.0, kHoldG   = 0xA4/255.0, kHoldB   = 0x0E/255.0; // --hold
static const CGFloat kOkR     = 0x2F/255.0, kOkG     = 0xA4/255.0, kOkB     = 0x5E/255.0; // --ok
// The awareness eye glyph reuses the brand red (was riso vermilion).
static const CGFloat kAccR = 0xE6/255.0, kAccG = 0x3B/255.0, kAccB = 0x2E/255.0;
// Drop geometry — matches pebbleDiscR / pebbleSharpR on Windows.
static const CGFloat kDropR = 13.0, kSharpR = 5.0;

static const CGFloat kWindowW = 360.0;
static const CGFloat kWindowH = 220.0;
static const CGFloat kAnchorX = 40.0;
static const CGFloat kAnchorY = 28.0;

// draw_eye_cg paints the awareness eye (§5.3): lens outline + iris dot (pulses
// while awareness fires), muted + struck-through when blinded. Mirrors the
// Windows drawEyeGlyph / Linux draw_eye_glyph. Drawn on top of the state glyph.
static void draw_eye_cg(CGContextRef ctx) {
    if (!gEye && !gBlinded) return;
    CGFloat ex = kAnchorX + 14.0, ey = kAnchorY - 10.0;
    const CGFloat lensR = 4.5, irisR = 1.4;
    CGFloat r, g, b;
    if (gBlinded) { r = kInk3R; g = kInk3G; b = kInk3B; }
    else          { r = kAccR;  g = kAccG;  b = kAccB;  }

    CGContextSetRGBStrokeColor(ctx, r, g, b, 220/255.0);
    CGContextSetLineWidth(ctx, 1.0);
    CGContextStrokeEllipseInRect(ctx, CGRectMake(ex-lensR, ey-lensR, lensR*2, lensR*2));

    CGFloat irisA = 220/255.0;
    if (gEye && !gBlinded) {
        int cf = 75;
        double ph = (double)(gFrameTick % cf) / cf;
        double v = ph * 2; if (v > 1) v = 2 - v;
        irisA = (178 + 77*v) / 255.0;
    }
    CGContextSetRGBFillColor(ctx, r, g, b, irisA);
    CGContextFillEllipseInRect(ctx, CGRectMake(ex-irisR, ey-irisR, irisR*2, irisR*2));

    if (gBlinded) {
        CGContextSetRGBStrokeColor(ctx, kAccR, kAccG, kAccB, 1.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextMoveToPoint(ctx, ex - lensR - 1.5, ey + lensR + 1.5);
        CGContextAddLineToPoint(ctx, ex + lensR + 1.5, ey - lensR - 1.5);
        CGContextStrokePath(ctx);
    }
}

// ── Monochrome Lab glass drop (mirrors pebble_draw_windows.go drawDrop) ─────────────

// c_breathe returns a 0..1 sine over `frames` at 60fps, for state pulses.
static double c_breathe(int frames) {
    if (frames <= 0) return 1.0;
    double ph = (double)(gFrameTick % (unsigned long long)frames) / (double)frames;
    return 0.5 + 0.5 * sin(ph * 2 * M_PI);
}

// make_drop_path builds the brand "drop": a rounded square with three 50%
// corners + one sharp corner, rotated 45° (CSS border-radius:50% 50% 50% 6px;
// rotate(45deg)). Caller releases the path.
static CGPathRef make_drop_path(CGFloat cx, CGFloat cy, CGFloat r, CGFloat sharpR) {
    CGAffineTransform t = CGAffineTransformMakeTranslation(cx, cy);
    t = CGAffineTransformRotate(t, M_PI / 4.0);
    CGMutablePathRef p = CGPathCreateMutable();
    CGFloat L = -r, T = -r, R = r, B = r;
    // Order TR, BR, BL(the point), TL — start mid top edge.
    CGPathMoveToPoint(p, &t, 0, T);
    CGPathAddArcToPoint(p, &t, R, T, R, 0, r);       // top-right
    CGPathAddArcToPoint(p, &t, R, B, 0, B, r);       // bottom-right
    CGPathAddArcToPoint(p, &t, L, B, L, 0, sharpR);  // bottom-left (sharp)
    CGPathAddArcToPoint(p, &t, L, T, 0, T, r);       // top-left
    CGPathCloseSubpath(p);
    return p;
}

// radial_fill draws a soft radial gradient (innerA at centre → 0 at r), eased
// toward the centre with a mid stop to mimic the Windows t*t light falloff.
static void radial_fill(CGContextRef ctx, CGFloat cx, CGFloat cy, CGFloat r,
                        CGFloat innerA, CGFloat rr, CGFloat gg, CGFloat bb) {
    if (innerA <= 0 || r <= 0) return;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGFloat comps[12] = { rr, gg, bb, innerA,
                          rr, gg, bb, innerA * 0.25,
                          rr, gg, bb, 0.0 };
    CGFloat locs[3] = { 0.0, 0.5, 1.0 };
    CGGradientRef grad = CGGradientCreateWithColorComponents(cs, comps, locs, 3);
    CGContextDrawRadialGradient(ctx, grad, CGPointMake(cx, cy), 0,
                                CGPointMake(cx, cy), r, 0);
    CGGradientRelease(grad);
    CGColorSpaceRelease(cs);
}

// draw_drop_cg paints the glass drop: soft glow, neutral shadow, translucent
// white glass body, a colored radial core clipped to the drop, a top-left inner
// shine, and a hairline. coreAlpha / glowAlpha are 0..1 (glowAlpha 0 = no halo).
static void draw_drop_cg(CGContextRef ctx, CGFloat cx, CGFloat cy,
                         CGFloat cr, CGFloat cg, CGFloat cb,
                         double coreAlpha, double glowAlpha) {
    // 1) outer glow — soft colored halo behind the lens.
    if (glowAlpha > 0) radial_fill(ctx, cx, cy + 1, kDropR * 2.1, glowAlpha * 150.0/255.0, cr, cg, cb);
    // 2) drop shadow — neutral, offset down.
    CGPathRef shadow = make_drop_path(cx, cy + 2, kDropR, kSharpR);
    CGContextAddPath(ctx, shadow);
    CGContextSetRGBFillColor(ctx, kInkR, kInkG, kInkB, 40.0/255.0);
    CGContextFillPath(ctx);
    CGPathRelease(shadow);
    // 3) glass body — translucent white.
    CGPathRef drop = make_drop_path(cx, cy, kDropR, kSharpR);
    CGContextAddPath(ctx, drop);
    CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 120.0/255.0);
    CGContextFillPath(ctx);
    // 4) colored core — radial, clipped to the drop so light reads through the glass.
    if (coreAlpha > 0) {
        CGContextSaveGState(ctx);
        CGContextAddPath(ctx, drop);
        CGContextClip(ctx);
        radial_fill(ctx, cx, cy, kDropR * 1.05, coreAlpha, cr, cg, cb);
        CGContextRestoreGState(ctx);
    }
    // 5) inner shine — top-left glass highlight, clipped to the drop.
    CGContextSaveGState(ctx);
    CGContextAddPath(ctx, drop);
    CGContextClip(ctx);
    radial_fill(ctx, cx - kDropR*0.32, cy - kDropR*0.34, kDropR*0.7, 150.0/255.0, 1.0, 1.0, 1.0);
    CGContextRestoreGState(ctx);
    // 6) hairline border along the drop outline.
    CGContextAddPath(ctx, drop);
    CGContextSetRGBStrokeColor(ctx, kInkR, kInkG, kInkB, 90.0/255.0);
    CGContextSetLineWidth(ctx, 1.0);
    CGContextStrokePath(ctx);
    CGPathRelease(drop);
}

// draw_pebble_state paints one state's drop (no eye glyph) at the anchor.
// Factored out of drawRect so the offscreen harness can reuse it. Reads
// gFrameTick for the per-state animation phase.
static void draw_pebble_state(CGContextRef ctx, int state) {
    CGFloat cx = kAnchorX, cy = kAnchorY;
    switch (state) {
    case 1: // listening — red drop, no bubble (you're talking, not reading).
        draw_drop_cg(ctx, cx, cy, kListenR, kListenG, kListenB, 0.55 + 0.45*c_breathe(84), 0.5);
        break;
    case 3: // speaking — blue drop, no transcript (voice-first).
        draw_drop_cg(ctx, cx, cy, kSpeakR, kSpeakG, kSpeakB, 0.6 + 0.4*c_breathe(96), 0.5);
        break;
    case 2: { // thinking — clear glass + a white dot orbiting the rim.
        draw_drop_cg(ctx, cx, cy, kInk3R, kInk3G, kInk3B, 0.16, 0);
        double ang = ((double)(gFrameTick % 84) / 84.0) * 2 * M_PI;
        CGFloat ox = cx + cos(ang)*kDropR*0.62, oy = cy + sin(ang)*kDropR*0.62;
        CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 235.0/255.0);
        CGContextFillEllipseInRect(ctx, CGRectMake(ox-2, oy-2, 4, 4));
        break;
    }
    case 4: // working — steady blue, gentle breath.
        draw_drop_cg(ctx, cx, cy, kSpeakR, kSpeakG, kSpeakB, 0.45 + 0.35*c_breathe(144), 0.35);
        break;
    case 5: { // asking — amber core + an expanding fading ring.
        draw_drop_cg(ctx, cx, cy, kHoldR, kHoldG, kHoldB, 0.55 + 0.35*c_breathe(120), 0.4);
        double ph = (double)(gFrameTick % 120) / 120.0;
        CGFloat ringR = kDropR + ph*9.0;
        CGContextSetRGBStrokeColor(ctx, kHoldR, kHoldG, kHoldB, (1.0 - ph) * 120.0/255.0);
        CGContextSetLineWidth(ctx, 1.2);
        CGContextStrokeEllipseInRect(ctx, CGRectMake(cx-ringR, cy-ringR, ringR*2, ringR*2));
        break;
    }
    case 6: // done — green flash.
        draw_drop_cg(ctx, cx, cy, kOkR, kOkG, kOkB, 0.9, 0.55);
        break;
    case 7: { // muted — quiet gray glass + a diagonal slash.
        draw_drop_cg(ctx, cx, cy, kFaintR, kFaintG, kFaintB, 0.22, 0);
        CGContextSetRGBStrokeColor(ctx, kInk3R, kInk3G, kInk3B, 210.0/255.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextMoveToPoint(ctx, cx - kDropR*0.6, cy + kDropR*0.6);
        CGContextAddLineToPoint(ctx, cx + kDropR*0.6, cy - kDropR*0.6);
        CGContextStrokePath(ctx);
        break;
    }
    default: // idle — clear glass with a faint neutral presence that breathes.
        draw_drop_cg(ctx, cx, cy, kInk3R, kInk3G, kInk3B, 0.18 + 0.16*c_breathe(240), 0);
        break;
    }
}

@interface JarvisPebbleView : NSView
@end

@implementation JarvisPebbleView

- (BOOL)isFlipped { return YES; } // top-left origin to match the Windows code

- (void)drawRect:(NSRect)dirty {
    CGContextRef ctx = [[NSGraphicsContext currentContext] CGContext];
    draw_pebble_state(ctx, gPebbleState);
    draw_eye_cg(ctx);
}
@end

// jarvisPebbleSpawnImpl creates the overlay window only — the shared Go loop
// drives motion + repaint via jarvisPebblePresent. Runs on the main thread.
static void jarvisPebbleSpawnImpl(void) {
    if (gPebbleWindow != nil) return;

    NSRect frame = NSMakeRect(0, 0, kWindowW, kWindowH);
    gPebbleWindow = [[NSWindow alloc] initWithContentRect:frame
                                                styleMask:NSWindowStyleMaskBorderless
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    [gPebbleWindow setOpaque:NO];
    [gPebbleWindow setBackgroundColor:[NSColor clearColor]];
    [gPebbleWindow setHasShadow:NO];
    [gPebbleWindow setLevel:NSScreenSaverWindowLevel];
    [gPebbleWindow setIgnoresMouseEvents:YES]; // global click-through
    [gPebbleWindow setHidesOnDeactivate:NO];
    [gPebbleWindow setCollectionBehavior:
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorTransient |
        NSWindowCollectionBehaviorIgnoresCycle |
        NSWindowCollectionBehaviorFullScreenAuxiliary];

    gPebbleView = [[JarvisPebbleView alloc] initWithFrame:frame];
    [gPebbleWindow setContentView:gPebbleView];

    [gPebbleWindow makeKeyAndOrderFront:nil];
    // No NSTimer — runPebbleLoop (Go) ticks at 16ms and calls present() each
    // frame, which dispatch_async's jarvisPebblePresentImpl onto the main queue.
}

// jarvisPebblePresentImpl applies one eased frame on the main thread: the shared
// Go runtime already eased the position (x,y in top-left space) and bumped the
// frame tick; we push state/tick/text, convert to the bottom-left window origin
// (Y-flip), and redraw.
static void jarvisPebblePresentImpl(int x, int y, int state, unsigned long long tick,
                                    int eye, int blinded, int answerOverflow, int alphaPct, NSString* body) {
    if (!gPebbleWindow || !gPebbleView) return;
    // Ethereal-mode window opacity (0..100 from the Go runtime).
    [gPebbleWindow setAlphaValue:(CGFloat)alphaPct / 100.0];
    gPebbleState = state;
    gFrameTick = tick;
    gEye = eye;
    gBlinded = blinded;
    gAnswerOverflow = answerOverflow;
    gPebbleBodyText = body; // ARC: nil clears, otherwise retains

    // advanceFrame() publishes renderedX/renderedY in the SAME top-left space
    // platformGetCursorPos() returns. macOS windows use a bottom-left origin,
    // so flip Y: origin.y = screenH - y - windowHeight (matches the old tick's
    // `screenH - (gCurY - kAnchorY) - frameH`, fed from Go's renderedX/Y).
    NSScreen* main = [[NSScreen screens] firstObject];
    CGFloat screenH = main ? main.frame.size.height : 0;
    NSRect wframe = [gPebbleWindow frame];
    NSPoint origin = NSMakePoint((CGFloat)x, screenH - (CGFloat)y - wframe.size.height);
    [gPebbleWindow setFrameOrigin:origin];

    [gPebbleView setNeedsDisplay:YES];
}

static void jarvisPebbleCloseImpl(void) {
    if (gPebbleWindow) {
        [gPebbleWindow orderOut:nil];
        gPebbleWindow = nil;
    }
    gPebbleView = nil;
    gPebbleBodyText = nil;
}

// Public C entry points marshalled onto the main thread.

// jarvisPebbleSpawn creates the window only.
void jarvisPebbleSpawn(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ jarvisPebbleSpawnImpl(); });
}

// jarvisPebblePresent pushes one eased frame from the Go runtime. text may be
// NULL/empty (drawRect: falls back to the per-state placeholder).
void jarvisPebblePresent(int x, int y, int state, unsigned long long tick,
                         int eye, int blinded, int answerOverflow, int alphaPct, const char* text) {
    // Copy onto the heap so the Go-side buffer can be freed immediately.
    char* copy = (text && *text) ? strdup(text) : NULL;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString* body = copy ? [NSString stringWithUTF8String:copy] : nil;
        jarvisPebblePresentImpl(x, y, state, tick, eye, blinded, answerOverflow, alphaPct, body);
        if (copy) free(copy);
    });
}

void jarvisPebbleClose(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ jarvisPebbleCloseImpl(); });
}
*/
import "C"

import (
	"log"
	"sync/atomic"
	"unsafe"
)

// pebbleServiceDarwin is the AppKit adapter for the shared pebbleCore runtime
// (pebble_runtime.go). The shared loop owns motion + state + lifecycle; this
// file owns only the native window + drawing (the cgo block above) and bridges
// each frame onto the Cocoa main queue.
type pebbleServiceDarwin struct {
	pebbleCore
	summonCallback    atomic.Value // func(); re-assigned per reconnect, read by the hotkey goroutine
	paletteCallback   atomic.Value // func()
	hotkeyStop        func()       // summon hotkey listener stop
	paletteHotkeyStop func()       // palette hotkey listener stop
}

func NewPebbleService() PebbleService {
	// Unlike Linux (which spins its own gtk_main goroutine), macOS relies on the
	// process's existing Cocoa main runloop (arranged by the panels webview
	// service) to drain the dispatch_async(main_queue) blocks. No loop to spin
	// up here.
	s := &pebbleServiceDarwin{}
	s.state.Store(PebbleIdle)
	s.bubbleText.Store("")
	return s
}

func (s *pebbleServiceDarwin) Spawn(spec PebbleSpec) error {
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

	// Global hotkeys (§5.4): summon + palette. macOS needs Accessibility trust;
	// a failed/unfired grab is non-fatal.
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

// ─── pebblePlatform primitives (all AppKit work marshals to the main queue) ──

func (s *pebbleServiceDarwin) createWindow() error { C.jarvisPebbleSpawn(); return nil }
func (s *pebbleServiceDarwin) pumpMessages()       {} // the Cocoa runloop pumps for us

func (s *pebbleServiceDarwin) present() error {
	// advanceFrame() already eased + published renderedX/renderedY + frameTick.
	state, _ := s.state.Load().(PebbleState)
	text, _ := s.bubbleText.Load().(string)
	var cstr *C.char
	if text != "" {
		cstr = C.CString(text)
		defer C.free(unsafe.Pointer(cstr))
	}
	answerID, _ := s.answerOverflowID.Load().(string)
	alpha := s.EtherealAlpha()
	if alpha < 0 {
		alpha = 0
	} else if alpha > 1 {
		alpha = 1
	}
	C.jarvisPebblePresent(
		C.int(s.renderedX.Load()), C.int(s.renderedY.Load()),
		C.int(pebbleStateToInt(state)), C.ulonglong(s.frameTick),
		pebbleBoolToCInt(s.eyeActive.Load()), pebbleBoolToCInt(s.blinded.Load()),
		pebbleBoolToCInt(answerID != ""), C.int(alpha*100), cstr,
	)
	return nil
}

// pebbleBoolToCInt maps a Go bool to the 0/1 C.int the renderer flags expect.
func pebbleBoolToCInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

func (s *pebbleServiceDarwin) destroyWindow() { C.jarvisPebbleClose() }

func (s *pebbleServiceDarwin) Close() error {
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
// the state to the renderer each frame. PointAt now works on macOS. drawRect:
// renders idle/listening/thinking/speaking/working + bubble text + the eye /
// blinded strike / answer-overflow button (§5.3). The pointing label is already
// handled (PointAt sets state=listening + bubbleText=label).

func (s *pebbleServiceDarwin) OnSummon(callback func())  { s.summonCallback.Store(callback) }
func (s *pebbleServiceDarwin) OnPalette(callback func()) { s.paletteCallback.Store(callback) }

// OnBlindToggle / OnAnswerOpen — the callbacks are accepted; the summon/palette
// hotkeys fire via the NSEvent monitor (§5.4). The disc long-press (blind
// toggle) and answer-button click still need the pebble window to catch input;
// that input wiring is the documented residual in §5.4.
func (s *pebbleServiceDarwin) OnBlindToggle(callback func())      { _ = callback }
func (s *pebbleServiceDarwin) OnAnswerOpen(callback func(string)) { _ = callback }
