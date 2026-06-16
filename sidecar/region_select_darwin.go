//go:build darwin

package main

// macOS region-selection overlay (AppKit + Core Graphics).
//
// Mirrors region_select_linux.go / region_select_windows.go:
//   1. Snapshot the display with CGWindowListCreateImage BEFORE the overlay
//      shows (so the crop excludes our dim/outline).
//   2. Fullscreen always-on-top overlay NSWindow over the main screen; an
//      NSView handles drag + key events.
//   3. Dim + cleared selection rect + vermilion outline.
//   4. On mouse-up, hand drag corners to Go (shared normalizeRegionRect /
//      regionDragTooSmall), crop the snapshot, PNG-encode, fire onCapture. Esc /
//      right-click / zero-area → onCancel.
//
// COMPILE-UNVERIFIED in the Linux/WSL dev environment — must be checked on a
// Mac. Single-display assumption. RETINA GOTCHA: CGWindowListCreateImage returns
// backing-scale pixels while view coords are points, so crop coords are scaled
// by the backing factor.

/*
// CGWindowListCreateImage is obsoleted in the macOS 15 SDK headers (the symbol
// is still live at runtime). Pin the deployment target below 15.0 so the
// availability check treats it as deprecated, not unavailable. As a #cgo
// directive this applies package-wide on darwin, so every cgo TU shares one
// min (no linker version mismatch), and it overrides the -mmacos-version-min
// Go's cgo injects from the SDK -- which is why the Makefile's
// MACOSX_DEPLOYMENT_TARGET env alone doesn't suppress the error.
#cgo CFLAGS: -x objective-c -fobjc-arc -mmacosx-version-min=11.0
#cgo LDFLAGS: -framework Cocoa -framework AppKit -framework CoreGraphics -mmacosx-version-min=11.0

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <string.h>

extern void goRegionFinish(int x0, int y0, int x1, int y1);
extern void goRegionCancel(void);

#define REG_ACC_R (194.0/255.0)
#define REG_ACC_G (58.0/255.0)
#define REG_ACC_B (42.0/255.0)

@class JarvisRegionView;

static NSWindow*         gRegionWin  = nil;
static JarvisRegionView* gRegionView = nil;
static CGImageRef        gRegionShot = NULL;
static CGFloat           gRegionScale = 1.0;
static BOOL              gRegionDragging = NO;
static int               gRsx = 0, gRsy = 0, gRcx = 0, gRcy = 0;

@interface JarvisRegionView : NSView
@end

@implementation JarvisRegionView

- (BOOL)isFlipped { return YES; }      // top-left coords for drag math
- (BOOL)acceptsFirstResponder { return YES; }

- (void)drawRect:(NSRect)dirty {
    CGContextRef ctx = [[NSGraphicsContext currentContext] CGContext];
    // Dim everything (~43%).
    CGContextSetRGBFillColor(ctx, 30/255.0, 30/255.0, 30/255.0, 0.43);
    CGContextFillRect(ctx, NSRectToCGRect(self.bounds));

    if (gRegionDragging) {
        int x0 = gRsx, y0 = gRsy, x1 = gRcx, y1 = gRcy;
        if (x1 < x0) { int t = x0; x0 = x1; x1 = t; }
        if (y1 < y0) { int t = y0; y0 = y1; y1 = t; }
        CGRect sel = CGRectMake(x0, y0, x1 - x0, y1 - y0);
        // Clear interior so the live screen shows through.
        CGContextClearRect(ctx, sel);
        // Vermilion hairline outline.
        CGContextSetRGBStrokeColor(ctx, REG_ACC_R, REG_ACC_G, REG_ACC_B, 1.0);
        CGContextSetLineWidth(ctx, 1.5);
        CGContextStrokeRect(ctx, CGRectMake(x0+0.5, y0+0.5, (x1-x0)-1, (y1-y0)-1));
    }
}

- (void)mouseDown:(NSEvent*)e {
    NSPoint p = [self convertPoint:[e locationInWindow] fromView:nil];
    gRegionDragging = YES;
    gRsx = (int)p.x; gRsy = (int)p.y;
    gRcx = (int)p.x; gRcy = (int)p.y;
    [self setNeedsDisplay:YES];
}

- (void)mouseDragged:(NSEvent*)e {
    if (!gRegionDragging) return;
    NSPoint p = [self convertPoint:[e locationInWindow] fromView:nil];
    gRcx = (int)p.x; gRcy = (int)p.y;
    [self setNeedsDisplay:YES];
}

- (void)mouseUp:(NSEvent*)e {
    if (!gRegionDragging) return;
    gRegionDragging = NO;
    NSPoint p = [self convertPoint:[e locationInWindow] fromView:nil];
    goRegionFinish(gRsx, gRsy, (int)p.x, (int)p.y);
}

- (void)rightMouseDown:(NSEvent*)e { goRegionCancel(); }

- (void)keyDown:(NSEvent*)e {
    if ([e keyCode] == 53) { // Escape
        goRegionCancel();
    }
}
@end

// Borderless NSWindows return NO from canBecomeKeyWindow by default, so a plain
// NSWindow would never become key under the accessory activation policy and
// keyDown: (Escape-to-cancel) would never fire. Subclass to opt in.
@interface JarvisRegionWindow : NSWindow
@end
@implementation JarvisRegionWindow
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return YES; }
@end

static void region_start_impl(void) {
    NSScreen* main = [[NSScreen screens] firstObject];
    NSRect fr = main ? main.frame : NSMakeRect(0, 0, 1920, 1080);
    gRegionScale = main ? main.backingScaleFactor : 1.0;

    if (gRegionShot) { CGImageRelease(gRegionShot); gRegionShot = NULL; }
    gRegionShot = CGWindowListCreateImage(CGRectInfinite, kCGWindowListOptionOnScreenOnly,
                                          kCGNullWindowID, kCGWindowImageDefault);

    NSWindow* win = [[JarvisRegionWindow alloc] initWithContentRect:fr
                                                styleMask:NSWindowStyleMaskBorderless
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    [win setOpaque:NO];
    [win setBackgroundColor:[NSColor clearColor]];
    [win setHasShadow:NO];
    [win setLevel:NSScreenSaverWindowLevel];
    [win setIgnoresMouseEvents:NO];

    JarvisRegionView* view = [[JarvisRegionView alloc] initWithFrame:NSMakeRect(0, 0, fr.size.width, fr.size.height)];
    [win setContentView:view];
    gRegionWin = win;
    gRegionView = view;
    // Accessory-policy apps aren't frontmost by default; activate so the
    // overlay can take key focus and receive the Escape keyDown.
    [NSApp activateIgnoringOtherApps:YES];
    [win makeKeyAndOrderFront:nil];
    [win makeFirstResponder:view];
    [[NSCursor crosshairCursor] set];
}

static void jarvisRegionStart(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ region_start_impl(); });
}

// jarvisRegionClose / jarvisRegionCrop are called from goRegionFinish/Cancel,
// which run on the main thread (invoked from the Cocoa event handlers).
static void jarvisRegionClose(void) {
    if (gRegionWin) { [gRegionWin orderOut:nil]; gRegionWin = nil; }
    gRegionView = nil;
    if (gRegionShot) { CGImageRelease(gRegionShot); gRegionShot = NULL; }
    gRegionDragging = NO;
}

static unsigned char* jarvisRegionCrop(int x, int y, int w, int h, int* outLen) {
    *outLen = 0;
    if (!gRegionShot) return NULL;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (w <= 0 || h <= 0) return NULL;
    // Points -> backing pixels.
    CGFloat s = gRegionScale;
    CGRect px = CGRectMake(x * s, y * s, w * s, h * s);
    CGImageRef cropped = CGImageCreateWithImageInRect(gRegionShot, px);
    if (!cropped) return NULL;
    NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage:cropped];
    CGImageRelease(cropped);
    NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png) return NULL;
    NSUInteger len = [png length];
    unsigned char* out = (unsigned char*)malloc(len);
    memcpy(out, [png bytes], len);
    *outLen = (int)len;
    return out;
}

static void jarvisRegionFree(unsigned char* p) { if (p) free(p); }
*/
import "C"

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"unsafe"
)

type regionSelectionDarwin struct {
	mu        sync.Mutex
	active    atomic.Bool
	onCapture func([]byte, int, int)
	onCancel  func()
}

var activeRegionDarwin atomic.Pointer[regionSelectionDarwin]

func NewRegionSelectionService() RegionSelectionService {
	return &regionSelectionDarwin{}
}

func (s *regionSelectionDarwin) Start(onCapture func([]byte, int, int), onCancel func()) error {
	if !s.active.CompareAndSwap(false, true) {
		return fmt.Errorf("region selection already in progress")
	}
	s.mu.Lock()
	s.onCapture = onCapture
	s.onCancel = onCancel
	s.mu.Unlock()
	activeRegionDarwin.Store(s)
	C.jarvisRegionStart()
	return nil
}

func (s *regionSelectionDarwin) cancel() {
	cb := s.onCancel
	C.jarvisRegionClose()
	activeRegionDarwin.Store(nil)
	s.reset()
	if cb != nil {
		cb()
	}
}

func (s *regionSelectionDarwin) finish(x0, y0, x1, y1 int) {
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
	activeRegionDarwin.Store(nil)
	s.reset()
	log.Printf("[region] captured %dx%d, %d PNG bytes", w, h, len(png))
	if cb != nil {
		cb(png, w, h)
	}
}

func (s *regionSelectionDarwin) reset() {
	s.mu.Lock()
	s.onCapture = nil
	s.onCancel = nil
	s.mu.Unlock()
	s.active.Store(false)
}
