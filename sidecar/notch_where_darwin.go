//go:build darwin

package main

// Where the person is, on the Mac: heard from the system, not asked for.
//
// NOT YET RUN. Written alongside the Windows part on a machine that cannot
// build for macOS; GitHub's Mac job compiles it. It is to be tried by hand in
// pass 14 with everything else on the Mac.
//
// NSWorkspace says the moment another app comes to the front. A password
// field is known by the system's own "secure input" state, which every
// password field turns on. The front window's title comes from the window
// list and is only there when the person has allowed screen recording: with
// no title a bank's page is not recognised, and that is said in the notch's
// document as a limit of the Mac until it is tried.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework Carbon -framework CoreGraphics

#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#include <stdlib.h>
#include <string.h>

extern void goNotchWhereFront(char *name, char *bundle, int pid, void *png, int pngLen);

static id jarvisWhereObserver = nil;

// The app's icon, drawn at 32 points into a PNG.
static NSData *jarvis_where_icon(NSRunningApplication *app) {
	NSImage *icon = app.icon;
	if (icon == nil) return nil;
	NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
		initWithBitmapDataPlanes:NULL pixelsWide:32 pixelsHigh:32 bitsPerSample:8 samplesPerPixel:4
		hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
	if (rep == nil) return nil;
	NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
	if (context == nil) return nil;
	[NSGraphicsContext saveGraphicsState];
	[NSGraphicsContext setCurrentContext:context];
	[icon drawInRect:NSMakeRect(0, 0, 32, 32) fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1.0];
	[NSGraphicsContext restoreGraphicsState];
	return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

static void jarvis_where_report(NSRunningApplication *app) {
	if (app == nil) return;
	// This program coming to the front (the notch's text field) is not
	// somewhere the person went.
	if (app.processIdentifier == [[NSProcessInfo processInfo] processIdentifier]) return;
	NSString *name = app.localizedName ?: @"";
	NSString *bundle = app.bundleIdentifier ?: @"";
	NSData *png = jarvis_where_icon(app);
	goNotchWhereFront((char *)name.UTF8String, (char *)bundle.UTF8String, (int)app.processIdentifier,
		(void *)png.bytes, (int)png.length);
}

static void jarvis_where_start(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (jarvisWhereObserver != nil) return;
		NSNotificationCenter *center = [[NSWorkspace sharedWorkspace] notificationCenter];
		jarvisWhereObserver = [center addObserverForName:NSWorkspaceDidActivateApplicationNotification
			object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
				jarvis_where_report(note.userInfo[NSWorkspaceApplicationKey]);
			}];
		jarvis_where_report([[NSWorkspace sharedWorkspace] frontmostApplication]);
	});
}

// 1 while a password field has the keyboard anywhere on the system.
static int jarvis_where_secure_input(void) {
	return IsSecureEventInputEnabled() ? 1 : 0;
}

// Seconds since the keyboard or the mouse was last touched.
static double jarvis_where_idle_seconds(void) {
	return CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
}

// The title of the front window of a process, for the caller to free, or
// NULL when the system will not say (no screen recording permission).
static char *jarvis_where_title(int pid) {
	CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
	if (list == NULL) return NULL;
	char *out = NULL;
	for (NSDictionary *info in (__bridge NSArray *)list) {
		if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
		if ([info[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
		NSString *name = info[(__bridge NSString *)kCGWindowName];
		if (name != nil && name.length > 0) out = strdup(name.UTF8String);
		break;
	}
	CFRelease(list);
	return out;
}
*/
import "C"

import (
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// The app in front, as NSWorkspace last said, and who is told.
var (
	darwinWhere      atomic.Pointer[NotchWhere]
	darwinWhereMu    sync.Mutex
	darwinWhereFront notchFront
	darwinWherePid   int
	darwinWhereIcon  []byte
)

// notchWhereFrontChanged is NSWorkspace saying another app is in front.
func notchWhereFrontChanged(name, bundle string, pid int, icon []byte) {
	w := darwinWhere.Load()
	if w == nil {
		return
	}
	// What the list holds is the app's own name: "TextEdit", "Safari".
	front := notchFront{App: name, Name: name}
	if front.App == "" {
		front.App = bundle
	}
	darwinWhereMu.Lock()
	front.Password = darwinWhereFront.Password
	darwinWhereFront, darwinWherePid, darwinWhereIcon = front, pid, icon
	darwinWhereMu.Unlock()
	w.SetFront(front, icon)
}

func platformNotchWhereStart(w *NotchWhere) (stop func()) {
	darwinWhere.Store(w)
	C.jarvis_where_start()
	quit := make(chan struct{})
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		beats := 0
		for {
			select {
			case <-quit:
				return
			case <-ticker.C:
			}
			beats++
			w.SetStill(float64(C.jarvis_where_idle_seconds())*1000 >= notchStillMs)
			password := C.jarvis_where_secure_input() == 1
			darwinWhereMu.Lock()
			front, pid, icon := darwinWhereFront, darwinWherePid, darwinWhereIcon
			changed := front.Password != password
			front.Password = password
			// The title once a second: another tab or page changes it with no word from the system.
			if beats%2 == 0 && pid != 0 {
				title := ""
				if raw := C.jarvis_where_title(C.int(pid)); raw != nil {
					title = C.GoString(raw)
					C.free(unsafe.Pointer(raw))
				}
				if title != front.Title {
					front.Title = title
					changed = true
				}
			}
			darwinWhereFront = front
			darwinWhereMu.Unlock()
			if changed && front.App != "" {
				w.SetFront(front, icon)
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(quit) }) }
}
