//go:build darwin

package main

// The notch's window on macOS.
//
// First run on a Mac: 19 November 2026 (an M4 MacBook Air, macOS 27.2). It
// built, and crashed three times out of three the moment the window was set
// up. The cause is written down at jarvis_notch_adopt. The second run, the
// same day: the window opened and the page loaded, with most of the notch
// behind the display's camera housing (jarvis_notch_housing_of). What a
// person does on it had still not been tried when this was written. It
// follows panels_darwin.go's rules (everything that touches AppKit runs on
// the main thread).
//
// How each of the four differences is done here:
//   - Place: a borderless window at the top centre of the display that has the
//     menu bar, above the menu bar's level, on every Space. A MacBook's own
//     camera housing sits in exactly that place, and nothing drawn behind it
//     can be seen: the page is told how wide and how tall the housing is
//     (jarvis_notch_housing), and draws itself round it.
//   - Shape: a shape-layer mask on the content view, so only the outline the
//     page reports is drawn. Clicks: the window ignores the mouse except while
//     the pointer is inside the outline, checked 30 times a second.
//   - Keyboard: the window is ordered front without becoming key. It becomes
//     key only when the page asks, and the app that was in front is activated
//     again when the page gives the keyboard back. A borderless NSWindow
//     refuses key status, so the window is re-classed to a small subclass that
//     allows it and is not pushed below the menu bar.
//   - Fullscreen video: hidden while the frontmost app has a window covering
//     the whole display AND that app keeps the display awake itself, which is
//     what a playing video does, and not while the page asks a question. The
//     window's timer only reads those two facts and hands them to Go
//     (goNotchFacts); the rule is the one every platform uses
//     (notch_host_ctl.go), and it shows and hides the window from there.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework QuartzCore -framework IOKit

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <libproc.h>
#import <objc/runtime.h>

// Told what the window's timer sees, every 400 ms (notch_host_ctl.go,
// notchFactsRelay). It puts the facts down and comes back at once.
extern void goNotchFacts(int fullscreen, int awake);

// One notch per process.
static NSWindow* jarvis_notch_win = nil;
static NSBezierPath* jarvis_notch_path = nil; // window points, origin top-left, y down
static NSTimer* jarvis_notch_timer = nil;
static NSRunningApplication* jarvis_notch_previous_app = nil;

static void jarvis_notch_on_main(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_async(dispatch_get_main_queue(), block);
    }
}

// The window the notch lives in must be able to take the keyboard although it
// is borderless, and must not be pushed below the menu bar. Both are answers a
// window gives about itself: canBecomeKeyWindow and constrainFrameRect:toScreen:.
//
// They are NOT changed by giving the window a class of its own, which is what
// this file did at first. AppKit watches a window's properties, and it does so
// by putting the window into a class it makes for the purpose, with its own
// bookkeeping stored in that class. A subclass of that class made here has
// none of it, so the first watched setter after the change (setOpaque:) read
// whatever lay behind the class: "-[__NSCFConstantString objectForKey:]:
// unrecognized selector", a trap, "os_unfair_lock is corrupt". Three crashes,
// three messages, one cause.
//
// So the two answers are changed where the window's real class gives them,
// and only for the one window that is the notch. Every other window of the
// app gets the answer it always got.
static IMP jarvis_notch_plain_can_key = NULL;
static IMP jarvis_notch_plain_constrain = NULL;

static BOOL jarvis_notch_can_become_key(id self, SEL _cmd) {
    if (self == (id)jarvis_notch_win) return YES;
    if (jarvis_notch_plain_can_key == NULL) return NO;
    return ((BOOL (*)(id, SEL))jarvis_notch_plain_can_key)(self, _cmd);
}

static NSRect jarvis_notch_constrain(id self, SEL _cmd, NSRect frame, NSScreen* screen) {
    if (self == (id)jarvis_notch_win || jarvis_notch_plain_constrain == NULL) return frame;
    return ((NSRect (*)(id, SEL, NSRect, NSScreen*))jarvis_notch_plain_constrain)(self, _cmd, frame, screen);
}

// Once for the process. `[win class]` is the class the window was made as:
// AppKit's watching class answers with the class it stands in for.
static void jarvis_notch_adopt(NSWindow* win) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class made = [win class];
        Method key = class_getInstanceMethod(made, @selector(canBecomeKeyWindow));
        if (key != NULL) jarvis_notch_plain_can_key = method_setImplementation(key, (IMP)jarvis_notch_can_become_key);
        Method constrain = class_getInstanceMethod(made, @selector(constrainFrameRect:toScreen:));
        if (constrain != NULL) jarvis_notch_plain_constrain = method_setImplementation(constrain, (IMP)jarvis_notch_constrain);
    });
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

// The camera housing of the display the notch is on: how wide and how tall,
// in points. Both 0 where there is none (an external display, an older Mac, a
// display mode that keeps everything below the housing).
//
// The second run on a Mac (19 November 2026) is why this exists: the shape
// came up where it belongs, at the top centre, and most of it lay behind the
// housing. The system says how much of the top is taken (the safe area) and
// what is left free to each side of it (the two auxiliary areas); what lies
// between those two is the housing.
static void jarvis_notch_housing_of(NSScreen* screen, CGFloat* w, CGFloat* h) {
    *w = 0;
    *h = 0;
    if (screen == nil) return;
    if (@available(macOS 12.0, *)) {
        CGFloat top = screen.safeAreaInsets.top;
        if (top <= 0) return;
        NSRect left = screen.auxiliaryTopLeftArea;
        NSRect right = screen.auxiliaryTopRightArea;
        CGFloat across = screen.frame.size.width;
        CGFloat wide = 0;
        if (!NSIsEmptyRect(left) && !NSIsEmptyRect(right)) wide = NSMinX(right) - NSMaxX(left);
        // The top is taken and the system does not say by how much across: a
        // housing is there all the same. Taken as a little wider than any
        // MacBook's is (they are an eighth of the display across, or less): a
        // notch drawn round too wide a housing is whole, one drawn round none
        // is hidden.
        if (wide <= 0 || wide >= across) wide = round(across * 0.14);
        *w = wide;
        *h = top;
    }
}

// What the system says of the display the notch is on, for the log: how large
// it is in points, how much of its top is taken, and how much is free to each
// side of that. One line of this from a real machine says more than a guess.
static void jarvis_notch_display(int* w, int* h, int* top, int* left, int* right) {
    *w = *h = *top = *left = *right = 0;
    dispatch_block_t read = ^{
        NSScreen* screen = [NSScreen screens].firstObject;
        if (screen == nil) return;
        *w = (int)lround(screen.frame.size.width);
        *h = (int)lround(screen.frame.size.height);
        if (@available(macOS 12.0, *)) {
            *top = (int)lround(screen.safeAreaInsets.top);
            *left = (int)lround(screen.auxiliaryTopLeftArea.size.width);
            *right = (int)lround(screen.auxiliaryTopRightArea.size.width);
        }
    };
    if ([NSThread isMainThread]) read(); else dispatch_sync(dispatch_get_main_queue(), read);
}

// Where the window belongs: the top centre of the display that has the menu
// bar. Under a housing, centred on the housing, which is where the system
// puts it but not something to take for granted.
static NSRect jarvis_notch_frame_on(NSScreen* screen, CGFloat w, CGFloat h) {
    NSRect sf = screen.frame;
    CGFloat mid = NSMidX(sf);
    if (@available(macOS 12.0, *)) {
        CGFloat hw = 0, hh = 0;
        jarvis_notch_housing_of(screen, &hw, &hh);
        NSRect left = screen.auxiliaryTopLeftArea, right = screen.auxiliaryTopRightArea;
        if (hw > 0 && !NSIsEmptyRect(left) && !NSIsEmptyRect(right) && NSMinX(right) > NSMaxX(left)) {
            mid = (NSMaxX(left) + NSMinX(right)) / 2.0;
        }
    }
    return NSMakeRect(round(mid - w / 2.0), NSMaxY(sf) - h, w, h);
}

// The housing in whole points, for the page. May be called from any thread.
static void jarvis_notch_housing(int* w, int* h) {
    *w = 0;
    *h = 0;
    dispatch_block_t read = ^{
        CGFloat hw = 0, hh = 0;
        jarvis_notch_housing_of([NSScreen screens].firstObject, &hw, &hh);
        *w = (int)lround(hw);
        *h = (int)lround(hh);
    };
    if ([NSThread isMainThread]) read(); else dispatch_sync(dispatch_get_main_queue(), read);
}

static void jarvis_notch_tick(BOOL checkFullscreen) {
    NSWindow* win = jarvis_notch_win;
    if (win == nil) return;
    NSPoint p = [NSEvent mouseLocation];
    NSRect f = win.frame;
    NSPoint local = NSMakePoint(p.x - f.origin.x, NSMaxY(f) - p.y);
    BOOL inside = jarvis_notch_path != nil && [jarvis_notch_path containsPoint:local];
    // Told only when it changes: thirty times a second is how often it is asked, not how often it differs.
    if (win.ignoresMouseEvents == inside) [win setIgnoresMouseEvents:!inside];
    if (!checkFullscreen) return;
    // The display it hangs from can change under it: another one plugged in
    // and made the main one, the lid closed, a new resolution.
    NSScreen* screen = [NSScreen screens].firstObject;
    if (screen != nil) {
        NSRect want = jarvis_notch_frame_on(screen, f.size.width, f.size.height);
        if (fabs(want.origin.x - f.origin.x) > 0.5 || fabs(want.origin.y - f.origin.y) > 0.5) {
            [win setFrame:want display:YES];
        }
    }
    // On the Mac the app in front keeping the display awake itself is both
    // "the display is kept awake" and "a video plays": Go decides.
    pid_t front = jarvis_notch_fullscreen_app_in_front();
    BOOL awake = front > 0 && jarvis_notch_app_keeps_display_awake(front);
    goNotchFacts(front > 0 ? 1 : 0, awake ? 1 : 0);
}

static void jarvis_notch_set_up(void* nswindow_ptr, int w, int h) {
    if (!nswindow_ptr) return;
    NSWindow* win = (__bridge NSWindow*)nswindow_ptr;
    jarvis_notch_on_main(^{
        jarvis_notch_win = win;
        jarvis_notch_path = nil;
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
        if (screen != nil) [win setFrame:jarvis_notch_frame_on(screen, w, h) display:NO];

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

// Shows the window without making it key, or orders it out. Always queued,
// even on the main thread, never run in place: Go decides on more than one
// thread, and a show done in place could overtake a hide queued before it.
// The main queue runs them in the order they were asked.
static void jarvis_notch_show(int show) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWindow* win = jarvis_notch_win;
        if (win == nil) return;
        if (show) {
            [win orderFrontRegardless];
        } else {
            [win orderOut:nil];
        }
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
    // A window nobody can see does not take the keyboard from the film, and
    // making it key would bring it back over the film: Go refuses that before
    // it asks (notchHost.Focus).
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
	"sync/atomic"
	"unsafe"
)

// The notch's window rule (notch_host_ctl.go) for the one window there is.
var notchMacHost atomic.Pointer[notchHost]

// What the window's timer sees reaches the rule on a goroutine: the timer
// runs on the main thread, which waits for nothing.
var notchMacFacts = newNotchFactsRelay(func(f notchHostFacts) {
	host := notchMacHost.Load()
	if host == nil {
		return
	}
	if changed, hidden := host.Tick(f); changed && hidden {
		log.Printf("[notch] hidden: a video is playing in a fullscreen app")
	} else if changed {
		log.Printf("[notch] shown again (fullscreen app in front: %v, it keeps the display awake: %v)", f.FullscreenInFront, f.DisplayKeptAwake)
	}
})

// notchMacWindow is the window's half of the rule (notchHostWindow).
type notchMacWindow struct{ handle unsafe.Pointer }

func (w notchMacWindow) Show() { C.jarvis_notch_show(1) }
func (w notchMacWindow) Hide() { C.jarvis_notch_show(0) }
func (w notchMacWindow) Focus(take bool) bool {
	return C.jarvis_notch_focus(w.handle, boolToCInt(take)) == 1
}

func platformNotchSetUp(handle unsafe.Pointer, done <-chan struct{}) {
	if handle == nil {
		return
	}
	// Before the window's timer starts, so its first facts find the rule.
	// Out of sight, it takes no Esc and no yes (NotchService.setHidden).
	notchMacHost.Store(newNotchHost(notchMacWindow{handle}, notch.setHidden))
	C.jarvis_notch_set_up(handle, C.int(notchWindowW), C.int(notchWindowH))
	log.Printf("[notch] window %dx%d at the top centre of the main display", notchWindowW, notchWindowH)
	var dw, dh, top, left, right C.int
	C.jarvis_notch_display(&dw, &dh, &top, &left, &right)
	log.Printf("[notch] display %dx%d points, %d of its top taken, %d free to the left of that and %d to the right", int(dw), int(dh), int(top), int(left), int(right))
	// Read here and kept (notchHousingLook), so that the look's pointers know
	// it before the page has asked for it.
	if w, h := notchHousingLook(); w > 0 && h > 0 {
		log.Printf("[notch] this display has a camera housing, %dx%d points: the notch is drawn round it", w, h)
	} else {
		log.Printf("[notch] this display has no camera housing")
	}
}

func platformNotchTearDown(handle unsafe.Pointer) {
	if host := notchMacHost.Swap(nil); host != nil {
		host.Detach()
	}
	C.jarvis_notch_tear_down()
}

// platformNotchHousing is the camera housing of the display the notch is on,
// in the page's own pixels (points): how wide, how tall. Both 0 without one.
//
// It asks the main thread and waits for the answer, so it is never called
// with a lock held: the main thread may be waiting for that lock, inside a
// tap, and then neither ever moves again. Whoever holds a lock reads
// notchHousingKept instead (notch_host.go).
func platformNotchHousing() (int, int) {
	var w, h C.int
	C.jarvis_notch_housing(&w, &h)
	return int(w), int(h)
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
	host := notchMacHost.Load()
	if handle == nil || host == nil {
		return
	}
	// A page loaded while the window is out of sight is told so anew.
	host.Loaded()
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

// platformNotchAsking is the page saying whether it shows a question that
// waits for an answer. A notch hidden for a fullscreen video comes back at
// once for one, as on Windows; the next look of the timer hides it again
// when the question is gone and the video still plays.
func platformNotchAsking(handle unsafe.Pointer, asking bool) {
	if host := notchMacHost.Load(); host != nil {
		host.Asking(asking)
	}
}

// platformNotchInputStalled holds the taps off while the main thread stands
// still, and lets them go when it runs again (notch_pulse.go). All three taps
// are served by the main thread, and a tap that is not served keeps every key
// and every click on the machine waiting until the system gives up on it.
// Called from the pulse's goroutine: nothing here waits for the main thread.
func platformNotchInputStalled(stalled bool) {
	notchKeysTapHold(stalled)
	notchLookTapHold(stalled)
	notchWatchTapHold(stalled)
}

// platformNotchFocus takes the keyboard for the page or gives it back. A
// hidden window does not take it (notchHost.Focus).
func platformNotchFocus(handle unsafe.Pointer, take bool) bool {
	host := notchMacHost.Load()
	if handle == nil || host == nil {
		return false
	}
	return host.Focus(take)
}
