//go:build darwin

package main

// Native sub-pebble overlay — macOS (AppKit NSWindow + Core Graphics).
//
// Mirrors sub_pebble_overlay_linux.go on the shared sub_pebble_runtime.go
// contract: one small transparent always-on-top NSWindow per background task,
// docked on the right rail, eased toward its slot by the shared runtime. All
// AppKit work marshals onto the main queue (the panels webview service keeps the
// Cocoa runloop alive, as for the main pebble).
//
// COMPILE-UNVERIFIED in the Linux/WSL dev environment (no Cocoa SDK) — must be
// checked on a Mac. FIRST CUT, like Linux: renders the colored state disc +
// routes disc clicks to OnClick. The expand bubble + "open full" button are not
// drawn yet (§5.2). Single-display assumption for the rail anchor + Y-flip.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework AppKit -framework CoreGraphics

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <math.h>

extern void goSubPebbleClick(unsigned long long handle, int x, int y);

// ── Monochrome Lab mini glass drop (self-contained: the main pebble's drop statics live
//    in a different cgo translation unit, so we re-declare a minimal set). ──
static CGPathRef sub_drop_path(CGFloat cx, CGFloat cy, CGFloat r, CGFloat sharpR) {
    CGAffineTransform t = CGAffineTransformMakeTranslation(cx, cy);
    t = CGAffineTransformRotate(t, M_PI / 4.0);
    CGMutablePathRef p = CGPathCreateMutable();
    CGFloat L = -r, T = -r, R = r, B = r;
    CGPathMoveToPoint(p, &t, 0, T);
    CGPathAddArcToPoint(p, &t, R, T, R, 0, r);       // top-right
    CGPathAddArcToPoint(p, &t, R, B, 0, B, r);       // bottom-right
    CGPathAddArcToPoint(p, &t, L, B, L, 0, sharpR);  // bottom-left (sharp)
    CGPathAddArcToPoint(p, &t, L, T, 0, T, r);       // top-left
    CGPathCloseSubpath(p);
    return p;
}
static void sub_radial(CGContextRef ctx, CGFloat cx, CGFloat cy, CGFloat rad,
                       CGFloat innerA, CGFloat rr, CGFloat gg, CGFloat bb) {
    if (innerA <= 0 || rad <= 0) return;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGFloat comps[12] = { rr, gg, bb, innerA,  rr, gg, bb, innerA * 0.25,  rr, gg, bb, 0.0 };
    CGFloat locs[3] = { 0.0, 0.5, 1.0 };
    CGGradientRef grad = CGGradientCreateWithColorComponents(cs, comps, locs, 3);
    CGContextDrawRadialGradient(ctx, grad, CGPointMake(cx, cy), 0, CGPointMake(cx, cy), rad, 0);
    CGGradientRelease(grad);
    CGColorSpaceRelease(cs);
}

#define SUBW 44.0
#define SUBH 44.0
#define SUB_CX 22.0
#define SUB_CY 22.0

@class JarvisSubView;

typedef struct {
    NSWindow*          window;
    JarvisSubView*     view;
    double             r, g, b;   // accent (0..1)
    int                state;
    unsigned long long tick;
    unsigned long long handle;    // == (uintptr)self
} SubWin;

@interface JarvisSubView : NSView {
@public
    SubWin* sw;
}
@end

@implementation JarvisSubView

- (BOOL)isFlipped { return YES; } // top-left origin, matches the disc math

- (void)mouseDown:(NSEvent*)event {
    NSPoint p = [self convertPoint:[event locationInWindow] fromView:nil];
    if (sw) goSubPebbleClick(sw->handle, (int)p.x, (int)p.y);
}

- (void)drawRect:(NSRect)dirty {
    if (!sw) return;
    CGContextRef ctx = [[NSGraphicsContext currentContext] CGContext];
    CGFloat cx = SUB_CX, cy = SUB_CY;
    const CGFloat dR = 11.5, sR = 4.5; // mini drop (mirrors sub_pebble_draw_windows.go)

    // The agent color tints the core; a finished sub-agent turns brand green.
    CGFloat r = sw->r, g = sw->g, b = sw->b;
    if (sw->state == 6) { r = 0x2F/255.0; g = 0xA4/255.0; b = 0x5E/255.0; } // done → ok

    double core = 0.42, glow = 0.0; int spinning = 0;
    if (sw->state == 0) { core = 0.40; }                      // idle — dim glass
    else if (sw->state == 6) { core = 0.92; glow = 0.55; }    // done — bright green
    else {                                                    // active — pulse + spinner
        const int cf = 75;
        double phase = (double)(sw->tick % cf) / (double)cf;
        double v = phase * 2; if (v > 1) v = 2 - v;
        core = 0.6 + 0.4*v; glow = 0.45; spinning = 1;
    }

    if (glow > 0) sub_radial(ctx, cx, cy+1, dR*2.0, glow*150.0/255.0, r, g, b);
    CGPathRef shp = sub_drop_path(cx, cy+2, dR, sR);
    CGContextAddPath(ctx, shp);
    CGContextSetRGBFillColor(ctx, 0x13/255.0, 0x16/255.0, 0x1A/255.0, 34.0/255.0);
    CGContextFillPath(ctx);
    CGPathRelease(shp);
    CGPathRef dp = sub_drop_path(cx, cy, dR, sR);
    CGContextAddPath(ctx, dp);
    CGContextSetRGBFillColor(ctx, 1, 1, 1, 120.0/255.0);
    CGContextFillPath(ctx);
    CGContextSaveGState(ctx); CGContextAddPath(ctx, dp); CGContextClip(ctx);
    sub_radial(ctx, cx, cy, dR, core, r, g, b);
    CGContextRestoreGState(ctx);
    CGContextSaveGState(ctx); CGContextAddPath(ctx, dp); CGContextClip(ctx);
    sub_radial(ctx, cx - dR*0.32, cy - dR*0.34, dR*0.7, 140.0/255.0, 1, 1, 1);
    CGContextRestoreGState(ctx);
    CGContextAddPath(ctx, dp);
    CGContextSetRGBStrokeColor(ctx, 0x13/255.0, 0x16/255.0, 0x1A/255.0, 85.0/255.0);
    CGContextSetLineWidth(ctx, 1.0);
    CGContextStrokePath(ctx);
    CGPathRelease(dp);
    if (spinning) {
        const int sf = 66;
        double ang = (double)(sw->tick % sf) / (double)sf * 2 * M_PI;
        CGFloat ox = cx + cos(ang)*dR*0.66, oy = cy + sin(ang)*dR*0.66;
        CGContextSetRGBFillColor(ctx, 1, 1, 1, 235.0/255.0);
        CGContextFillEllipseInRect(ctx, CGRectMake(ox-1.9, oy-1.9, 3.8, 3.8));
    }
}
@end

static void sub_create_impl(SubWin* sw) {
    NSRect frame = NSMakeRect(0, 0, SUBW, SUBH);
    NSWindow* win = [[NSWindow alloc] initWithContentRect:frame
                                                styleMask:NSWindowStyleMaskBorderless
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    [win setOpaque:NO];
    [win setBackgroundColor:[NSColor clearColor]];
    [win setHasShadow:NO];
    [win setLevel:NSScreenSaverWindowLevel];
    [win setIgnoresMouseEvents:NO]; // catch disc clicks
    [win setHidesOnDeactivate:NO];
    [win setCollectionBehavior:
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorTransient |
        NSWindowCollectionBehaviorIgnoresCycle |
        NSWindowCollectionBehaviorFullScreenAuxiliary];

    JarvisSubView* view = [[JarvisSubView alloc] initWithFrame:frame];
    view->sw = sw;
    [win setContentView:view];
    sw->window = win;
    sw->view = view;
    [win makeKeyAndOrderFront:nil];
}

static SubWin* jarvisSubCreate(int seedX, int seedY) {
    (void)seedX; (void)seedY;
    SubWin* sw = (SubWin*)calloc(1, sizeof(SubWin));
    sw->handle = (unsigned long long)(uintptr_t)sw;
    dispatch_async(dispatch_get_main_queue(), ^{ sub_create_impl(sw); });
    return sw;
}

static void jarvisSubPresent(SubWin* sw, int x, int y, int r, int g, int b, int state, unsigned long long tick) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!sw || !sw->window) return;
        sw->r = r/255.0; sw->g = g/255.0; sw->b = b/255.0;
        sw->state = state; sw->tick = tick;
        // x,y are top-left coords; macOS windows use a bottom-left origin.
        NSScreen* main = [[NSScreen screens] firstObject];
        CGFloat screenH = main ? main.frame.size.height : 0;
        [sw->window setFrameOrigin:NSMakePoint((CGFloat)x, screenH - (CGFloat)y - SUBH)];
        [sw->view setNeedsDisplay:YES];
    });
}

// jarvisSubMonitorRight returns the main screen's right edge (single-display
// assumption — multi-monitor anchor-at-cursor is a follow-up).
static int jarvisSubMonitorRight(void) {
    NSScreen* main = [[NSScreen screens] firstObject];
    if (!main) return 0;
    return (int)(main.frame.origin.x + main.frame.size.width);
}

static void jarvisSubDestroy(SubWin* sw) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (sw->window) { [sw->window orderOut:nil]; sw->window = nil; }
        sw->view = nil;
        free(sw);
    });
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

const subPebbleDarwinAnchor = 22
const subPebbleDarwinHitRadius = 16

var subPebbleByHandleDarwin sync.Map          // uintptr -> *subPebbleEntry
var subPebbleWinDarwin sync.Map               // uintptr -> *C.SubWin
var subPebbleClickCallbackDarwin atomic.Value // func(id string)

type subPebbleServiceDarwin struct {
	mu    sync.Mutex
	items map[string]*subPebbleEntry
}

// NewSubPebbleService returns the AppKit-native multi-overlay service.
func NewSubPebbleService() SubPebbleService {
	return &subPebbleServiceDarwin{items: make(map[string]*subPebbleEntry)}
}

func (s *subPebbleServiceDarwin) Spawn(spec SubPebbleSpec) error {
	if spec.ID == "" {
		return fmt.Errorf("sub_pebble.spawn: id is required")
	}
	s.mu.Lock()
	if _, exists := s.items[spec.ID]; exists {
		s.mu.Unlock()
		return nil
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
	entry.monitorRight.Store(int32(C.jarvisSubMonitorRight()))
	if cx, cy, err := platformGetCursorPos(); err == nil {
		entry.curX.Store(int32(cx - subPebbleDarwinAnchor))
		entry.curY.Store(int32(cy - subPebbleDarwinAnchor))
	}
	s.items[spec.ID] = entry
	s.mu.Unlock()

	go runSubPebbleOverlay(entry, s)
	log.Printf("[sub-pebble] spawned id=%s color=%s slot=%d state=%s", spec.ID, spec.Color, spec.Slot, spec.State)
	return nil
}

func (s *subPebbleServiceDarwin) SetState(id string, state PebbleState) error {
	return s.withEntry(id, func(e *subPebbleEntry) { e.state.Store(state) })
}
func (s *subPebbleServiceDarwin) SetColor(id string, color SubPebbleColor) error {
	return s.withEntry(id, func(e *subPebbleEntry) { e.color.Store(color) })
}
func (s *subPebbleServiceDarwin) SetLabel(id string, label string) error {
	return s.withEntry(id, func(e *subPebbleEntry) { e.label.Store(label) })
}
func (s *subPebbleServiceDarwin) SetExpanded(id string, expanded bool, agent, task, result string, elapsedS int) error {
	// State recorded for parity; the bubble card is not yet drawn on macOS (§5.2).
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

func (s *subPebbleServiceDarwin) withEntry(id string, fn func(*subPebbleEntry)) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("sub-pebble %q not found", id)
	}
	fn(entry)
	return nil
}

func (s *subPebbleServiceDarwin) Close(id string) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	if ok {
		delete(s.items, id)
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

func (s *subPebbleServiceDarwin) CloseAll() error {
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

func (s *subPebbleServiceDarwin) OnClick(callback func(id string)) {
	subPebbleClickCallbackDarwin.Store(callback)
}

// OnOpenFull — accepted but never fired yet (no bubble on macOS, §5.2).
func (s *subPebbleServiceDarwin) OnOpenFull(callback func(id string)) { _ = callback }

// ─── subPebblePlatform primitives ───────────────────────────────────────────

func (s *subPebbleServiceDarwin) createOverlayWindow(entry *subPebbleEntry) error {
	cx, cy := 0, 0
	if x, y, err := platformGetCursorPos(); err == nil {
		cx, cy = x, y
	}
	sw := C.jarvisSubCreate(C.int(cx), C.int(cy))
	if sw == nil {
		return fmt.Errorf("jarvisSubCreate returned nil")
	}
	entry.hwnd = uintptr(unsafe.Pointer(sw))
	subPebbleByHandleDarwin.Store(entry.hwnd, entry)
	subPebbleWinDarwin.Store(entry.hwnd, sw)
	return nil
}

func (s *subPebbleServiceDarwin) pumpMessages() {} // Cocoa runloop pumps for us

func (s *subPebbleServiceDarwin) paint(entry *subPebbleEntry) error {
	v, ok := subPebbleWinDarwin.Load(entry.hwnd)
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

func (s *subPebbleServiceDarwin) slotPosition(entry *subPebbleEntry) (int, int) {
	right := int(entry.monitorRight.Load())
	if right <= 0 {
		right = 1920
	}
	slot := int(entry.slot.Load())
	winX := right - subPebbleRightMargin - subPebbleDarwinAnchor
	winY := subPebbleTopMargin + slot*subPebbleSlotSpacing - subPebbleDarwinAnchor
	return winX, winY
}

func (s *subPebbleServiceDarwin) destroyOverlay(entry *subPebbleEntry) {
	if entry.hwnd == 0 {
		return
	}
	subPebbleByHandleDarwin.Delete(entry.hwnd)
	if v, ok := subPebbleWinDarwin.LoadAndDelete(entry.hwnd); ok {
		C.jarvisSubDestroy(v.(*C.SubWin))
	}
	entry.hwnd = 0
}
