//go:build darwin

package main

// The notch's window on macOS.
//
// NOT YET COMPILED OR RUN. This file was written alongside the Windows host on
// a machine that cannot build for macOS. It follows panels_darwin.go's rules
// (everything that touches AppKit runs on the main thread) and is the first
// thing to check when the branch meets a Mac.
//
// How each of the four differences is done here:
//   - Place: a borderless window at the top centre of the display that has the
//     menu bar, above the menu bar's level, on every Space.
//   - Shape: a shape-layer mask on the content view, so only the outline the
//     page reports is drawn. Clicks: the window ignores the mouse except while
//     the pointer is inside the outline, checked 30 times a second.
//   - Keyboard: the window is ordered front without becoming key. It becomes
//     key only when the page asks, and the app that was in front is activated
//     again when the page gives the keyboard back. A borderless NSWindow
//     refuses key status, so the window is re-classed to a small subclass that
//     allows it and is not pushed below the menu bar.
//   - Fullscreen video: hidden while the frontmost app has a window covering
//     the whole display AND something holds a "keep the display awake"
//     assertion, which is what a playing video does.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework QuartzCore -framework IOKit

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <libproc.h>
#import <objc/runtime.h>

// One notch per process.
static NSWindow* jarvis_notch_win = nil;
static NSBezierPath* jarvis_notch_path = nil; // window points, origin top-left, y down
static NSTimer* jarvis_notch_timer = nil;
static BOOL jarvis_notch_loaded = NO;
static BOOL jarvis_notch_hidden = NO;
static NSRunningApplication* jarvis_notch_previous_app = nil;

static void jarvis_notch_on_main(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_async(dispatch_get_main_queue(), block);
    }
}

static BOOL jarvis_notch_can_become_key(id self, SEL _cmd) { return YES; }
static NSRect jarvis_notch_constrain(id self, SEL _cmd, NSRect frame, NSScreen* screen) { return frame; }

// Re-class the window so it may take the keyboard although it is borderless,
// and so AppKit does not move it below the menu bar.
static void jarvis_notch_adopt(NSWindow* win) {
    Class base = object_getClass(win);
    const char* name = "JarvisNotchWindow";
    Class sub = objc_getClass(name);
    if (sub == Nil) {
        sub = objc_allocateClassPair(base, name, 0);
        if (sub == Nil) return;
        class_addMethod(sub, @selector(canBecomeKeyWindow), (IMP)jarvis_notch_can_become_key, "c@:");
        class_addMethod(sub, @selector(constrainFrameRect:toScreen:), (IMP)jarvis_notch_constrain,
            "{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}@");
        objc_registerClassPair(sub);
    }
    if (class_getSuperclass(sub) == base) {
        object_setClass(win, sub);
    }
}

// Is the app in front the one keeping the display awake? That is what a
// playing video does, and it is the Mac's whole test for "a video".
//
// The machine-wide answer is not enough: on the Windows machine this was first
// run on, some other program kept the display awake all day, and a browser put
// into fullscreen to read lost the notch. macOS says who is asking, so here
// the question is put to the app in front: itself, a helper process inside its
// bundle (a browser's), or the system's WebKit process that plays video for
// Safari and for any app built on it.
static BOOL jarvis_notch_app_keeps_display_awake(pid_t front) {
    CFDictionaryRef byPid = NULL;
    if (IOPMCopyAssertionsByProcess(&byPid) != kIOReturnSuccess || byPid == NULL) return NO;
    NSDictionary* all = CFBridgingRelease(byPid);
    NSString* bundle = [NSRunningApplication runningApplicationWithProcessIdentifier:front].bundleURL.path;
    NSString* inside = bundle.length > 0 ? [bundle stringByAppendingString:@"/"] : nil;
    for (NSNumber* holder in all) {
        NSArray* assertions = all[holder];
        if (![assertions isKindOfClass:[NSArray class]]) continue;
        BOOL holds = NO;
        for (NSDictionary* a in assertions) {
            if (![a isKindOfClass:[NSDictionary class]]) continue;
            if ([a[(__bridge NSString*)kIOPMAssertionLevelKey] intValue] <= 0) continue;
            NSString* type = a[(__bridge NSString*)kIOPMAssertionTypeKey];
            if (![type isKindOfClass:[NSString class]]) continue;
            if ([type isEqualToString:(__bridge NSString*)kIOPMAssertionTypePreventUserIdleDisplaySleep]
                || [type isEqualToString:(__bridge NSString*)kIOPMAssertionTypeNoDisplaySleep]) {
                holds = YES;
                break;
            }
        }
        if (!holds) continue;
        pid_t pid = holder.intValue;
        if (pid == front) return YES;
        char buf[PROC_PIDPATHINFO_MAXSIZE];
        if (proc_pidpath(pid, buf, sizeof(buf)) <= 0) continue;
        NSString* path = [NSString stringWithUTF8String:buf];
        if (path == nil) continue;
        if (inside != nil && [path hasPrefix:inside]) return YES;
        if ([path rangeOfString:@"/WebKit.framework/"].location != NSNotFound) return YES;
    }
    return NO;
}

// The app in front if it covers the whole main display, else 0.
static pid_t jarvis_notch_fullscreen_app_in_front(void) {
    NSRunningApplication* front = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (front == nil) return 0;
    pid_t pid = front.processIdentifier;
    if (pid == [[NSProcessInfo processInfo] processIdentifier]) return 0;
    NSScreen* screen = [NSScreen screens].firstObject;
    if (screen == nil) return 0;
    CGSize size = screen.frame.size;
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (list == NULL) return 0;
    NSArray* windows = CFBridgingRelease(list);
    for (NSDictionary* info in windows) {
        if ([info[(__bridge NSString*)kCGWindowOwnerPID] intValue] != pid) continue;
        if ([info[(__bridge NSString*)kCGWindowLayer] intValue] != 0) continue;
        CGRect bounds = CGRectZero;
        NSDictionary* b = info[(__bridge NSString*)kCGWindowBounds];
        if (b == nil || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)b, &bounds)) continue;
        // A fullscreen window covers the menu bar too; a zoomed one does not.
        if (bounds.origin.x <= 0.5 && bounds.origin.y <= 0.5
            && bounds.size.width >= size.width - 0.5 && bounds.size.height >= size.height - 0.5) {
            return pid;
        }
    }
    return 0;
}

static void jarvis_notch_tick(BOOL checkFullscreen) {
    NSWindow* win = jarvis_notch_win;
    if (win == nil) return;
    NSPoint p = [NSEvent mouseLocation];
    NSRect f = win.frame;
    NSPoint local = NSMakePoint(p.x - f.origin.x, NSMaxY(f) - p.y);
    BOOL inside = jarvis_notch_path != nil && [jarvis_notch_path containsPoint:local];
    [win setIgnoresMouseEvents:!inside];
    if (!checkFullscreen) return;
    pid_t front = jarvis_notch_fullscreen_app_in_front();
    BOOL hide = front > 0 && jarvis_notch_app_keeps_display_awake(front);
    if (hide == jarvis_notch_hidden) return;
    jarvis_notch_hidden = hide;
    if (hide) {
        [win orderOut:nil];
    } else if (jarvis_notch_loaded) {
        [win orderFrontRegardless];
    }
}

static void jarvis_notch_set_up(void* nswindow_ptr, int w, int h) {
    if (!nswindow_ptr) return;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    jarvis_notch_on_main(^{
        jarvis_notch_win = win;
        jarvis_notch_path = nil;
        jarvis_notch_loaded = NO;
        jarvis_notch_hidden = NO;
        jarvis_notch_previous_app = nil;

        [win setReleasedWhenClosed:NO];
        [win setStyleMask:NSWindowStyleMaskBorderless];
        jarvis_notch_adopt(win);
        [win setOpaque:NO];
        [win setBackgroundColor:[NSColor clearColor]];
        [win setHasShadow:NO];
        [win setMovable:NO];
        [win setHidesOnDeactivate:NO];
        [win setLevel:NSStatusWindowLevel + 1];
        [win setCollectionBehavior:
            NSWindowCollectionBehaviorCanJoinAllSpaces |
            NSWindowCollectionBehaviorStationary |
            NSWindowCollectionBehaviorFullScreenAuxiliary |
            NSWindowCollectionBehaviorIgnoresCycle];
        [win setIgnoresMouseEvents:YES];

        NSScreen* screen = [NSScreen screens].firstObject;
        if (screen != nil) {
            NSRect sf = screen.frame;
            [win setFrame:NSMakeRect(NSMidX(sf) - w / 2.0, NSMaxY(sf) - h, w, h) display:NO];
        }

        // Nothing shows until the page says what shape it is.
        NSView* content = win.contentView;
        content.wantsLayer = YES;
        CAShapeLayer* mask = [CAShapeLayer layer];
        mask.fillColor = [NSColor blackColor].CGColor;
        content.layer.mask = mask;
        [win orderOut:nil];

        if (jarvis_notch_timer != nil) [jarvis_notch_timer invalidate];
        __block int n = 0;
        jarvis_notch_timer = [NSTimer timerWithTimeInterval:1.0 / 30.0 repeats:YES block:^(NSTimer* t) {
            jarvis_notch_tick((n++ % 12) == 0);
        }];
        [[NSRunLoop mainRunLoop] addTimer:jarvis_notch_timer forMode:NSRunLoopCommonModes];
    });
}

static void jarvis_notch_tear_down(void) {
    jarvis_notch_on_main(^{
        if (jarvis_notch_timer != nil) [jarvis_notch_timer invalidate];
        jarvis_notch_timer = nil;
        jarvis_notch_win = nil;
        jarvis_notch_path = nil;
        jarvis_notch_previous_app = nil;
    });
}

static void jarvis_notch_reveal(void* nswindow_ptr) {
    if (!nswindow_ptr) return;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    jarvis_notch_on_main(^{
        jarvis_notch_loaded = YES;
        if (!jarvis_notch_hidden) [win orderFrontRegardless];
    });
}

// Size in the pixels an outline uses: points times the backing scale.
static void jarvis_notch_size(void* nswindow_ptr, int* w, int* h) {
    *w = 0;
    *h = 0;
    if (!nswindow_ptr) return;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    dispatch_block_t read = ^{
        CGFloat scale = win.backingScaleFactor > 0 ? win.backingScaleFactor : 1.0;
        *w = (int)lround(win.frame.size.width * scale);
        *h = (int)lround(win.frame.size.height * scale);
    };
    if ([NSThread isMainThread]) read(); else dispatch_sync(dispatch_get_main_queue(), read);
}

// xy holds every point of every polygon as x0, y0, x1, y1, ... in outline
// pixels (top-left origin); counts holds how many points each of the n polygons
// has. They become one silhouette, joined where they overlap: the polygons all
// turn the same way and both the mask and the hit test fill by winding.
static void jarvis_notch_set_outline(void* nswindow_ptr, const double* xy, const int* counts, int n) {
    if (!nswindow_ptr || n < 0 || (n > 0 && (xy == NULL || counts == NULL))) return;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    // No polygons: an empty mask, so nothing of the window is seen or hit.
    NSUInteger total = 0;
    for (int i = 0; i < n; i++) {
        if (counts[i] < 3) return;
        total += (NSUInteger)counts[i];
    }
    // Copy now: the caller's memory is only good for this call.
    NSData* points = n > 0 ? [NSData dataWithBytes:xy length:sizeof(double) * 2 * total] : [NSData data];
    NSData* sizes = n > 0 ? [NSData dataWithBytes:counts length:sizeof(int) * (NSUInteger)n] : [NSData data];
    jarvis_notch_on_main(^{
        const double* pts = (const double*)points.bytes;
        const int* each = (const int*)sizes.bytes;
        CGFloat scale = win.backingScaleFactor > 0 ? win.backingScaleFactor : 1.0;
        NSView* content = win.contentView;
        CGFloat height = content.bounds.size.height;
        BOOL flipped = content.isFlipped;
        NSBezierPath* path = [NSBezierPath bezierPath];
        path.windingRule = NSWindingRuleNonZero;
        CGMutablePathRef cg = CGPathCreateMutable();
        NSUInteger at = 0;
        for (int p = 0; p < n; p++) {
            for (int i = 0; i < each[p]; i++, at++) {
                CGFloat x = pts[2 * at] / scale;
                CGFloat y = pts[2 * at + 1] / scale;
                CGFloat ly = flipped ? y : height - y;
                if (i == 0) {
                    [path moveToPoint:NSMakePoint(x, y)];
                    CGPathMoveToPoint(cg, NULL, x, ly);
                } else {
                    [path lineToPoint:NSMakePoint(x, y)];
                    CGPathAddLineToPoint(cg, NULL, x, ly);
                }
            }
            [path closePath];
            CGPathCloseSubpath(cg);
        }
        jarvis_notch_path = path;
        CALayer* mask = content.layer.mask;
        if ([mask isKindOfClass:[CAShapeLayer class]]) {
            [CATransaction begin];
            [CATransaction setDisableActions:YES];
            ((CAShapeLayer*)mask).fillRule = kCAFillRuleNonZero;
            ((CAShapeLayer*)mask).path = cg;
            [CATransaction commit];
        }
        CGPathRelease(cg);
    });
}

// The pointer's place in points, from the window's top left corner, y down.
// Returns 0 when there is no window. Reads only, so it may be called from any
// thread: NSEvent's mouseLocation is safe off the main thread, and the frame is
// read through the main queue when the caller is elsewhere.
static int jarvis_notch_cursor(void* nswindow_ptr, int* x, int* y, int* down) {
    *x = 0;
    *y = 0;
    *down = 0;
    if (!nswindow_ptr) return 0;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    __block NSRect f = NSZeroRect;
    dispatch_block_t read = ^{ f = win.frame; };
    if ([NSThread isMainThread]) read(); else dispatch_sync(dispatch_get_main_queue(), read);
    NSPoint p = [NSEvent mouseLocation];
    *x = (int)lround(p.x - f.origin.x);
    *y = (int)lround(NSMaxY(f) - p.y);
    // Bit 0 is the main button, whichever side the person has it on.
    *down = ([NSEvent pressedMouseButtons] & 1) ? 1 : 0;
    return 1;
}

// Returns 1 when the notch has the keyboard afterwards.
static int jarvis_notch_focus(void* nswindow_ptr, int take) {
    if (!nswindow_ptr) return 0;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    __block int has = 0;
    dispatch_block_t work = ^{
        if (take) {
            NSRunningApplication* front = [[NSWorkspace sharedWorkspace] frontmostApplication];
            if (front != nil && front.processIdentifier != [[NSProcessInfo processInfo] processIdentifier]) {
                jarvis_notch_previous_app = front;
            }
            [NSApp activateIgnoringOtherApps:YES];
            [win makeKeyAndOrderFront:nil];
            has = win.isKeyWindow ? 1 : 0;
        } else {
            NSRunningApplication* previous = jarvis_notch_previous_app;
            jarvis_notch_previous_app = nil;
            if (previous != nil && !previous.terminated) {
                [previous activateWithOptions:0];
            }
            has = 0;
        }
    };
    if ([NSThread isMainThread]) work(); else dispatch_sync(dispatch_get_main_queue(), work);
    return has;
}
*/
import "C"

import (
	"fmt"
	"log"
	"unsafe"
)

func platformNotchSetUp(handle unsafe.Pointer, done <-chan struct{}) {
	if handle == nil {
		return
	}
	C.jarvis_notch_set_up(handle, C.int(notchWindowW), C.int(notchWindowH))
	log.Printf("[notch] window %dx%d at the top centre of the main display", notchWindowW, notchWindowH)
}

func platformNotchTearDown(handle unsafe.Pointer) {
	C.jarvis_notch_tear_down()
}

// platformNotchCursor is where the pointer is, in the page's own pixels (points
// on macOS), measured from the window's top left corner, and whether the main
// mouse button is down.
func platformNotchCursor(handle unsafe.Pointer) (int, int, bool, bool) {
	if handle == nil {
		return 0, 0, false, false
	}
	var x, y, down C.int
	if C.jarvis_notch_cursor(handle, &x, &y, &down) == 0 {
		return 0, 0, false, false
	}
	return int(x), int(y), down != 0, true
}

func platformNotchReveal(handle unsafe.Pointer) {
	if handle == nil {
		return
	}
	C.jarvis_notch_reveal(handle)
	log.Printf("[notch] page loaded, window shown without focus")
}

func platformNotchWindowSize(handle unsafe.Pointer) (int, int) {
	var w, h C.int
	C.jarvis_notch_size(handle, &w, &h)
	if w <= 0 || h <= 0 {
		return notchWindowW, notchWindowH
	}
	return int(w), int(h)
}

// platformNotchSetOutline masks the web view to the notch's true silhouette.
// The mask is a shape layer, which is anti-aliased, so macOS needs no second
// window for the edge and the inner outlines are not used.
func platformNotchSetOutline(handle unsafe.Pointer, shapes [][]notchVertex, cuts [][]notchPoint) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	xy := make([]C.double, 0, 256)
	counts := make([]C.int, 0, len(shapes))
	for _, shape := range shapes {
		if len(shape) < notchOutlineMinPoints {
			continue
		}
		for _, p := range shape {
			xy = append(xy, C.double(p.X), C.double(p.Y))
		}
		counts = append(counts, C.int(len(shape)))
	}
	if len(counts) == 0 {
		// Nothing is on screen.
		C.jarvis_notch_set_outline(handle, nil, nil, 0)
		return nil
	}
	C.jarvis_notch_set_outline(handle, &xy[0], &counts[0], C.int(len(counts)))
	return nil
}

// On the Mac the fullscreen rule lives in the window's own code and does not
// yet hear this: a question asked during a fullscreen video waits there until
// the video ends. Written down in docs/notch/README.md as a limit.
func platformNotchAsking(handle unsafe.Pointer, asking bool) {}

func platformNotchFocus(handle unsafe.Pointer, take bool) bool {
	if handle == nil {
		return false
	}
	return C.jarvis_notch_focus(handle, boolToCInt(take)) == 1
}
