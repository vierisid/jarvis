//go:build darwin

package main

// What the Mac's side of looking, watching and doing asks of the system:
// which window is where, what a program says about what is at a place, a copy
// of a part of the screen, the clipboard, and a click or a key made as if by
// hand. Everything here is a small question or a small act; what is done with
// the answers is in notch_look_darwin.go and notch_watch_darwin.go.
//
// NOT YET RUN. Written on a machine that cannot build for macOS; GitHub's Mac
// job compiles it and nothing more. It is to be tried by hand in pass 14 with
// everything else on the Mac.
//
// Places are in points, counted from the top left corner of the first
// display, y going down: what Core Graphics and the accessibility interface
// both use. AppKit counts from the bottom left, and is turned round where it
// is asked.
//
// What a program says about itself is asked of that program (the
// accessibility interface is a question sent to it), so every such question
// has a time limit: a program that is busy must not hold the notch up.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework ApplicationServices -framework CoreGraphics -framework Carbon

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static char *jarvis_mac_dup(NSString *s) {
	if (s == nil) return NULL;
	const char *c = s.UTF8String;
	return c != NULL ? strdup(c) : NULL;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

typedef struct {
	unsigned int wid;
	int pid;
	int layer;
	int x, y, w, h;
	char *app;
	char *title;
} JarvisMacWin;

static void jarvis_mac_win_fill(NSDictionary *info, JarvisMacWin *out) {
	out->wid = [info[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
	out->pid = [info[(__bridge NSString *)kCGWindowOwnerPID] intValue];
	out->layer = [info[(__bridge NSString *)kCGWindowLayer] intValue];
	CGRect r = CGRectZero;
	NSDictionary *bounds = info[(__bridge NSString *)kCGWindowBounds];
	if (bounds != nil) CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &r);
	out->x = (int)r.origin.x;
	out->y = (int)r.origin.y;
	out->w = (int)r.size.width;
	out->h = (int)r.size.height;
	out->app = jarvis_mac_dup(info[(__bridge NSString *)kCGWindowOwnerName]);
	NSString *title = info[(__bridge NSString *)kCGWindowName];
	out->title = (title != nil && title.length > 0) ? jarvis_mac_dup(title) : NULL;
}

static void jarvis_mac_win_free(JarvisMacWin *w) {
	if (w->app != NULL) free(w->app);
	if (w->title != NULL) free(w->title);
	w->app = NULL;
	w->title = NULL;
}

// The topmost window of another program at a place. 1 when there is one.
// This program's own windows are passed over: its overlays lie on top of
// everything and are nothing a person is "in".
static int jarvis_mac_win_at(double x, double y, JarvisMacWin *out) {
	memset(out, 0, sizeof(*out));
	CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
	if (list == NULL) return 0;
	int mine = (int)getpid();
	int found = 0;
	for (NSDictionary *info in (__bridge NSArray *)list) {
		if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] == mine) continue;
		NSNumber *alpha = info[(__bridge NSString *)kCGWindowAlpha];
		if (alpha != nil && alpha.doubleValue <= 0.01) continue;
		CGRect r = CGRectZero;
		NSDictionary *bounds = info[(__bridge NSString *)kCGWindowBounds];
		if (bounds == nil || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &r)) continue;
		if (!CGRectContainsPoint(r, CGPointMake(x, y))) continue;
		jarvis_mac_win_fill(info, out);
		found = 1;
		break;
	}
	CFRelease(list);
	return found;
}

// A window by its number, as it is now. 1 when it is still on the screen.
static int jarvis_mac_win_by_id(unsigned int wid, JarvisMacWin *out) {
	memset(out, 0, sizeof(*out));
	CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
	if (list == NULL) return 0;
	int found = 0;
	for (NSDictionary *info in (__bridge NSArray *)list) {
		if ([info[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] != wid) continue;
		jarvis_mac_win_fill(info, out);
		found = 1;
		break;
	}
	CFRelease(list);
	return found;
}

// The topmost ordinary window of a program, by the program's name, of a
// size. 1 when there is one. A window's number changes whenever its program
// is started, so a job shown yesterday finds its window again this way.
static int jarvis_mac_win_find(const char *app, int w, int h, JarvisMacWin *out) {
	memset(out, 0, sizeof(*out));
	NSString *want = app != NULL ? [NSString stringWithUTF8String:app] : nil;
	if (want == nil || want.length == 0) return 0;
	CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
	if (list == NULL) return 0;
	int found = 0;
	for (NSDictionary *info in (__bridge NSArray *)list) {
		if ([info[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
		NSString *owner = info[(__bridge NSString *)kCGWindowOwnerName];
		if (owner == nil || [owner caseInsensitiveCompare:want] != NSOrderedSame) continue;
		CGRect r = CGRectZero;
		NSDictionary *bounds = info[(__bridge NSString *)kCGWindowBounds];
		if (bounds == nil || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &r)) continue;
		if (abs((int)r.size.width - w) > 2 || abs((int)r.size.height - h) > 2) continue;
		jarvis_mac_win_fill(info, out);
		found = 1;
		break;
	}
	CFRelease(list);
	return found;
}

// The window the person is in: the topmost ordinary window of the app in
// front, or, when the app in front is this program (the notch has the
// keyboard while something is typed into it), of the first other program.
static int jarvis_mac_win_front(JarvisMacWin *out) {
	memset(out, 0, sizeof(*out));
	int mine = (int)getpid();
	__block int front = 0;
	void (^ask)(void) = ^{
		NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
		if (app != nil) front = (int)app.processIdentifier;
	};
	if ([NSThread isMainThread]) ask(); else dispatch_sync(dispatch_get_main_queue(), ask);
	CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
	if (list == NULL) return 0;
	int found = 0;
	for (int pass = 0; pass < 2 && !found; pass++) {
		for (NSDictionary *info in (__bridge NSArray *)list) {
			int pid = [info[(__bridge NSString *)kCGWindowOwnerPID] intValue];
			if (pid == mine) continue;
			if ([info[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
			// First the app in front; failing that, whichever ordinary window is on top.
			if (pass == 0 && (front == mine || pid != front)) continue;
			jarvis_mac_win_fill(info, out);
			if (out->w <= 0 || out->h <= 0) { jarvis_mac_win_free(out); continue; }
			found = 1;
			break;
		}
	}
	CFRelease(list);
	return found;
}

// Brings a program forward: its windows come to the front, and what is
// typed goes to it.
static void jarvis_mac_activate(int pid) {
	void (^work)(void) = ^{
		NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
		if (app != nil) [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
	};
	if ([NSThread isMainThread]) work(); else dispatch_sync(dispatch_get_main_queue(), work);
}

// 1 when the topmost thing at a place is one of this program's windows that
// takes clicks (the notch itself). Its overlays let clicks through and do not
// count.
static int jarvis_mac_own_at(double x, double y) {
	__block int own = 0;
	void (^ask)(void) = ^{
		NSScreen *first = [NSScreen screens].firstObject;
		if (first == nil) return;
		NSPoint p = NSMakePoint(x, first.frame.size.height - y);
		NSInteger below = 0;
		for (int i = 0; i < 8; i++) {
			NSInteger number = [NSWindow windowNumberAtPoint:p belowWindowWithWindowNumber:below];
			if (number <= 0) return;
			NSWindow *w = [NSApp windowWithWindowNumber:number];
			if (w == nil) return;
			if (!w.ignoresMouseEvents) { own = 1; return; }
			below = number;
		}
	};
	if ([NSThread isMainThread]) ask(); else dispatch_sync(dispatch_get_main_queue(), ask);
	return own;
}

// The display a place is on: where it is, and how many pixels it has to a point.
static void jarvis_mac_screen_at(double x, double y, int *sx, int *sy, int *sw, int *sh, double *scale) {
	CGDirectDisplayID ids[4];
	uint32_t n = 0;
	if (CGGetDisplaysWithPoint(CGPointMake(x, y), 4, ids, &n) != kCGErrorSuccess || n == 0) ids[0] = CGMainDisplayID();
	CGRect b = CGDisplayBounds(ids[0]);
	*sx = (int)b.origin.x;
	*sy = (int)b.origin.y;
	*sw = (int)b.size.width;
	*sh = (int)b.size.height;
	*scale = 1.0;
	CGDisplayModeRef mode = CGDisplayCopyDisplayMode(ids[0]);
	if (mode != NULL) {
		size_t pixels = CGDisplayModeGetPixelWidth(mode), points = CGDisplayModeGetWidth(mode);
		if (points > 0 && pixels > 0) *scale = (double)pixels / (double)points;
		CGDisplayModeRelease(mode);
	}
}

// Where the person's own pointer is.
static void jarvis_mac_pointer(double *x, double *y) {
	CGEventRef here = CGEventCreate(NULL);
	CGPoint p = here != NULL ? CGEventGetLocation(here) : CGPointZero;
	if (here != NULL) CFRelease(here);
	*x = p.x;
	*y = p.y;
}

// ---------------------------------------------------------------------------
// What a program says about itself
// ---------------------------------------------------------------------------

typedef struct {
	AXUIElementRef ref;
	char *role;
	char *subrole;
	char *name;
	char *value;
	int x, y, w, h;
	int secure;
} JarvisMacAX;

// One text a program says about a thing, cut to a length. nil when it says none.
static NSString *jarvis_mac_ax_text(AXUIElementRef e, CFStringRef attr, NSUInteger most) {
	CFTypeRef v = NULL;
	if (AXUIElementCopyAttributeValue(e, attr, &v) != kAXErrorSuccess || v == NULL) return nil;
	NSString *out = nil;
	CFTypeID kind = CFGetTypeID(v);
	if (kind == CFStringGetTypeID()) out = [(__bridge NSString *)v copy];
	else if (kind == CFNumberGetTypeID()) out = [(__bridge NSNumber *)v stringValue];
	else if (kind == CFAttributedStringGetTypeID()) out = [[(__bridge NSAttributedString *)v string] copy];
	CFRelease(v);
	if (out != nil && out.length > most) {
		NSRange whole = [out rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, most)];
		out = [out substringWithRange:whole];
	}
	return out;
}

// Reads a thing: what kind it is, what it is called, what it says, where it
// is. light: only what a tag needs. What is typed into a password field is
// never read, here or anywhere.
static void jarvis_mac_ax_read(AXUIElementRef e, int light, JarvisMacAX *out) {
	NSString *role = jarvis_mac_ax_text(e, kAXRoleAttribute, 60);
	NSString *subrole = jarvis_mac_ax_text(e, kAXSubroleAttribute, 60);
	out->role = jarvis_mac_dup(role);
	out->subrole = jarvis_mac_dup(subrole);
	int secure = [role isEqualToString:@"AXSecureTextField"] || [subrole isEqualToString:@"AXSecureTextField"];
	out->secure = secure;
	NSString *name = jarvis_mac_ax_text(e, kAXTitleAttribute, 400);
	if (name.length == 0) name = jarvis_mac_ax_text(e, kAXDescriptionAttribute, 400);
	// What a line of words says is what it is called.
	BOOL words = [role isEqualToString:@"AXStaticText"] || [role isEqualToString:@"AXHeading"] || [role isEqualToString:@"AXLink"];
	NSString *value = nil;
	if (!secure && (!light || (words && name.length == 0))) value = jarvis_mac_ax_text(e, kAXValueAttribute, 400);
	if (words && name.length == 0 && value.length > 0) {
		name = value;
		value = nil;
	}
	if (name.length == 0 && !light) {
		// A field is often named by the words standing beside it.
		CFTypeRef label = NULL;
		if (AXUIElementCopyAttributeValue(e, kAXTitleUIElementAttribute, &label) == kAXErrorSuccess && label != NULL) {
			if (CFGetTypeID(label) == AXUIElementGetTypeID()) {
				name = jarvis_mac_ax_text((AXUIElementRef)label, kAXValueAttribute, 400);
				if (name.length == 0) name = jarvis_mac_ax_text((AXUIElementRef)label, kAXTitleAttribute, 400);
			}
			CFRelease(label);
		}
	}
	out->name = jarvis_mac_dup(name);
	out->value = jarvis_mac_dup(value);
	CGPoint p = CGPointZero;
	CGSize s = CGSizeZero;
	CFTypeRef pv = NULL, sv = NULL;
	if (AXUIElementCopyAttributeValue(e, kAXPositionAttribute, &pv) == kAXErrorSuccess && pv != NULL) {
		if (CFGetTypeID(pv) == AXValueGetTypeID()) AXValueGetValue((AXValueRef)pv, kAXValueTypeCGPoint, &p);
		CFRelease(pv);
	}
	if (AXUIElementCopyAttributeValue(e, kAXSizeAttribute, &sv) == kAXErrorSuccess && sv != NULL) {
		if (CFGetTypeID(sv) == AXValueGetTypeID()) AXValueGetValue((AXValueRef)sv, kAXValueTypeCGSize, &s);
		CFRelease(sv);
	}
	out->x = (int)p.x;
	out->y = (int)p.y;
	out->w = (int)s.width;
	out->h = (int)s.height;
}

static void jarvis_mac_ax_free(JarvisMacAX *t) {
	if (t->role != NULL) free(t->role);
	if (t->subrole != NULL) free(t->subrole);
	if (t->name != NULL) free(t->name);
	if (t->value != NULL) free(t->value);
	t->role = t->subrole = t->name = t->value = NULL;
}

// What a field holds, as it is, cut at a length. The caller asks for one
// more than it will take, so that it can tell a cut one from a whole one.
// NULL when it holds nothing that is words. The caller frees it.
static char *jarvis_mac_ax_value(AXUIElementRef e, int most) {
	return jarvis_mac_dup(jarvis_mac_ax_text(e, kAXValueAttribute, (NSUInteger)most));
}

static void jarvis_mac_ax_release(AXUIElementRef e) {
	if (e != NULL) CFRelease(e);
}

static int jarvis_mac_ax_same(AXUIElementRef a, AXUIElementRef b) {
	return (a != NULL && b != NULL && CFEqual(a, b)) ? 1 : 0;
}

// How long any program is waited for. Set once, for every question this
// program asks: a limit set on one thing holds for that thing only, and the
// system's own is several seconds.
static void jarvis_mac_ax_limit(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		AXUIElementRef all = AXUIElementCreateSystemWide();
		if (all != NULL) {
			AXUIElementSetMessagingTimeout(all, 0.6);
			CFRelease(all);
		}
	});
}

// A program, to ask things of. The caller releases it.
static AXUIElementRef jarvis_mac_ax_app(int pid) {
	jarvis_mac_ax_limit();
	AXUIElementRef app = AXUIElementCreateApplication(pid);
	if (app != NULL) AXUIElementSetMessagingTimeout(app, 0.6);
	return app;
}

// What a program has at a place. 1 when it has something; out->ref is then the caller's to release.
static int jarvis_mac_ax_at(double x, double y, int pid, int light, JarvisMacAX *out) {
	memset(out, 0, sizeof(*out));
	AXUIElementRef app = jarvis_mac_ax_app(pid);
	if (app == NULL) return 0;
	AXUIElementRef e = NULL;
	AXError err = AXUIElementCopyElementAtPosition(app, (float)x, (float)y, &e);
	CFRelease(app);
	if (err != kAXErrorSuccess || e == NULL) return 0;
	out->ref = e;
	jarvis_mac_ax_read(e, light, out);
	return 1;
}

// What a thing stands in. 1 when it stands in something; out->ref is then the caller's to release.
static int jarvis_mac_ax_parent(AXUIElementRef e, int light, JarvisMacAX *out) {
	memset(out, 0, sizeof(*out));
	CFTypeRef v = NULL;
	if (AXUIElementCopyAttributeValue(e, kAXParentAttribute, &v) != kAXErrorSuccess || v == NULL) return 0;
	if (CFGetTypeID(v) != AXUIElementGetTypeID()) {
		CFRelease(v);
		return 0;
	}
	out->ref = (AXUIElementRef)v;
	jarvis_mac_ax_read(out->ref, light, out);
	return 1;
}

// The things inside a thing, at most `most` of them. Each is the caller's to release.
static int jarvis_mac_ax_children(AXUIElementRef e, AXUIElementRef *refs, int most) {
	CFTypeRef v = NULL;
	if (AXUIElementCopyAttributeValue(e, kAXChildrenAttribute, &v) != kAXErrorSuccess || v == NULL) return 0;
	int n = 0;
	if (CFGetTypeID(v) == CFArrayGetTypeID()) {
		CFArrayRef list = (CFArrayRef)v;
		CFIndex count = CFArrayGetCount(list);
		for (CFIndex i = 0; i < count && n < most; i++) {
			CFTypeRef child = CFArrayGetValueAtIndex(list, i);
			if (child == NULL || CFGetTypeID(child) != AXUIElementGetTypeID()) continue;
			CFRetain(child);
			refs[n++] = (AXUIElementRef)child;
		}
	}
	CFRelease(v);
	return n;
}

// Reads a thing the caller already holds.
static void jarvis_mac_ax_describe(AXUIElementRef e, int light, JarvisMacAX *out) {
	memset(out, 0, sizeof(*out));
	out->ref = e;
	jarvis_mac_ax_read(e, light, out);
}

// One thing a program names by an attribute of itself: its focused window,
// the thing that has the keyboard, its menu bar. The caller releases it.
static AXUIElementRef jarvis_mac_ax_of(AXUIElementRef e, CFStringRef attr) {
	CFTypeRef v = NULL;
	if (AXUIElementCopyAttributeValue(e, attr, &v) != kAXErrorSuccess || v == NULL) return NULL;
	if (CFGetTypeID(v) != AXUIElementGetTypeID()) {
		CFRelease(v);
		return NULL;
	}
	return (AXUIElementRef)v;
}

// The window of a program the person is in: the one with the keyboard,
// failing that its main one. The caller releases it.
static AXUIElementRef jarvis_mac_ax_window(int pid) {
	AXUIElementRef app = jarvis_mac_ax_app(pid);
	if (app == NULL) return NULL;
	AXUIElementRef win = jarvis_mac_ax_of(app, kAXFocusedWindowAttribute);
	if (win == NULL) win = jarvis_mac_ax_of(app, kAXMainWindowAttribute);
	CFRelease(app);
	return win;
}

// The thing in a program that has the keyboard. The caller releases it.
static AXUIElementRef jarvis_mac_ax_focused(int pid) {
	AXUIElementRef app = jarvis_mac_ax_app(pid);
	if (app == NULL) return NULL;
	AXUIElementRef e = jarvis_mac_ax_of(app, kAXFocusedUIElementAttribute);
	CFRelease(app);
	return e;
}

// The menu a program has open from its menu bar, if it has one open. The caller releases it.
static AXUIElementRef jarvis_mac_ax_open_menu(int pid) {
	AXUIElementRef app = jarvis_mac_ax_app(pid);
	if (app == NULL) return NULL;
	AXUIElementRef bar = jarvis_mac_ax_of(app, kAXMenuBarAttribute);
	CFRelease(app);
	if (bar == NULL) return NULL;
	AXUIElementRef menu = NULL;
	CFTypeRef picked = NULL;
	if (AXUIElementCopyAttributeValue(bar, kAXSelectedChildrenAttribute, &picked) == kAXErrorSuccess && picked != NULL) {
		if (CFGetTypeID(picked) == CFArrayGetTypeID() && CFArrayGetCount((CFArrayRef)picked) > 0) {
			CFTypeRef item = CFArrayGetValueAtIndex((CFArrayRef)picked, 0);
			if (item != NULL && CFGetTypeID(item) == AXUIElementGetTypeID()) {
				AXUIElementRef inside[1];
				if (jarvis_mac_ax_children((AXUIElementRef)item, inside, 1) == 1) menu = inside[0];
			}
		}
		CFRelease(picked);
	}
	CFRelease(bar);
	return menu;
}

static int jarvis_mac_ax_trusted(void) {
	return AXIsProcessTrusted() ? 1 : 0;
}

// ---------------------------------------------------------------------------
// A copy of a part of the screen
// ---------------------------------------------------------------------------

static int jarvis_mac_may_capture(void) {
	return CGPreflightScreenCaptureAccess() ? 1 : 0;
}

// nominal: one pixel to a point, whatever the display. The caller releases it.
static CGImageRef jarvis_mac_capture(int x, int y, int w, int h, int nominal) {
	if (w <= 0 || h <= 0) return NULL;
	CGWindowImageOption how = nominal ? kCGWindowImageNominalResolution : kCGWindowImageDefault;
	return CGWindowListCreateImage(CGRectMake(x, y, w, h), kCGWindowListOptionOnScreenOnly, kCGNullWindowID, how);
}

static void jarvis_mac_image_release(CGImageRef image) {
	if (image != NULL) CGImageRelease(image);
}

static int jarvis_mac_image_width(CGImageRef image) { return image != NULL ? (int)CGImageGetWidth(image) : 0; }
static int jarvis_mac_image_height(CGImageRef image) { return image != NULL ? (int)CGImageGetHeight(image) : 0; }

// A part of an image as a PNG, in the image's own pixels. With most above 0
// it is made smaller when its longest side is longer than that. The caller frees it.
static unsigned char *jarvis_mac_png(CGImageRef image, int x, int y, int w, int h, int most, int *outLen) {
	*outLen = 0;
	if (image == NULL || w <= 0 || h <= 0) return NULL;
	CGImageRef part = CGImageCreateWithImageInRect(image, CGRectMake(x, y, w, h));
	if (part == NULL) return NULL;
	size_t pw = CGImageGetWidth(part), ph = CGImageGetHeight(part);
	size_t longest = pw > ph ? pw : ph;
	if (most > 0 && longest > (size_t)most) {
		double f = (double)most / (double)longest;
		size_t nw = (size_t)(pw * f), nh = (size_t)(ph * f);
		if (nw < 1) nw = 1;
		if (nh < 1) nh = 1;
		CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
		CGContextRef ctx = CGBitmapContextCreate(NULL, nw, nh, 8, 0, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
		CGColorSpaceRelease(space);
		if (ctx != NULL) {
			CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
			CGContextDrawImage(ctx, CGRectMake(0, 0, nw, nh), part);
			CGImageRef small = CGBitmapContextCreateImage(ctx);
			CGContextRelease(ctx);
			if (small != NULL) {
				CGImageRelease(part);
				part = small;
			}
		}
	}
	NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:part];
	CGImageRelease(part);
	NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
	if (png == nil || png.length == 0) return NULL;
	unsigned char *out = (unsigned char *)malloc(png.length);
	if (out == NULL) return NULL;
	memcpy(out, png.bytes, png.length);
	*outLen = (int)png.length;
	return out;
}

// An image as pixels, each 0x00RRGGBB, row after row. The caller frees them.
static uint32_t *jarvis_mac_pixels(CGImageRef image, int *outW, int *outH) {
	*outW = 0;
	*outH = 0;
	if (image == NULL) return NULL;
	size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
	if (w == 0 || h == 0 || w > 8192 || h > 8192) return NULL;
	unsigned char *raw = (unsigned char *)calloc(w * h, 4);
	uint32_t *out = (uint32_t *)malloc(w * h * sizeof(uint32_t));
	if (raw == NULL || out == NULL) {
		if (raw != NULL) free(raw);
		if (out != NULL) free(out);
		return NULL;
	}
	CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
	CGContextRef ctx = CGBitmapContextCreate(raw, w, h, 8, w * 4, space, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
	CGColorSpaceRelease(space);
	if (ctx == NULL) {
		free(raw);
		free(out);
		return NULL;
	}
	CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
	CGContextRelease(ctx);
	for (size_t i = 0; i < w * h; i++) {
		out[i] = ((uint32_t)raw[i * 4] << 16) | ((uint32_t)raw[i * 4 + 1] << 8) | (uint32_t)raw[i * 4 + 2];
	}
	free(raw);
	*outW = (int)w;
	*outH = (int)h;
	return out;
}

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

// What is put on it: plain words, and beside them the same thing as a table
// or a list when there is one, the way a spreadsheet does. NULL words empties it.
static int jarvis_mac_clip_set(const char *plain, const char *html) {
	NSString *words = plain != NULL ? [NSString stringWithUTF8String:plain] : nil;
	NSString *rich = (html != NULL && html[0] != 0) ? [NSString stringWithUTF8String:html] : nil;
	__block int ok = 0;
	void (^work)(void) = ^{
		NSPasteboard *board = [NSPasteboard generalPasteboard];
		[board clearContents];
		ok = 1;
		if (words != nil) ok = [board setString:words forType:NSPasteboardTypeString] ? 1 : 0;
		if (ok && rich != nil) [board setString:rich forType:NSPasteboardTypeHTML];
	};
	if ([NSThread isMainThread]) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	return ok;
}

// A number that changes every time anything is put on the clipboard.
static long jarvis_mac_clip_count(void) {
	__block long count = 0;
	void (^work)(void) = ^{ count = (long)[NSPasteboard generalPasteboard].changeCount; };
	if ([NSThread isMainThread]) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	return count;
}

// The words on the clipboard, for the caller to free. NULL when it holds none.
static char *jarvis_mac_clip_text(void) {
	__block char *out = NULL;
	void (^work)(void) = ^{ out = jarvis_mac_dup([[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString]); };
	if ([NSThread isMainThread]) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	return out;
}

// ---------------------------------------------------------------------------
// A click or a key, made as if by hand
// ---------------------------------------------------------------------------

// Which key of the keyboard in use makes a letter or a digit, or -1. The
// keyboard is asked on the main thread, where the system wants it asked.
static int jarvis_mac_key_for(int letter) {
	__block int found = -1;
	void (^work)(void) = ^{
		TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
		if (source == NULL) return;
		CFDataRef data = (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
		if (data != NULL) {
			const UCKeyboardLayout *layout = (const UCKeyboardLayout *)CFDataGetBytePtr(data);
			for (int code = 0; code < 128 && found < 0; code++) {
				UInt32 dead = 0;
				UniChar chars[4];
				UniCharCount n = 0;
				if (UCKeyTranslate(layout, (UInt16)code, kUCKeyActionDown, 0, LMGetKbdType(), kUCKeyTranslateNoDeadKeysMask, &dead, 4, &n, chars) != noErr) continue;
				if (n == 1 && chars[0] == (UniChar)letter) found = code;
			}
		}
		CFRelease(source);
	};
	if ([NSThread isMainThread]) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	return found;
}

static CGEventFlags jarvis_mac_flags(int ctrl, int alt, int cmd, int shift) {
	CGEventFlags flags = 0;
	if (ctrl) flags |= kCGEventFlagMaskControl;
	if (alt) flags |= kCGEventFlagMaskAlternate;
	if (cmd) flags |= kCGEventFlagMaskCommand;
	if (shift) flags |= kCGEventFlagMaskShift;
	return flags;
}

// Presses one key with others held.
static void jarvis_mac_press(int code, int ctrl, int alt, int cmd, int shift) {
	CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
	CGEventFlags flags = jarvis_mac_flags(ctrl, alt, cmd, shift);
	CGEventRef down = CGEventCreateKeyboardEvent(source, (CGKeyCode)code, true);
	CGEventRef up = CGEventCreateKeyboardEvent(source, (CGKeyCode)code, false);
	if (down != NULL && up != NULL) {
		CGEventSetFlags(down, flags);
		CGEventSetFlags(up, flags);
		CGEventPost(kCGHIDEventTap, down);
		usleep(12000);
		CGEventPost(kCGHIDEventTap, up);
	}
	if (down != NULL) CFRelease(down);
	if (up != NULL) CFRelease(up);
	if (source != NULL) CFRelease(source);
}

// Types words where the keyboard is, as the signs they are, whatever keyboard is in use.
static void jarvis_mac_type(const char *utf8) {
	NSString *text = utf8 != NULL ? [NSString stringWithUTF8String:utf8] : nil;
	if (text == nil) return;
	CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
	NSUInteger length = text.length;
	for (NSUInteger at = 0; at < length;) {
		NSRange piece = [text rangeOfComposedCharacterSequencesForRange:NSMakeRange(at, MIN((NSUInteger)16, length - at))];
		UniChar chars[40];
		NSUInteger n = MIN(piece.length, (NSUInteger)40);
		[text getCharacters:chars range:NSMakeRange(piece.location, n)];
		CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
		CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
		if (down != NULL && up != NULL) {
			CGEventSetFlags(down, 0);
			CGEventSetFlags(up, 0);
			CGEventKeyboardSetUnicodeString(down, n, chars);
			CGEventKeyboardSetUnicodeString(up, n, chars);
			CGEventPost(kCGHIDEventTap, down);
			usleep(4000);
			CGEventPost(kCGHIDEventTap, up);
			usleep(4000);
		}
		if (down != NULL) CFRelease(down);
		if (up != NULL) CFRelease(up);
		at = piece.location + piece.length;
	}
	if (source != NULL) CFRelease(source);
}

// Presses the mouse at a place, once or twice, with keys held, and puts the
// person's own pointer back where it was.
static void jarvis_mac_click(double x, double y, int ctrl, int alt, int cmd, int shift, int twice) {
	CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
	CGPoint at = CGPointMake(x, y);
	double wasX = 0, wasY = 0;
	jarvis_mac_pointer(&wasX, &wasY);
	CGEventFlags flags = jarvis_mac_flags(ctrl, alt, cmd, shift);
	// Moved there first: a program that only looks at where the pointer is when it moves must see it arrive.
	CGEventRef move = CGEventCreateMouseEvent(source, kCGEventMouseMoved, at, kCGMouseButtonLeft);
	if (move != NULL) {
		CGEventPost(kCGHIDEventTap, move);
		CFRelease(move);
	}
	usleep(30000);
	for (int press = 1; press <= (twice ? 2 : 1); press++) {
		CGEventRef down = CGEventCreateMouseEvent(source, kCGEventLeftMouseDown, at, kCGMouseButtonLeft);
		CGEventRef up = CGEventCreateMouseEvent(source, kCGEventLeftMouseUp, at, kCGMouseButtonLeft);
		if (down != NULL && up != NULL) {
			CGEventSetIntegerValueField(down, kCGMouseEventClickState, press);
			CGEventSetIntegerValueField(up, kCGMouseEventClickState, press);
			CGEventSetFlags(down, flags);
			CGEventSetFlags(up, flags);
			CGEventPost(kCGHIDEventTap, down);
			usleep(12000);
			CGEventPost(kCGHIDEventTap, up);
		}
		if (down != NULL) CFRelease(down);
		if (up != NULL) CFRelease(up);
		if (twice && press == 1) usleep(60000);
	}
	usleep(20000);
	CGWarpMouseCursorPosition(CGPointMake(wasX, wasY));
	CGAssociateMouseAndMouseCursorPosition(true);
	if (source != NULL) CFRelease(source);
}
*/
import "C"

import (
	"fmt"
	"runtime"
	"unsafe"
)

// macWin is a window as the Mac's window list tells of one.
type macWin struct {
	ID    uint32
	Pid   int
	Layer int
	Rect  lookRect
	App   string
	Title string
}

func macWinFrom(w *C.JarvisMacWin) macWin {
	out := macWin{
		ID: uint32(w.wid), Pid: int(w.pid), Layer: int(w.layer),
		Rect: lookRect{int(w.x), int(w.y), int(w.w), int(w.h)},
	}
	if w.app != nil {
		out.App = C.GoString(w.app)
	}
	if w.title != nil {
		out.Title = C.GoString(w.title)
	}
	C.jarvis_mac_win_free(w)
	return out
}

// macWinAt is the topmost window of another program at a place.
func macWinAt(at lookPoint) (macWin, bool) {
	var w C.JarvisMacWin
	if C.jarvis_mac_win_at(C.double(at.X), C.double(at.Y), &w) == 0 {
		return macWin{}, false
	}
	return macWinFrom(&w), true
}

// macWinByID is a window by its number, as it is now.
func macWinByID(id uint32) (macWin, bool) {
	var w C.JarvisMacWin
	if C.jarvis_mac_win_by_id(C.uint(id), &w) == 0 {
		return macWin{}, false
	}
	return macWinFrom(&w), true
}

// macWinFind is the topmost ordinary window of a program, by its name, of a size.
func macWinFind(app string, w, h int) (macWin, bool) {
	cApp := C.CString(app)
	defer C.free(unsafe.Pointer(cApp))
	var win C.JarvisMacWin
	if C.jarvis_mac_win_find(cApp, C.int(w), C.int(h), &win) == 0 {
		return macWin{}, false
	}
	return macWinFrom(&win), true
}

// macWinFront is the window the person is in.
func macWinFront() (macWin, bool) {
	var w C.JarvisMacWin
	if C.jarvis_mac_win_front(&w) == 0 {
		return macWin{}, false
	}
	return macWinFrom(&w), true
}

// macActivate brings a program forward.
func macActivate(pid int) { C.jarvis_mac_activate(C.int(pid)) }

func macOwnAt(at lookPoint) bool { return C.jarvis_mac_own_at(C.double(at.X), C.double(at.Y)) == 1 }

// macScreenAt is the display a place is on, and how many pixels it has to a point.
func macScreenAt(at lookPoint) (lookRect, float64) {
	var x, y, w, h C.int
	var scale C.double
	C.jarvis_mac_screen_at(C.double(at.X), C.double(at.Y), &x, &y, &w, &h, &scale)
	return lookRect{int(x), int(y), int(w), int(h)}, float64(scale)
}

func macPointer() lookPoint {
	var x, y C.double
	C.jarvis_mac_pointer(&x, &y)
	return lookPoint{int(x), int(y)}
}

func macAXTrusted() bool { return C.jarvis_mac_ax_trusted() == 1 }

// A handle the system gave, when there is none. Go takes some of the Mac's
// handle types for numbers and some for pointers, by rules of its own, so
// "none" is never written as nil or 0 here: a handle is compared with one of
// these, which is right for both.
var (
	macNoElem  C.AXUIElementRef
	macNoImage C.CGImageRef
)

// macElem is a thing a program told of: what kind it is in the words the
// look uses, what it is called and says, and where it is. ref is held until
// release.
type macElem struct {
	ref    C.AXUIElementRef
	kind   string
	local  string
	raw    string
	name   string
	value  string
	rect   lookRect
	secure bool
}

func (e *macElem) release() {
	if e.ref != macNoElem {
		C.jarvis_mac_ax_release(e.ref)
		e.ref = macNoElem
	}
}

// held is whether there is a thing here at all.
func (e macElem) held() bool { return e.ref != macNoElem }

func macElemFrom(t *C.JarvisMacAX) macElem {
	role, subrole := "", ""
	if t.role != nil {
		role = C.GoString(t.role)
	}
	if t.subrole != nil {
		subrole = C.GoString(t.subrole)
	}
	kind, local := macRole(role, subrole)
	e := macElem{
		ref: t.ref, kind: kind, local: local, raw: role, secure: t.secure != 0,
		rect: lookRect{int(t.x), int(t.y), int(t.w), int(t.h)},
	}
	if t.name != nil {
		e.name = lookClean(C.GoString(t.name))
	}
	if t.value != nil {
		e.value = lookClean(C.GoString(t.value))
	}
	C.jarvis_mac_ax_free(t)
	return e
}

// macElemAt is what the program that owns the window at a place says is
// there. The caller releases it.
func macElemAt(at lookPoint, pid int, light bool) (macElem, bool) {
	var t C.JarvisMacAX
	if C.jarvis_mac_ax_at(C.double(at.X), C.double(at.Y), C.int(pid), boolToCInt(light), &t) == 0 {
		return macElem{}, false
	}
	return macElemFrom(&t), true
}

// macElemParent is what a thing stands in. The caller releases it.
func macElemParent(e macElem, light bool) (macElem, bool) {
	var t C.JarvisMacAX
	if !e.held() || C.jarvis_mac_ax_parent(e.ref, boolToCInt(light), &t) == 0 {
		return macElem{}, false
	}
	return macElemFrom(&t), true
}

// macElemChildren are the things inside a thing. The caller releases each.
func macElemChildren(e macElem, most int, light bool) []macElem {
	if !e.held() || most <= 0 {
		return nil
	}
	most = min(most, 512)
	refs := make([]C.AXUIElementRef, most)
	n := int(C.jarvis_mac_ax_children(e.ref, &refs[0], C.int(most)))
	out := make([]macElem, 0, n)
	for i := 0; i < n; i++ {
		var t C.JarvisMacAX
		C.jarvis_mac_ax_describe(refs[i], boolToCInt(light), &t)
		out = append(out, macElemFrom(&t))
	}
	return out
}

func macElemSame(a, b macElem) bool {
	return a.held() && b.held() && C.jarvis_mac_ax_same(a.ref, b.ref) == 1
}

// macElemOf reads a thing that was handed over already held.
func macElemOf(ref C.AXUIElementRef, light bool) (macElem, bool) {
	if ref == macNoElem {
		return macElem{}, false
	}
	var t C.JarvisMacAX
	C.jarvis_mac_ax_describe(ref, boolToCInt(light), &t)
	return macElemFrom(&t), true
}

// macElemHolds is what a field holds, as it is: not tidied and not cut short
// the way a name for a tag is. most is the longest it may be; a longer one
// comes back longer than most, so that whoever asked can refuse it instead of
// taking a part for the whole. What a password field holds is never read.
func macElemHolds(e macElem, most int) string {
	if !e.held() || e.secure {
		return ""
	}
	raw := C.jarvis_mac_ax_value(e.ref, C.int(most+1))
	if raw == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(raw))
	return C.GoString(raw)
}

// macWindowElem is the window of a program the person is in.
func macWindowElem(pid int, light bool) (macElem, bool) {
	return macElemOf(C.jarvis_mac_ax_window(C.int(pid)), light)
}

// macFocusedElem is the thing in a program that has the keyboard.
func macFocusedElem(pid int, light bool) (macElem, bool) {
	return macElemOf(C.jarvis_mac_ax_focused(C.int(pid)), light)
}

// macOpenMenu is the menu a program has open from its menu bar, if any.
func macOpenMenu(pid int) (macElem, bool) {
	return macElemOf(C.jarvis_mac_ax_open_menu(C.int(pid)), true)
}

// macShot is a copy of a part of the screen that pictures can be cut from.
type macShot struct {
	image C.CGImageRef
	// The part of the screen it shows, in points, and how many of its pixels
	// make a point.
	rect  lookRect
	scale float64
}

func macMayCapture() bool { return C.jarvis_mac_may_capture() == 1 }

// macCapture copies a part of the screen. Nil without the person's leave to
// record the screen: then the copy would show the desktop and nothing on it.
func macCapture(rect lookRect, nominal bool) *macShot {
	if rect.empty() || !macMayCapture() {
		return nil
	}
	image := C.jarvis_mac_capture(C.int(rect.X), C.int(rect.Y), C.int(rect.W), C.int(rect.H), boolToCInt(nominal))
	if image == macNoImage {
		return nil
	}
	shot := &macShot{image: image, rect: rect, scale: float64(C.jarvis_mac_image_width(image)) / float64(rect.W)}
	// The copy of a whole display is large: it goes when nothing holds it.
	runtime.SetFinalizer(shot, func(s *macShot) { s.close() })
	return shot
}

func (s *macShot) close() {
	if s.image != macNoImage {
		C.jarvis_mac_image_release(s.image)
		s.image = macNoImage
	}
}

func (s *macShot) png(part lookRect, most int) []byte {
	if s == nil || s.image == macNoImage || part.empty() {
		return nil
	}
	x := int(float64(part.X-s.rect.X) * s.scale)
	y := int(float64(part.Y-s.rect.Y) * s.scale)
	w := int(float64(part.W) * s.scale)
	h := int(float64(part.H) * s.scale)
	var length C.int
	data := C.jarvis_mac_png(s.image, C.int(x), C.int(y), C.int(w), C.int(h), C.int(most), &length)
	if data == nil || length <= 0 {
		return nil
	}
	defer C.free(unsafe.Pointer(data))
	return C.GoBytes(unsafe.Pointer(data), length)
}

// Cut and CutSmall make it a lookSnapshot.
func (s *macShot) Cut(part lookRect) []byte { return s.png(part, 0) }
func (s *macShot) CutSmall(part lookRect, most int) []byte {
	return s.png(part, most)
}

// pixels gives the copy as pixels, each 0x00RRGGBB, with its width and height.
func (s *macShot) pixels() ([]uint32, int, int) {
	if s == nil || s.image == macNoImage {
		return nil, 0, 0
	}
	var w, h C.int
	raw := C.jarvis_mac_pixels(s.image, &w, &h)
	if raw == nil || w <= 0 || h <= 0 {
		return nil, 0, 0
	}
	defer C.free(unsafe.Pointer(raw))
	out := make([]uint32, int(w)*int(h))
	copy(out, unsafe.Slice((*uint32)(unsafe.Pointer(raw)), len(out)))
	return out, int(w), int(h)
}

// macClipSet puts words on the clipboard, with a table or a list beside them when there is one.
func macClipSet(plain, html string) bool {
	cPlain := C.CString(plain)
	defer C.free(unsafe.Pointer(cPlain))
	cHTML := C.CString(html)
	defer C.free(unsafe.Pointer(cHTML))
	return C.jarvis_mac_clip_set(cPlain, cHTML) == 1
}

func macClipClear() bool { return C.jarvis_mac_clip_set(nil, nil) == 1 }

func macClipCount() int64 { return int64(C.jarvis_mac_clip_count()) }

func macClipText() (string, bool) {
	raw := C.jarvis_mac_clip_text()
	if raw == nil {
		return "", false
	}
	defer C.free(unsafe.Pointer(raw))
	return C.GoString(raw), true
}

// macPressKeys presses keys named as the watch names them ("cmd,c").
func macPressKeys(spec string) error {
	keys, err := parseMacKeys(spec)
	if err != nil {
		return err
	}
	code, named := watchMacKeyCodes[keys.Name]
	if !named {
		letter := keys.Name[0]
		// Where that letter is on the keyboard in use; failing that, where it is on the commonest one.
		code = int(C.jarvis_mac_key_for(C.int(letter)))
		if code < 0 {
			ansi, ok := watchMacAnsiKeys[letter]
			if !ok {
				return fmt.Errorf("no key for %q on this keyboard", keys.Name)
			}
			code = ansi
		}
	}
	C.jarvis_mac_press(C.int(code), boolToCInt(keys.Ctrl), boolToCInt(keys.Alt), boolToCInt(keys.Cmd), boolToCInt(keys.Shift))
	return nil
}

func macType(text string) {
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))
	C.jarvis_mac_type(cText)
}

// macClick presses the mouse at a place with keys held ("shift"), once or
// twice, and puts the person's own pointer back.
func macClick(at lookPoint, mods string, twice bool) {
	held := macKeys{}
	for _, part := range splitMacMods(mods) {
		switch part {
		case "ctrl":
			held.Ctrl = true
		case "alt":
			held.Alt = true
		case "cmd":
			held.Cmd = true
		case "shift":
			held.Shift = true
		}
	}
	C.jarvis_mac_click(C.double(at.X), C.double(at.Y), boolToCInt(held.Ctrl), boolToCInt(held.Alt), boolToCInt(held.Cmd), boolToCInt(held.Shift), boolToCInt(twice))
}

func splitMacMods(mods string) []string {
	var parts []string
	start := 0
	for i := 0; i <= len(mods); i++ {
		if i == len(mods) || mods[i] == ',' {
			if i > start {
				parts = append(parts, mods[start:i])
			}
			start = i + 1
		}
	}
	return parts
}
