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

static BOOL jarvis_notch_display_kept_awake(void) {
    CFDictionaryRef status = NULL;
    if (IOPMCopyAssertionsStatus(&status) != kIOReturnSuccess || status == NULL) return NO;
    NSDictionary* levels = CFBridgingRelease(status);
    return [levels[@"PreventUserIdleDisplaySleep"] intValue] > 0
        || [levels[@"NoDisplaySleepAssertion"] intValue] > 0;
}

static BOOL jarvis_notch_fullscreen_app_in_front(void) {
    NSRunningApplication* front = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (front == nil) return NO;
    pid_t pid = front.processIdentifier;
    if (pid == [[NSProcessInfo processInfo] processIdentifier]) return NO;
    NSScreen* screen = [NSScreen screens].firstObject;
    if (screen == nil) return NO;
    CGSize size = screen.frame.size;
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (list == NULL) return NO;
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
            return YES;
        }
    }
    return NO;
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
    BOOL hide = jarvis_notch_fullscreen_app_in_front() && jarvis_notch_display_kept_awake();
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

// xy holds n points as x0, y0, x1, y1, ... in outline pixels (top-left origin).
static void jarvis_notch_set_outline(void* nswindow_ptr, const double* xy, int n) {
    if (!nswindow_ptr || xy == NULL || n < 3) return;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    // Copy the points now: the caller's memory is only good for this call.
    NSMutableData* copy = [NSMutableData dataWithBytes:xy length:sizeof(double) * 2 * (NSUInteger)n];
    jarvis_notch_on_main(^{
        const double* pts = (const double*)copy.bytes;
        CGFloat scale = win.backingScaleFactor > 0 ? win.backingScaleFactor : 1.0;
        NSView* content = win.contentView;
        CGFloat height = content.bounds.size.height;
        BOOL flipped = content.isFlipped;
        NSBezierPath* path = [NSBezierPath bezierPath];
        CGMutablePathRef cg = CGPathCreateMutable();
        for (int i = 0; i < n; i++) {
            CGFloat x = pts[2 * i] / scale;
            CGFloat y = pts[2 * i + 1] / scale;
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
        jarvis_notch_path = path;
        CALayer* mask = content.layer.mask;
        if ([mask isKindOfClass:[CAShapeLayer class]]) {
            [CATransaction begin];
            [CATransaction setDisableActions:YES];
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
static int jarvis_notch_cursor(void* nswindow_ptr, int* x, int* y) {
    *x = 0;
    *y = 0;
    if (!nswindow_ptr) return 0;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    __block NSRect f = NSZeroRect;
    dispatch_block_t read = ^{ f = win.frame; };
    if ([NSThread isMainThread]) read(); else dispatch_sync(dispatch_get_main_queue(), read);
    NSPoint p = [NSEvent mouseLocation];
    *x = (int)lround(p.x - f.origin.x);
    *y = (int)lround(NSMaxY(f) - p.y);
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
// on macOS), measured from the window's top left corner.
func platformNotchCursor(handle unsafe.Pointer) (int, int, bool) {
	if handle == nil {
		return 0, 0, false
	}
	var x, y C.int
	if C.jarvis_notch_cursor(handle, &x, &y) == 0 {
		return 0, 0, false
	}
	return int(x), int(y), true
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

// platformNotchSetOutline masks the web view to the notch's true outline. The
// mask is a shape layer, which is anti-aliased, so macOS needs no second window
// for the edge and the inner outline is not used.
func platformNotchSetOutline(handle unsafe.Pointer, shape, cut []notchPoint) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	if len(shape) < notchOutlineMinPoints {
		return fmt.Errorf("outline too short")
	}
	xy := make([]C.double, 0, len(shape)*2)
	for _, p := range shape {
		xy = append(xy, C.double(p.X), C.double(p.Y))
	}
	C.jarvis_notch_set_outline(handle, &xy[0], C.int(len(shape)))
	return nil
}

func platformNotchFocus(handle unsafe.Pointer, take bool) bool {
	if handle == nil {
		return false
	}
	return C.jarvis_notch_focus(handle, boolToCInt(take)) == 1
}
