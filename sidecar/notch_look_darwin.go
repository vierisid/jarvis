//go:build darwin

package main

// Look at this, where is, and Jarvis's own pointers, on the Mac.
//
// NOT YET RUN. Written on a machine that cannot build for macOS; GitHub's Mac
// job compiles it and nothing more. It is to be tried by hand in pass 14 with
// everything else on the Mac.
//
// It does what notch_look_windows.go does, with the Mac's own means:
//
//   - the watch on the pointer is an event tap, switched on only while the
//     look wants the pointer (the talk pair is down, a line is being drawn, or
//     a click on a thing that was pointed at is waited for). It is an active
//     tap, because a press that begins a line is kept from the app in front.
//     It needs the Accessibility permission, like the notch's keys.
//   - the ink, the tag and the pointers are layers in one window that lies
//     over a display, lets every click through and never has the keyboard.
//   - what a thing is comes from the accessibility interface, asked of the
//     program whose window is at the place (notch_mac_darwin.go).
//
// The line, the tag and the pointers are drawn by the system from what they
// are told to be (a path, a few words, a place to go to), so there is no
// thread here that paints: everything is said on the main thread and
// forgotten.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework QuartzCore -framework ApplicationServices

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>

extern int goNotchLookMouse(int kind, int x, int y);

// ---------------------------------------------------------------------------
// The watch on the pointer
// ---------------------------------------------------------------------------

static CFMachPortRef jarvis_look_tap = NULL;
static CFRunLoopSourceRef jarvis_look_tap_source = NULL;
static int jarvis_look_tap_wanted = 0;

// kind: 1 the left button went down, 2 it came up, 3 the pointer moved, 4 it
// moved with the button held, 5 the right button came up.
static CGEventRef jarvis_look_tap_callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
	if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
		if (jarvis_look_tap != NULL && jarvis_look_tap_wanted) CGEventTapEnable(jarvis_look_tap, true);
		return event;
	}
	// A press a program made is not the person's: Jarvis itself presses in other apps.
	if (CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID) != 0) return event;
	int kind = 0;
	switch (type) {
		case kCGEventLeftMouseDown: kind = 1; break;
		case kCGEventLeftMouseUp: kind = 2; break;
		case kCGEventMouseMoved: kind = 3; break;
		case kCGEventLeftMouseDragged: kind = 4; break;
		case kCGEventRightMouseUp: kind = 5; break;
		default: return event;
	}
	CGPoint p = CGEventGetLocation(event);
	return goNotchLookMouse(kind, (int)p.x, (int)p.y) ? NULL : event;
}

// Switches the watch on or off. 1 when it is as asked, 0 when the system
// refused the tap.
static int jarvis_look_tap_set(int on) {
	jarvis_look_tap_wanted = on;
	if (jarvis_look_tap == NULL) {
		if (!on) return 1;
		CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp)
			| CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseUp);
		CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
			mask, jarvis_look_tap_callback, NULL);
		if (tap == NULL) return 0;
		CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
		if (source == NULL) {
			CFRelease(tap);
			return 0;
		}
		jarvis_look_tap = tap;
		jarvis_look_tap_source = source;
		CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
		CFRunLoopWakeUp(CFRunLoopGetMain());
	}
	CGEventTapEnable(jarvis_look_tap, on ? true : false);
	return 1;
}

// ---------------------------------------------------------------------------
// The window everything is drawn in
// ---------------------------------------------------------------------------

#define JARVIS_LOOK_HANDS 3

static NSWindow *gLookWin = nil;
static CALayer *gLookRoot = nil;
static CGRect gLookScreen;
static CAShapeLayer *gLookInkEdge = nil;
static CAShapeLayer *gLookInkLine = nil;
static CGMutablePathRef gLookInkPath = NULL;
static CALayer *gLookTag = nil;
static CALayer *gLookHover = nil;
static CAShapeLayer *gLookRing = nil;
static CAShapeLayer *gLookHands[JARVIS_LOOK_HANDS] = { nil, nil, nil };
static int gLookHandGen[JARVIS_LOOK_HANDS] = { 0, 0, 0 };
static int gLookRingGen = 0;

static void jarvis_look_on_main(dispatch_block_t work) {
	if ([NSThread isMainThread]) work();
	else dispatch_async(dispatch_get_main_queue(), work);
}

// A colour, made once and kept: a layer is handed a colour it does not own,
// and one that belonged to an object already let go would be gone under it.
// Only a handful are ever made. Main thread only.
static CGColorRef jarvis_look_rgb(int r, int g, int b, CGFloat alpha) {
	static CGColorRef made[16];
	static int keys[16][4];
	static int count = 0;
	int a = (int)(alpha * 1000);
	for (int i = 0; i < count; i++) {
		if (keys[i][0] == r && keys[i][1] == g && keys[i][2] == b && keys[i][3] == a) return made[i];
	}
	CGColorRef colour = CGColorCreateGenericRGB(r / 255.0, g / 255.0, b / 255.0, alpha);
	if (count < 16) {
		keys[count][0] = r;
		keys[count][1] = g;
		keys[count][2] = b;
		keys[count][3] = a;
		made[count++] = colour;
	}
	return colour;
}

static CGColorRef jarvis_look_citron(CGFloat alpha) { return jarvis_look_rgb(0xD6, 0xFF, 0x5C, alpha); }
static CGColorRef jarvis_look_dark(CGFloat alpha) { return jarvis_look_rgb(0x13, 0x16, 0x1A, alpha); }

// Takes the window off the screen when nothing is on it.
static void jarvis_look_rest(void) {
	if (gLookWin == nil) return;
	if (gLookInkLine != nil || gLookTag != nil || gLookHover != nil || gLookRing != nil) return;
	for (int i = 0; i < JARVIS_LOOK_HANDS; i++) if (gLookHands[i] != nil) return;
	[gLookWin orderOut:nil];
}

// Puts the window over a display. Everything on it is placed from that
// display's top left corner, y going down.
static void jarvis_look_ensure(CGRect screen) {
	NSScreen *first = [NSScreen screens].firstObject;
	CGFloat top = first != nil ? first.frame.size.height : screen.origin.y + screen.size.height;
	NSRect frame = NSMakeRect(screen.origin.x, top - screen.origin.y - screen.size.height, screen.size.width, screen.size.height);
	if (gLookWin == nil) {
		NSWindow *win = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
		[win setReleasedWhenClosed:NO];
		[win setOpaque:NO];
		[win setBackgroundColor:[NSColor clearColor]];
		[win setHasShadow:NO];
		[win setLevel:NSScreenSaverWindowLevel];
		// It lets every click through, and never has the keyboard.
		[win setIgnoresMouseEvents:YES];
		[win setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorTransient
			| NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorFullScreenAuxiliary];
		NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
		CALayer *root = [CALayer layer];
		// Counted from the top, like everything else here.
		root.geometryFlipped = YES;
		view.layer = root;
		view.wantsLayer = YES;
		[win setContentView:view];
		gLookWin = win;
		gLookRoot = root;
	} else if (!CGRectEqualToRect(screen, gLookScreen)) {
		[gLookWin setFrame:frame display:NO];
	}
	gLookScreen = screen;
	[gLookWin orderFrontRegardless];
}

static CGPoint jarvis_look_local(double x, double y) {
	return CGPointMake(x - gLookScreen.origin.x, y - gLookScreen.origin.y);
}

static void jarvis_look_drop(CALayer *layer) {
	if (layer != nil) [layer removeFromSuperlayer];
}

// ---------------------------------------------------------------------------
// The ink, and the tag
// ---------------------------------------------------------------------------

static void jarvis_look_ink_clear_impl(void) {
	jarvis_look_drop(gLookInkEdge);
	jarvis_look_drop(gLookInkLine);
	jarvis_look_drop(gLookTag);
	gLookInkEdge = nil;
	gLookInkLine = nil;
	gLookTag = nil;
	if (gLookInkPath != NULL) {
		CGPathRelease(gLookInkPath);
		gLookInkPath = NULL;
	}
}

static void jarvis_look_ring_clear_impl(void) {
	gLookRingGen++;
	jarvis_look_drop(gLookRing);
	gLookRing = nil;
	jarvis_look_drop(gLookTag);
	gLookTag = nil;
}

static void jarvis_look_hands_clear_impl(void) {
	for (int i = 0; i < JARVIS_LOOK_HANDS; i++) {
		gLookHandGen[i]++;
		jarvis_look_drop(gLookHands[i]);
		gLookHands[i] = nil;
	}
}

static void jarvis_look_ink_show(void) {
	if (gLookInkPath == NULL) return;
	CGPathRef copy = CGPathCreateCopy(gLookInkPath);
	[CATransaction begin];
	[CATransaction setDisableActions:YES];
	gLookInkEdge.path = copy;
	gLookInkLine.path = copy;
	[CATransaction commit];
	CGPathRelease(copy);
}

static CAShapeLayer *jarvis_look_stroke(CGColorRef colour, CGFloat width) {
	CAShapeLayer *layer = [CAShapeLayer layer];
	layer.fillColor = NULL;
	layer.strokeColor = colour;
	layer.lineWidth = width;
	layer.lineCap = kCALineCapRound;
	layer.lineJoin = kCALineJoinRound;
	return layer;
}

// A line is begun. It is a marker, not a pen: one soft colour, with a thin
// dark edge so that it can be seen on a white window.
static void jarvis_look_ink_begin(double x, double y, double sx, double sy, double sw, double sh) {
	jarvis_look_on_main(^{
		jarvis_look_ink_clear_impl();
		jarvis_look_ring_clear_impl();
		jarvis_look_hands_clear_impl();
		jarvis_look_drop(gLookHover);
		gLookHover = nil;
		jarvis_look_ensure(CGRectMake(sx, sy, sw, sh));
		CGPoint p = jarvis_look_local(x, y);
		gLookInkPath = CGPathCreateMutable();
		CGPathMoveToPoint(gLookInkPath, NULL, p.x, p.y);
		// A dot where the press was: a click leaves a mark too.
		CGPathAddLineToPoint(gLookInkPath, NULL, p.x + 0.1, p.y);
		gLookInkEdge = jarvis_look_stroke(jarvis_look_dark(0.26), 14.5);
		gLookInkLine = jarvis_look_stroke(jarvis_look_citron(0.62), 12.0);
		[gLookRoot addSublayer:gLookInkEdge];
		[gLookRoot addSublayer:gLookInkLine];
		jarvis_look_ink_show();
	});
}

static void jarvis_look_ink_line(double x, double y) {
	jarvis_look_on_main(^{
		if (gLookInkPath == NULL) return;
		CGPoint p = jarvis_look_local(x, y);
		CGPathAddLineToPoint(gLookInkPath, NULL, p.x, p.y);
		jarvis_look_ink_show();
	});
}

static void jarvis_look_ink_clear(void) {
	jarvis_look_on_main(^{
		jarvis_look_ink_clear_impl();
		jarvis_look_rest();
	});
}

// A dark plate with a few words on it, above a rectangle of the screen (or
// under it when there is no room above), kept inside the display.
static CALayer *jarvis_look_plate(NSString *text, CGRect about) {
	NSFont *font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
	CGSize size = [text sizeWithAttributes:@{ NSFontAttributeName: font }];
	CGFloat textW = MIN(ceil(size.width) + 2, 460.0), textH = ceil(size.height);
	CGFloat w = textW + 20, h = textH + 12;
	CGFloat left = gLookScreen.origin.x + 4, right = gLookScreen.origin.x + gLookScreen.size.width - 4;
	CGFloat x = CGRectGetMidX(about) - w / 2;
	if (x + w > right) x = right - w;
	if (x < left) x = left;
	CGFloat y = CGRectGetMinY(about) - 10 - h;
	if (y < gLookScreen.origin.y + 4) y = CGRectGetMaxY(about) + 10;
	CALayer *plate = [CALayer layer];
	plate.frame = CGRectMake(x - gLookScreen.origin.x, y - gLookScreen.origin.y, w, h);
	plate.backgroundColor = jarvis_look_dark(0.94);
	plate.cornerRadius = 9;
	plate.zPosition = 5;
	CATextLayer *words = [CATextLayer layer];
	words.string = text;
	words.font = (__bridge CFTypeRef)font;
	words.fontSize = 13;
	words.foregroundColor = jarvis_look_rgb(0xEE, 0xF1, 0xF4, 1.0);
	words.truncationMode = kCATruncationEnd;
	words.contentsScale = gLookWin != nil ? gLookWin.backingScaleFactor : 2.0;
	words.frame = CGRectMake(10, 6, textW, textH);
	[plate addSublayer:words];
	return plate;
}

static void jarvis_look_tag(const char *utf8, double x, double y, double w, double h) {
	NSString *text = utf8 != NULL ? [NSString stringWithUTF8String:utf8] : nil;
	jarvis_look_on_main(^{
		jarvis_look_drop(gLookTag);
		gLookTag = nil;
		if (gLookWin == nil || gLookRoot == nil || text == nil || text.length == 0) return;
		gLookTag = jarvis_look_plate(text, CGRectMake(x, y, w, h));
		[gLookRoot addSublayer:gLookTag];
	});
}

// The words beside the person's own pointer: what would be put here. No words takes them away.
static void jarvis_look_hover(const char *utf8, double x, double y, double sx, double sy, double sw, double sh) {
	NSString *text = utf8 != NULL ? [NSString stringWithUTF8String:utf8] : nil;
	jarvis_look_on_main(^{
		jarvis_look_drop(gLookHover);
		gLookHover = nil;
		if (text == nil || text.length == 0) {
			jarvis_look_rest();
			return;
		}
		jarvis_look_ensure(CGRectMake(sx, sy, sw, sh));
		gLookHover = jarvis_look_plate(text, CGRectMake(x - 10, y - 10, 20, 20));
		[gLookRoot addSublayer:gLookHover];
	});
}

// ---------------------------------------------------------------------------
// The pointers, and the ring
// ---------------------------------------------------------------------------

// Jarvis's own pointer: the prototype's citron arrow, with its tip as the
// place it is at.
static CAShapeLayer *jarvis_look_hand_make(void) {
	CAShapeLayer *hand = [CAShapeLayer layer];
	CGFloat k = 28.0 / 24.0;
	CGMutablePathRef path = CGPathCreateMutable();
	CGPathMoveToPoint(path, NULL, 4 * k, 2.5 * k);
	CGPathAddLineToPoint(path, NULL, 11.2 * k, 21 * k);
	CGPathAddLineToPoint(path, NULL, 13.7 * k, 13.7 * k);
	CGPathAddLineToPoint(path, NULL, 21 * k, 11.2 * k);
	CGPathCloseSubpath(path);
	hand.path = path;
	CGPathRelease(path);
	hand.bounds = CGRectMake(0, 0, 28, 28);
	hand.anchorPoint = CGPointMake(4.0 / 24.0, 2.5 / 24.0);
	hand.fillColor = jarvis_look_citron(1.0);
	hand.strokeColor = jarvis_look_dark(1.0);
	hand.lineWidth = 1.3 * k;
	hand.lineJoin = kCALineJoinRound;
	hand.shadowColor = jarvis_look_rgb(0, 0, 0, 1.0);
	hand.shadowOpacity = 0.28;
	hand.shadowRadius = 3;
	hand.shadowOffset = CGSizeMake(0, 2);
	hand.zPosition = 10;
	return hand;
}

static CABasicAnimation *jarvis_look_move(NSString *key, id from, id to, double seconds, float a, float b, float c, float d) {
	CABasicAnimation *move = [CABasicAnimation animationWithKeyPath:key];
	move.fromValue = from;
	move.toValue = to;
	move.duration = seconds;
	move.timingFunction = [CAMediaTimingFunction functionWithControlPoints:a :b :c :d];
	return move;
}

// A pointer goes to a place. how: 0 it leaves the notch (it grows and comes
// into sight), 1 it is out already and goes on from where it is, 2 it goes
// home (it shrinks, and is gone), 3 it comes up where it is told to.
// It goes across quickly and settles, and down slowly and then quickly, as
// the prototype's does: so its way is a curve, not a ruled line.
static void jarvis_look_hand_fly(int n, double fx, double fy, double tx, double ty, double seconds, int how,
	double sx, double sy, double sw, double sh) {
	if (n < 0 || n >= JARVIS_LOOK_HANDS) return;
	jarvis_look_on_main(^{
		CAShapeLayer *hand = gLookHands[n];
		if (hand == nil && how == 2) return;
		if (how != 2) jarvis_look_ensure(CGRectMake(sx, sy, sw, sh));
		BOOL fresh = hand == nil;
		if (fresh) {
			hand = jarvis_look_hand_make();
			[gLookRoot addSublayer:hand];
			gLookHands[n] = hand;
		}
		int gen = ++gLookHandGen[n];
		CGPoint to = jarvis_look_local(tx, ty);
		CGPoint from = jarvis_look_local(fx, fy);
		if (!fresh) {
			// From where it is seen to be now, which may be in the middle of its last way.
			CALayer *seen = hand.presentationLayer;
			from = seen != nil ? seen.position : hand.position;
		}
		[hand removeAllAnimations];
		[CATransaction begin];
		[CATransaction setDisableActions:YES];
		hand.position = to;
		hand.opacity = how == 2 ? 0.0 : 1.0;
		hand.transform = how == 2 ? CATransform3DMakeScale(0.35, 0.35, 1) : CATransform3DIdentity;
		[CATransaction commit];
		[hand addAnimation:jarvis_look_move(@"position.x", @(from.x), @(to.x), seconds, 0.2, 0.7, 0.2, 1.0) forKey:@"x"];
		[hand addAnimation:jarvis_look_move(@"position.y", @(from.y), @(to.y), seconds, 0.5, 0.0, 0.25, 1.0) forKey:@"y"];
		if (fresh) {
			[hand addAnimation:jarvis_look_move(@"transform.scale", @(0.35), @(1.0), 0.3, 0.2, 0.7, 0.2, 1.0) forKey:@"grow"];
			[hand addAnimation:jarvis_look_move(@"opacity", @(0.0), @(1.0), 0.18, 0.0, 0.0, 1.0, 1.0) forKey:@"show"];
		}
		if (how == 2) {
			[hand addAnimation:jarvis_look_move(@"transform.scale", @(1.0), @(0.35), seconds, 0.4, 0.0, 1.0, 1.0) forKey:@"shrink"];
			[hand addAnimation:jarvis_look_move(@"opacity", @(1.0), @(0.0), seconds, 0.6, 0.0, 1.0, 1.0) forKey:@"hide"];
			dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
				// Sent somewhere else meanwhile: it stays.
				if (gLookHandGen[n] != gen || gLookHands[n] != hand) return;
				[hand removeFromSuperlayer];
				gLookHands[n] = nil;
				jarvis_look_rest();
			});
		}
	});
}

// A ring is drawn round a rectangle of the screen, a piece at a time, once
// the pointer has landed, and a few words are put beside it when it is closed.
static void jarvis_look_ring(double x, double y, double w, double h, double afterSeconds, const char *utf8,
	double sx, double sy, double sw, double sh) {
	NSString *text = utf8 != NULL ? [NSString stringWithUTF8String:utf8] : nil;
	jarvis_look_on_main(^{
		jarvis_look_ink_clear_impl();
		jarvis_look_ring_clear_impl();
		jarvis_look_ensure(CGRectMake(sx, sy, sw, sh));
		int gen = gLookRingGen;
		CGPoint origin = jarvis_look_local(x, y);
		CGRect about = CGRectInset(CGRectMake(origin.x, origin.y, w, h), -6, -6);
		CGPathRef path = CGPathCreateWithRoundedRect(about, MIN(10, about.size.width / 2), MIN(10, about.size.height / 2), NULL);
		CAShapeLayer *ring = jarvis_look_stroke(jarvis_look_citron(0.62), 9.6);
		ring.path = path;
		CGPathRelease(path);
		CABasicAnimation *draw = jarvis_look_move(@"strokeEnd", @(0.0), @(1.0), 0.28, 0.2, 0.0, 0.2, 1.0);
		draw.beginTime = CACurrentMediaTime() + afterSeconds;
		// Until the pointer lands there is no ring to see.
		draw.fillMode = kCAFillModeBackwards;
		[ring addAnimation:draw forKey:@"draw"];
		[gLookRoot addSublayer:ring];
		gLookRing = ring;
		if (text != nil && text.length > 0) {
			dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((afterSeconds + 0.28) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
				if (gLookRingGen != gen || gLookRing != ring) return;
				jarvis_look_drop(gLookTag);
				gLookTag = jarvis_look_plate(text, CGRectMake(x, y, w, h));
				[gLookRoot addSublayer:gLookTag];
			});
		}
	});
}

static void jarvis_look_ring_clear(void) {
	jarvis_look_on_main(^{
		jarvis_look_ring_clear_impl();
		jarvis_look_rest();
	});
}

// Everything is taken away at once.
static void jarvis_look_clear_all(void) {
	jarvis_look_on_main(^{
		jarvis_look_ink_clear_impl();
		jarvis_look_ring_clear_impl();
		jarvis_look_hands_clear_impl();
		jarvis_look_drop(gLookHover);
		gLookHover = nil;
		jarvis_look_rest();
	});
}
*/
import "C"

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// lookMac is the look's hands on a Mac.
type lookMac struct {
	look *NotchLook
	// The press that began a line was kept from the app in front: so is the
	// dragging that follows it, which the app would otherwise get with no
	// press before it.
	kept atomic.Bool

	mu sync.Mutex
	// Which pointers are out, and where each one's tip is (or is going).
	out  [notchHandCount]bool
	tips [notchHandCount]lookPoint
	// Counted up whenever what is on the screen is replaced, so that a timer
	// set for what was there before finds it gone and does nothing.
	inkGen  int
	handGen int
	// Whether a line's ink is up: its tag and its end are for nothing else.
	inking bool
}

var darwinLook atomic.Pointer[lookMac]

// platformNotchLookHands gives the look its hands. Nil when the person has
// not let this program use the accessibility interface: without it neither
// the pointer can be watched nor a thing be read.
func platformNotchLookHands(l *NotchLook) lookHands {
	if !macAXTrusted() {
		log.Printf("[notch] look: not available: the Accessibility permission is not given (System Settings, Privacy & Security, Accessibility; newer versions of macOS call the list Device Control and Data Access)")
		return nil
	}
	m := &lookMac{look: l}
	darwinLook.Store(m)
	return m
}

// notchLookMouseSeen is the tap handing over something the pointer did. True
// when it is to be kept from the app in front. It runs on the main thread,
// inside the tap, so it does nothing that waits.
func notchLookMouseSeen(kind, x, y int) bool {
	m := darwinLook.Load()
	if m == nil {
		return false
	}
	switch kind {
	case 1:
		kept := m.look.Down(x, y)
		m.kept.Store(kept)
		return kept
	case 2:
		kept := m.look.Up(x, y)
		m.kept.Store(false)
		if !kept {
			m.look.Clicked(x, y)
		}
		return kept
	case 3:
		m.look.Move(x, y)
	case 4:
		m.look.Move(x, y)
		return m.kept.Load()
	case 5:
		m.look.Clicked(x, y)
	}
	return false
}

func (m *lookMac) Watch() {
	on := m.look.Wants()
	if C.jarvis_look_tap_set(boolToCInt(on)) == 0 && on {
		log.Printf("[notch] look: the system refused the watch on the pointer")
	}
}

// Screen is the display a place is on. Everything here is counted in points,
// which the system draws at whatever size the display has, so the scale the
// ink is told is always 1.
func (m *lookMac) Screen(at lookPoint) (lookRect, float64) {
	rect, _ := macScreenAt(at)
	return rect, 1
}

func (m *lookMac) Own(at lookPoint) bool { return macOwnAt(at) }

func (m *lookMac) Front(at lookPoint) (app, title string) {
	win, ok := macWinAt(at)
	if !ok {
		return "", ""
	}
	return notchAppKey(win.App), win.Title
}

func (m *lookMac) WindowRect(at lookPoint) lookRect {
	win, ok := macWinAt(at)
	if !ok {
		return lookRect{}
	}
	return win.Rect
}

// Around gives the names of what stands round a place, from the nearest
// outwards, up to the window.
func (m *lookMac) Around(at lookPoint) []string {
	win, ok := macWinAt(at)
	if !ok {
		return nil
	}
	cur, ok := macElemAt(at, win.Pid, true)
	if !ok {
		return nil
	}
	var names []string
	for climb := 0; climb < 14; climb++ {
		// What is typed into a password field is never read; nor is its name needed.
		if !cur.secure && cur.name != "" {
			names = append(names, cur.name)
		}
		if cur.kind == "Window" {
			break
		}
		parent, ok := macElemParent(cur, true)
		if !ok {
			break
		}
		cur.release()
		cur = parent
	}
	cur.release()
	return names
}

func (m *lookMac) Snapshot(screen lookRect) lookSnapshot {
	shot := macCapture(screen, false)
	if shot == nil {
		// Said as "no picture", not as a picture that is not there.
		return nil
	}
	return shot
}

func (m *lookMac) screenOf(at lookPoint) lookRect {
	rect, _ := macScreenAt(at)
	return rect
}

func (m *lookMac) InkBegin(at lookPoint, screen lookRect, scale float64) {
	m.mu.Lock()
	m.inkGen++
	m.handGen++
	m.inking = true
	m.out = [notchHandCount]bool{}
	m.mu.Unlock()
	C.jarvis_look_ink_begin(C.double(at.X), C.double(at.Y), C.double(screen.X), C.double(screen.Y), C.double(screen.W), C.double(screen.H))
}

func (m *lookMac) InkLine(from, to lookPoint) {
	m.mu.Lock()
	inking := m.inking
	m.mu.Unlock()
	if inking {
		C.jarvis_look_ink_line(C.double(to.X), C.double(to.Y))
	}
}

func (m *lookMac) InkTag(text string, bounds lookRect) {
	m.mu.Lock()
	inking := m.inking
	m.mu.Unlock()
	if !inking {
		return
	}
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))
	C.jarvis_look_tag(cText, C.double(bounds.X), C.double(bounds.Y), C.double(bounds.W), C.double(bounds.H))
}

// InkEnd takes the ink away after it has stayed this long.
func (m *lookMac) InkEnd(stay time.Duration) {
	m.mu.Lock()
	if !m.inking {
		m.mu.Unlock()
		return
	}
	gen := m.inkGen
	if stay <= 0 {
		m.inking = false
		m.mu.Unlock()
		C.jarvis_look_ink_clear()
		return
	}
	m.mu.Unlock()
	time.AfterFunc(stay, func() {
		m.mu.Lock()
		same := m.inkGen == gen && m.inking
		if same {
			m.inking = false
		}
		m.mu.Unlock()
		if same {
			C.jarvis_look_ink_clear()
		}
	})
}

// home is where the pointers live: at the notch, top centre of the first display.
func (m *lookMac) home() lookPoint {
	first, _ := macScreenAt(lookPoint{0, 0})
	return lookPoint{first.X + first.W/2, first.Y + 20}
}

// fly sends a pointer to a place and says how long its way takes. With the lock held.
func (m *lookMac) fly(n int, to lookPoint, beside, quick bool) time.Duration {
	screen := m.screenOf(to)
	from, how := m.tips[n], 1
	took := lookHandFlight(from, to)
	if quick {
		took = time.Duration(lookHandHop(from, to)) * time.Millisecond
	}
	if !m.out[n] {
		home := m.home()
		// Each pointer leaves the notch a little apart from the others.
		from, how = lookPoint{home.X + (n*2-(notchHandCount-1))*8, home.Y}, 0
		took = lookHandFlight(from, to)
		if beside {
			// The baton: it comes up where the person's hand is.
			from, how, took = to, 3, notchHandGrow
		}
	}
	m.out[n], m.tips[n] = true, to
	C.jarvis_look_hand_fly(C.int(n), C.double(from.X), C.double(from.Y), C.double(to.X), C.double(to.Y), C.double(took.Seconds()), C.int(how),
		C.double(screen.X), C.double(screen.Y), C.double(screen.W), C.double(screen.H))
	return took
}

// goHome sends every pointer home, or all but the first. With the lock held.
func (m *lookMac) goHome(fromHand int) {
	home := m.home()
	for n := fromHand; n < notchHandCount; n++ {
		if !m.out[n] {
			continue
		}
		m.out[n] = false
		C.jarvis_look_hand_fly(C.int(n), 0, 0, C.double(home.X), C.double(home.Y), C.double(notchHandHome.Seconds()), 2, 0, 0, 0, 0)
	}
}

// after runs something later, unless what is on the screen was replaced meanwhile.
func (m *lookMac) after(wait time.Duration, gen int, run func()) {
	time.AfterFunc(wait, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.handGen == gen {
			run()
		}
	})
}

// Point sends Jarvis's own pointer to a rectangle of the screen and rings it.
func (m *lookMac) Point(r lookRect, label string, stay time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.inking = false
	m.inkGen++
	m.handGen++
	gen := m.handGen
	// The other pointers, out for a job that is over, go home.
	m.goHome(1)
	took := m.fly(0, lookHandRest(r, 1), false, false)
	screen := m.screenOf(lookPoint{r.X + r.W/2, r.Y + r.H/2})
	cLabel := C.CString(label)
	defer C.free(unsafe.Pointer(cLabel))
	C.jarvis_look_ring(C.double(r.X), C.double(r.Y), C.double(r.W), C.double(r.H), C.double(took.Seconds()), cLabel,
		C.double(screen.X), C.double(screen.Y), C.double(screen.W), C.double(screen.H))
	// The ring had its time and nobody clicked: it goes, and the pointer goes home.
	m.after(took+notchHandRing+stay, gen, func() {
		C.jarvis_look_ring_clear()
		m.goHome(0)
	})
}

// PointHit: the thing pointed at was clicked. Its ring and words go at once.
// The pointer waits where it is for the next thing a while.
func (m *lookMac) PointHit() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.handGen++
	gen := m.handGen
	C.jarvis_look_ring_clear()
	m.after(notchHandLinger, gen, func() { m.goHome(0) })
}

func (m *lookMac) PointEnd() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.handGen++
	C.jarvis_look_ring_clear()
	m.goHome(0)
}

// HandTo sends one of the pointers to a place with no ring: a job is being
// done there.
func (m *lookMac) HandTo(n int, at lookPoint, beside bool) time.Duration {
	if n < 0 || n >= notchHandCount {
		n = 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.inking = false
	m.inkGen++
	m.handGen++
	gen := m.handGen
	C.jarvis_look_ring_clear()
	C.jarvis_look_ink_clear()
	took := m.fly(n, at, beside, true)
	// Out for a job and nothing more heard: the brain went away in the middle.
	m.after(notchHandJobIdle, gen, func() { m.goHome(0) })
	return took
}

func (m *lookMac) HandsHome() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.handGen++
	C.jarvis_look_ring_clear()
	m.goHome(0)
}

func (m *lookMac) Hover(text string, at lookPoint) {
	screen := m.screenOf(at)
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))
	C.jarvis_look_hover(cText, C.double(at.X), C.double(at.Y), C.double(screen.X), C.double(screen.Y), C.double(screen.W), C.double(screen.H))
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

func macRowLike(e macElem) bool {
	if e.local == "row" || e.kind == "ListItem" || e.kind == "TreeItem" {
		return true
	}
	return e.kind == "DataItem" && lookKindOf(e.kind, e.local, e.rect) == "row"
}

// macSettle goes from what is under a place up to the thing a person means
// there: the row a word is in; failing that the nearest thing that is one by
// itself (a button, a link, a field); failing that the thing as it is. It
// takes over leaf, and what it gives back is the caller's to release.
func macSettle(leaf macElem) macElem {
	chain := []macElem{leaf}
	keep := func(found macElem) macElem {
		for i := range chain {
			if chain[i].ref != found.ref {
				chain[i].release()
			}
		}
		return found
	}
	var item *macElem
	cur := leaf
	for climb := 0; ; climb++ {
		if macRowLike(cur) && (climb == 0 || lookRowOf(cur.rect, leaf.rect)) {
			return keep(cur)
		}
		if item == nil && (lookItemRoles[cur.kind] || lookKindOf(cur.kind, cur.local, cur.rect) != "thing") && cur.kind != "Text" {
			found := cur
			item = &found
		}
		if climb >= notchLookClimb {
			break
		}
		parent, ok := macElemParent(cur, true)
		if !ok {
			break
		}
		chain = append(chain, parent)
		// The place the things are in is not a thing; it is only gone into
		// when it calls itself a row.
		if lookEdgeRoles[parent.kind] && !macRowLike(parent) {
			break
		}
		cur = parent
	}
	if item != nil {
		return keep(*item)
	}
	return keep(leaf)
}

// macSays is what a thing says: what is in it, or what it is called.
func macSays(e macElem) string {
	if e.secure {
		return ""
	}
	if e.value != "" {
		return e.value
	}
	return e.name
}

// macDescribe reads a settled thing. light: only what the tag needs.
func macDescribe(found macElem, light bool) lookThing {
	thing := lookThing{Kind: lookKindOf(found.kind, found.local, found.rect), Role: found.kind, Name: found.name, Rect: found.rect}
	// What is typed into a password field is never read, here or anywhere.
	if light || found.secure || !found.held() {
		return thing
	}
	if full, ok := macElemOf(found.ref, false); ok {
		// It was read again with the same hold on it: nothing more to release.
		if full.name != "" {
			thing.Name = full.name
		}
		if full.value != thing.Name {
			thing.Value = full.value
		}
	}
	if thing.Kind != "row" && thing.Kind != "item" {
		return thing
	}
	// The cells of a row: what each one says. A cell is often a box round a
	// line of words, and then the words are one step further in.
	for _, cell := range macElemChildren(found, notchLookMaxParts, false) {
		text := macSays(cell)
		if text == "" && !cell.secure {
			for _, inner := range macElemChildren(cell, 3, false) {
				if text == "" {
					text = macSays(inner)
				}
				inner.release()
			}
		}
		if text != "" {
			thing.Parts = append(thing.Parts, truncateRunes(text, notchLookPartRunes))
		}
		cell.release()
	}
	// A row whose only cell says what the row is called says nothing new.
	if len(thing.Parts) == 1 && thing.Parts[0] == thing.Name {
		thing.Parts = nil
	}
	return thing
}

// macFound is what a program has at a place, settled. The caller releases it.
func macFound(at lookPoint) (macElem, bool) {
	win, ok := macWinAt(at)
	if !ok {
		return macElem{}, false
	}
	leaf, ok := macElemAt(at, win.Pid, true)
	if !ok {
		return macElem{}, false
	}
	return macSettle(leaf), true
}

func (m *lookMac) ThingAt(at lookPoint, light bool) (lookThing, bool) {
	found, ok := macFound(at)
	if !ok {
		return lookThing{}, false
	}
	defer found.release()
	thing := macDescribe(found, light)
	return thing, !thing.Rect.empty()
}

func (m *lookMac) ThingsIn(line []lookPoint, light bool) []lookThing {
	var found []macElem
	defer func() {
		for i := range found {
			found[i].release()
		}
	}()
	// What is at a few places inside the line.
	seen := map[string]bool{}
	for _, p := range lookSamplePoints(line, notchLookSamples) {
		f, ok := macFound(p)
		if !ok {
			continue
		}
		key := fmt.Sprintf("%s|%d|%d|%d|%d", f.kind, f.rect.X, f.rect.Y, f.rect.W, f.rect.H)
		if seen[key] || f.rect.empty() {
			f.release()
			continue
		}
		seen[key] = true
		found = append(found, f)
	}
	if len(found) == 0 {
		return []lookThing{}
	}
	// Things that stand side by side in one container: the container is gone
	// through, so that a row between two places that were asked about is not
	// left out.
	if len(found) >= 2 {
		if things, ok := macSiblings(found, line, light); ok {
			return things
		}
	}
	things := make([]lookThing, 0, len(found))
	for _, f := range found {
		if lookCovers(line, f.rect) {
			things = append(things, macDescribe(f, light))
		}
	}
	if len(things) == 0 {
		// A line with no inside, or one that holds only part of one large
		// thing: what it runs over is what is meant.
		for _, f := range found {
			things = append(things, macDescribe(f, light))
		}
	}
	return things
}

// macSiblings reads the things inside the one container every found thing
// stands in, and keeps those the line holds. ok is false when they do not
// share a container.
func macSiblings(found []macElem, line []lookPoint, light bool) ([]lookThing, bool) {
	parent, ok := macElemParent(found[0], true)
	if !ok {
		return nil, false
	}
	defer parent.release()
	for _, f := range found[1:] {
		other, ok := macElemParent(f, true)
		if !ok {
			return nil, false
		}
		same := macElemSame(parent, other)
		other.release()
		if !same {
			return nil, false
		}
	}
	var things []lookThing
	for _, child := range macElemChildren(parent, notchLookMaxSiblings, true) {
		if len(things) < notchLookMaxThings && lookCovers(line, child.rect) {
			things = append(things, macDescribe(child, light))
		}
		child.release()
	}
	return things, len(things) > 0
}

// ---------------------------------------------------------------------------
// The window the person is in, for "where is...?"
// ---------------------------------------------------------------------------

// The most that is read of a window, of what is open on top of it, and how
// long the reading may take: a program that is slow to answer must not hold
// the question up.
const (
	macWindowElementLimit = 400
	macPopupElementLimit  = 160
	macWindowReadBudget   = 2500 * time.Millisecond
)

// macWalk goes through a thing and what is in it, and keeps what a person
// could press, pick or type into, each with its place.
func macWalk(e macElem, depth, deepest int, out *[]map[string]any, limit int, until time.Time) {
	if len(*out) >= limit || time.Now().After(until) {
		return
	}
	if depth > 0 && !e.rect.empty() && (macActsOn(e.kind) || (e.kind == "Text" && e.name != "")) {
		*out = append(*out, map[string]any{
			"id": len(*out) + 1, "name": truncateRunes(e.name, 100), "control_type": e.kind,
			"rect": map[string]any{"x": e.rect.X, "y": e.rect.Y, "w": e.rect.W, "h": e.rect.H},
		})
	}
	if depth >= deepest {
		return
	}
	for _, child := range macElemChildren(e, 80, true) {
		macWalk(child, depth+1, deepest, out, limit, until)
		child.release()
	}
}

func init() {
	// The same window notch.window reads, as a place on the screen (notch_shot.go).
	platformNotchFront = func() (lookRect, string, string, error) {
		win, ok := macWinFront()
		if !ok || win.Pid == 0 {
			return lookRect{}, "", "", fmt.Errorf("no window of another program is open")
		}
		return win.Rect, win.App, win.Title, nil
	}
	// Why the look cannot be used here, when it cannot: a permission, never
	// that it is not built.
	platformNotchLookWhyNot = func() error {
		if !macAXTrusted() {
			return fmt.Errorf("the Accessibility permission is not given (System Settings, Privacy & Security, Accessibility; newer versions of macOS call the list Device Control and Data Access)")
		}
		if !macMayCapture() {
			return fmt.Errorf("the Screen Recording permission is not given (System Settings, Privacy & Security, Screen & System Audio Recording)")
		}
		return nil
	}
}

// platformNotchWindowRead reads the window the person is in: what it says of
// itself, thing by thing, each with its place on the screen. What the program
// has open on top of it (a menu) comes first: it is what the person is
// looking at, and the list may be cut short.
func platformNotchWindowRead() (map[string]any, error) {
	if !macAXTrusted() {
		return nil, fmt.Errorf("the Accessibility permission is not given")
	}
	win, ok := macWinFront()
	if !ok || win.Pid == 0 {
		return nil, fmt.Errorf("no window of another program is open")
	}
	app := notchAppKey(win.App)
	// Decided before anything is read (notch_where.go).
	if away := notchLookAway(app, win.Title); away != "" {
		return map[string]any{"away": away}, nil
	}
	root, ok := macWindowElem(win.Pid, true)
	if !ok {
		return nil, fmt.Errorf("the window could not be read")
	}
	defer root.release()
	until := time.Now().Add(macWindowReadBudget)
	elements := []map[string]any{}
	if menu, ok := macOpenMenu(win.Pid); ok {
		macWalk(menu, 0, 4, &elements, macPopupElementLimit, until)
		menu.release()
	}
	popups := len(elements)
	macWalk(root, 0, 8, &elements, macWindowElementLimit, until)
	// Numbered in the order they are told, whatever each was numbered as it was found.
	for i := range elements {
		elements[i]["id"] = i + 1
	}
	result := map[string]any{
		"window_title": win.Title, "pid": win.Pid, "element_count": len(elements), "elements": elements, "app": app,
	}
	if popups > 0 {
		result["popups"] = popups
	}
	return result, nil
}
