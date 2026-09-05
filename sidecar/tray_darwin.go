//go:build darwin

package main

// macOS menu-bar (status item) icon + live dropdown menu.
//
// NSStatusItem + its menu must live on the main thread under a running
// NSApplication. So on macOS the tray takes over the main thread (`[NSApp run]`)
// and the client runs on a goroutine — the inverse of Windows. A side benefit:
// this establishes the process's Cocoa main run loop, which is what the pebble /
// panels overlays need for their dispatch_async(main_queue) work to drain.
//
// The menu mirrors the Windows tray (design: usejarvis-tray.html §00): a
// header with the current state, a "Waiting on you" row when approvals pend, the
// Pause / Mute toggles, recent activity, the ways into the app, Quit, and a
// brain/sidecar/port health footer. It is rebuilt from the live TrayStatus each
// time the brain pushes one (tray.status → setTrayStatus → trayRefresh) and on
// connection-state changes, so it is always current when the user opens it.
//
// The status-item icon is the smallest piece of brand we ship: a monochrome drop
// (appearance-aware — light on a dark menu bar, dark on a light one) with a
// single state dot (listen/speak/hold/ok, white while thinking) and a dashed
// outline when muted. No animation up there; the system throttles it.
//
// COMPILE-UNVERIFIED in the Linux/WSL dev box (no Cocoa SDK) — must be checked on
// a Mac.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>
#include <stdlib.h>

extern void goTrayClose(void);
extern void goTrayOpenChat(void);
extern void goTrayOpenAccount(void);
extern void goTrayOpenSettings(void);
extern void goTrayOpenLogs(void);
extern void goTrayPause(void);
extern void goTrayMute(void);
extern void goTrayWaiting(void);
extern void goTrayReopen(void);

// Menu action target: forwards clicks back into Go. Also acts as the
// NSApplication delegate (set in jarvisTraySetup) so that webview_go's panel
// engine, on first construction, sees a non-nil app delegate and goes straight
// to creating its window instead of spinning up its own temporary [NSApp run]
// loop on a background goroutine (which would never receive the already-fired
// didFinishLaunching and would hang / race the tray's run loop).
@interface JarvisTrayTarget : NSObject <NSApplicationDelegate>
- (void)onClose:(id)sender;
- (void)onChat:(id)sender;
- (void)onAccount:(id)sender;
- (void)onSettings:(id)sender;
- (void)onLogs:(id)sender;
- (void)onPause:(id)sender;
- (void)onMute:(id)sender;
- (void)onWaiting:(id)sender;
- (BOOL)applicationShouldHandleReopen:(NSApplication*)sender hasVisibleWindows:(BOOL)flag;
@end
@implementation JarvisTrayTarget
- (void)onClose:(id)sender    { (void)sender; goTrayClose(); }
- (void)onChat:(id)sender     { (void)sender; goTrayOpenChat(); }
- (void)onAccount:(id)sender  { (void)sender; goTrayOpenAccount(); }
- (void)onSettings:(id)sender { (void)sender; goTrayOpenSettings(); }
- (void)onLogs:(id)sender     { (void)sender; goTrayOpenLogs(); }
- (void)onPause:(id)sender    { (void)sender; goTrayPause(); }
- (void)onMute:(id)sender     { (void)sender; goTrayMute(); }
- (void)onWaiting:(id)sender  { (void)sender; goTrayWaiting(); }
// A LSUIElement/Accessory app has no windows and no Dock icon, so when the user
// re-launches Jarvis.app (or double-clicks it after "You're connected"),
// LaunchServices sends this reopen event instead of starting a new process.
// Without a handler AppKit does nothing and the app looks dead — the #1 "I
// connected and nothing happened" report. Bring ourselves to the front first:
// an Accessory app is not auto-activated on reopen, so a panel opened here can
// otherwise order in BEHIND the frontmost app — the softer version of the same
// bug. Then forward to Go, which opens the dashboard (or local settings when
// the brain is unreachable). Return NO — we fully handled the reopen; an
// Accessory app has no default windows for AppKit to restore, and the comment/
// contract must not claim otherwise (NO = "handled, do nothing further").
- (BOOL)applicationShouldHandleReopen:(NSApplication*)sender hasVisibleWindows:(BOOL)flag {
    (void)sender; (void)flag;
    [NSApp activateIgnoringOtherApps:YES];
    goTrayReopen();
    return NO;
}
@end

static NSStatusItem*     gStatusItem = nil;
static JarvisTrayTarget* gTrayTarget = nil;

// jarvisDropPath builds the brand drop: a rounded box with three big-radius
// corners and one small ("sharp") corner at the top-right, matching the web
// cursor pebble's `border-radius: 50% 4px 50% 50%`. The dot sits over that
// sharp corner.
static NSBezierPath* jarvisDropPath(NSRect r, CGFloat rBig, CGFloat rSharp) {
    NSBezierPath* p = [NSBezierPath bezierPath];
    NSPoint topMid = NSMakePoint(NSMidX(r), NSMaxY(r));
    NSPoint tr = NSMakePoint(NSMaxX(r), NSMaxY(r));
    NSPoint br = NSMakePoint(NSMaxX(r), NSMinY(r));
    NSPoint bl = NSMakePoint(NSMinX(r), NSMinY(r));
    NSPoint tl = NSMakePoint(NSMinX(r), NSMaxY(r));
    [p moveToPoint:topMid];
    [p appendBezierPathWithArcFromPoint:tr toPoint:br radius:rSharp]; // top-right = sharp
    [p appendBezierPathWithArcFromPoint:br toPoint:bl radius:rBig];   // bottom-right
    [p appendBezierPathWithArcFromPoint:bl toPoint:tl radius:rBig];   // bottom-left
    [p appendBezierPathWithArcFromPoint:tl toPoint:topMid radius:rBig]; // top-left
    [p closePath];
    return p;
}

// jarvisMakeDropImage renders the status-item icon for the given state.
// stateCode matches pebbleStateToInt (0 idle, 1 listening, 2 thinking,
// 3 speaking, 4 working, 5 asking, 6 done, 7 muted). muted != 0 → dashed.
static NSImage* jarvisMakeDropImage(int stateCode, int muted) {
    CGFloat S = 18.0;
    NSImage* img = [[NSImage alloc] initWithSize:NSMakeSize(S, S)];
    [img lockFocus];
    [[NSGraphicsContext currentContext] setShouldAntialias:YES];

    // Appearance-aware ink: the drop must read on both light and dark menu bars.
    BOOL dark = YES;
    if (@available(macOS 10.14, *)) {
        NSAppearanceName n = [gStatusItem.button.effectiveAppearance
            bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        dark = [n isEqualToString:NSAppearanceNameDarkAqua];
    }
    NSColor* ink = dark ? [NSColor colorWithCalibratedWhite:0.94 alpha:1.0]
                        : [NSColor colorWithCalibratedWhite:0.11 alpha:1.0];

    NSRect dropRect = NSMakeRect(2.0, 1.5, 12.0, 12.0);
    NSBezierPath* drop = jarvisDropPath(dropRect, 6.0, 2.5);
    drop.lineWidth = 1.6;
    if (muted) {
        CGFloat dash[2] = {2.0, 1.6};
        [drop setLineDash:dash count:2 phase:0.0];
        [[ink colorWithAlphaComponent:0.55] set];
    } else {
        [ink set];
    }
    [drop stroke];

    // State dot at the sharp corner. Muted / idle show no dot.
    if (stateCode != 0 && !muted) {
        NSColor* dc = nil;
        switch (stateCode) {
            case 1: dc = [NSColor colorWithSRGBRed:0xE6/255.0 green:0x3B/255.0 blue:0x2E/255.0 alpha:1.0]; break; // listen
            case 2: // thinking
            case 4: dc = dark ? [NSColor whiteColor] : [NSColor colorWithCalibratedWhite:0.11 alpha:1.0]; break; // working
            case 3: dc = [NSColor colorWithSRGBRed:0x2D/255.0 green:0x78/255.0 blue:0xFF/255.0 alpha:1.0]; break; // speak
            case 5: dc = [NSColor colorWithSRGBRed:0xEA/255.0 green:0xA4/255.0 blue:0x0E/255.0 alpha:1.0]; break; // hold
            case 6: dc = [NSColor colorWithSRGBRed:0x2F/255.0 green:0xA4/255.0 blue:0x5E/255.0 alpha:1.0]; break; // ok
            default: dc = nil;
        }
        if (dc) {
            NSRect dot = NSMakeRect(11.5, 11.5, 5.0, 5.0);
            [dc set];
            [[NSBezierPath bezierPathWithOvalInRect:dot] fill];
        }
    }

    [img unlockFocus];
    // Not a template: we colour it (and the state dot) ourselves, appearance-aware.
    [img setTemplate:NO];
    return img;
}

// jarvisTraySetup creates the status item, target/delegate and an (empty) menu.
// Main thread only. The menu is populated by jarvisTrayRebuild.
static void jarvisTraySetup(void) {
    [NSApplication sharedApplication];
    // Accessory = menu-bar app with no Dock icon.
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    gStatusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    gStatusItem.button.image = jarvisMakeDropImage(0, 0);
    gStatusItem.button.toolTip = @"Jarvis";

    gTrayTarget = [[JarvisTrayTarget alloc] init];
    // Become the app delegate so panel webviews skip their own bootstrap run
    // loop (see the JarvisTrayTarget interface comment).
    [NSApp setDelegate:gTrayTarget];

    NSMenu* menu = [[NSMenu alloc] init];
    menu.autoenablesItems = NO;
    gStatusItem.menu = menu;
}

// --- menu builders -----------------------------------------------------------

static void jarvisAddDisabled(NSMenu* menu, NSString* title) {
    NSMenuItem* it = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
    [it setEnabled:NO];
    [menu addItem:it];
}

static void jarvisAddItem(NSMenu* menu, NSString* title, SEL sel) {
    NSMenuItem* it = [[NSMenuItem alloc] initWithTitle:title action:sel keyEquivalent:@""];
    [it setTarget:gTrayTarget];
    [it setEnabled:YES];
    [menu addItem:it];
}

static void jarvisAddCheck(NSMenu* menu, NSString* title, SEL sel, int checked) {
    NSMenuItem* it = [[NSMenuItem alloc] initWithTitle:title action:sel keyEquivalent:@""];
    [it setTarget:gTrayTarget];
    [it setEnabled:YES];
    [it setState:(checked ? NSControlStateValueOn : NSControlStateValueOff)];
    [menu addItem:it];
}

// jarvisTrayRebuild replaces the menu contents + status icon from the live model.
// Safe to call from any goroutine — marshals onto the main queue. Strings are
// UTF-8 C strings owned by the Go caller (copied here). recentJoined is the
// recent-activity lines joined by "\n" (may be empty).
static void jarvisTrayRebuild(const char* header, int waiting, int paused, int muted,
                              const char* recentJoined, const char* footer,
                              int online, int stateCode) {
    NSString* headerS = [NSString stringWithUTF8String:header ? header : "Jarvis"];
    NSString* recentS = [NSString stringWithUTF8String:recentJoined ? recentJoined : ""];
    NSString* footerS = [NSString stringWithUTF8String:footer ? footer : ""];
    (void)online;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!gStatusItem) return;
        gStatusItem.button.image = jarvisMakeDropImage(stateCode, muted);

        NSMenu* menu = [[NSMenu alloc] init];
        menu.autoenablesItems = NO;

        jarvisAddDisabled(menu, headerS);
        [menu addItem:[NSMenuItem separatorItem]];

        if (waiting > 0) {
            jarvisAddItem(menu, [NSString stringWithFormat:@"Waiting on you (%d)", waiting], @selector(onWaiting:));
            [menu addItem:[NSMenuItem separatorItem]];
        }

        jarvisAddCheck(menu, @"Pause Jarvis", @selector(onPause:), paused);
        jarvisAddCheck(menu, @"Mute microphone", @selector(onMute:), muted);
        [menu addItem:[NSMenuItem separatorItem]];

        if (recentS.length > 0) {
            jarvisAddDisabled(menu, @"Recent");
            NSArray<NSString*>* lines = [recentS componentsSeparatedByString:@"\n"];
            int n = 0;
            for (NSString* line in lines) {
                if (line.length == 0) continue;
                if (n >= 3) break;
                jarvisAddDisabled(menu, [@"   " stringByAppendingString:line]);
                n++;
            }
            [menu addItem:[NSMenuItem separatorItem]];
        }

        jarvisAddItem(menu, @"Open dashboard", @selector(onChat:));
        jarvisAddItem(menu, @"Account", @selector(onAccount:));
        jarvisAddItem(menu, @"Settings", @selector(onSettings:));
        jarvisAddItem(menu, @"Logs", @selector(onLogs:));
        [menu addItem:[NSMenuItem separatorItem]];

        jarvisAddItem(menu, @"Quit Jarvis", @selector(onClose:));

        if (footerS.length > 0) {
            [menu addItem:[NSMenuItem separatorItem]];
            jarvisAddDisabled(menu, footerS);
        }

        gStatusItem.menu = menu;
    });
}

// gTrayShouldQuit is set true only by jarvisTrayQuit. webview_go stops the app
// run loop when a panel window closes (on_window_destroyed -> terminate ->
// [NSApp stop]); that must NOT end the sidecar. So jarvisTrayRun re-enters the
// run loop after any stop and only returns when we actually want to quit.
static volatile int gTrayShouldQuit = 0;

// jarvisTrayRun runs the Cocoa main loop (blocks until jarvisTrayQuit).
static void jarvisTrayRun(void) {
    while (!gTrayShouldQuit) {
        [NSApp run];
    }
}

// jarvisTrayQuit removes the status item and stops the run loop. Safe to call
// from any goroutine — it marshals onto the main queue and posts a dummy event
// so -stop takes effect immediately.
static void jarvisTrayQuit(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (gStatusItem) {
            [[NSStatusBar systemStatusBar] removeStatusItem:gStatusItem];
            gStatusItem = nil;
        }
        gTrayShouldQuit = 1;
        [NSApp stop:nil];
        NSEvent* e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                        location:NSMakePoint(0, 0)
                                   modifierFlags:0
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                         subtype:0
                                           data1:0
                                           data2:0];
        [NSApp postEvent:e atStart:YES];
    });
}
*/
import "C"

import (
	"context"
	"runtime"
	"strings"
	"time"
	"unsafe"
)

// Pin the main goroutine to the process's main OS thread (thread 0) for the
// whole program, so [NSApp run] + the status item run where Cocoa requires.
func init() { runtime.LockOSThread() }

var (
	trayOnCloseDarwin      func()
	trayOpenChatDarwin     func()
	trayOpenAccountDarwin  func()
	trayOpenSettingsDarwin func()
	trayOpenLogsDarwin     func()
	trayOnReopenDarwin     func()                                         // Jarvis.app re-launched / double-clicked (Dock-less reopen)
	trayEmitDarwin         func(eventType string, payload map[string]any) // tray → brain (pause/mute)
	trayClientDarwin       *SidecarClient
)

// darwinRebuildTray reads the live TrayStatus + connection state and pushes the
// whole model into the Cocoa menu/icon. Called on status pushes (trayRefresh)
// and connection-state changes.
func darwinRebuildTray() {
	ts := getTrayStatus()
	online := trayClientDarwin != nil && trayClientDarwin.ConnState() == connConnected

	header := "Jarvis"
	if ts.State != "" && ts.State != "idle" {
		header = "Jarvis · " + ts.State
	}

	recent := ts.Recent
	if len(recent) > 3 {
		recent = recent[:3]
	}
	recentJoined := strings.Join(recent, "\n")

	footer := "brain offline"
	if online {
		footer = "brain online"
	}
	if ts.Sidecars != "" {
		footer += " · sidecar " + ts.Sidecars
	}
	if ts.Port > 0 {
		footer += " · :" + itoaTray(ts.Port)
	}

	cHeader := C.CString(header)
	cRecent := C.CString(recentJoined)
	cFooter := C.CString(footer)
	defer C.free(unsafe.Pointer(cHeader))
	defer C.free(unsafe.Pointer(cRecent))
	defer C.free(unsafe.Pointer(cFooter))

	C.jarvisTrayRebuild(
		cHeader,
		C.int(ts.Waiting),
		boolToCInt(ts.Paused),
		boolToCInt(ts.Muted),
		cRecent,
		cFooter,
		boolToCInt(online),
		C.int(trayStateCode(ts.State)),
	)
}

// itoaTray is a tiny int→string without pulling strconv into the cgo file's
// imports for one call.
func itoaTray(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// runWithTray (macOS): client on a goroutine, tray + NSApp run loop on the main
// thread. Blocks until "Close" (or a signal cancels the context).
func runWithTray(ctx context.Context, cancel context.CancelFunc, client *SidecarClient) {
	trayOnCloseDarwin = func() {
		client.Stop()
		cancel()
	}
	client.SetShutdown(trayOnCloseDarwin)
	trayOpenChatDarwin = client.OpenChat
	trayOpenAccountDarwin = client.OpenAccount
	trayOpenSettingsDarwin = client.OpenSettings
	trayOpenLogsDarwin = client.OpenLogViewer
	// Re-launch/double-click of the Dock-less app: bring the user somewhere
	// visible. The dashboard when the brain is up; local settings when it is not
	// (openRoom would otherwise fail to mint a panel token and, again, show
	// nothing — see openRoom's brain-origin/token guards).
	trayOnReopenDarwin = func() {
		if client.Connected() {
			client.OpenChat()
		} else {
			client.OpenSettings()
		}
	}
	trayClientDarwin = client
	trayEmitDarwin = func(et string, p map[string]any) {
		_ = client.sendEvent(context.Background(), SidecarEvent{
			EventType: et,
			Timestamp: time.Now().UnixMilli(),
			Priority:  "normal",
			Payload:   p,
		}, nil)
	}
	// The brain pushes tray.status → setTrayStatus → trayRefresh; rebuild the menu.
	trayRefresh = darwinRebuildTray

	go client.Start(ctx)

	C.jarvisTraySetup()
	darwinRebuildTray() // initial paint (offline, idle)

	// Poll the connection state and rebuild on change so the health footer + icon
	// track connected / error.
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		last := int32(-1)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cur := client.ConnState()
				if cur != last {
					last = cur
					darwinRebuildTray()
				}
			}
		}
	}()
	// Quit the run loop when the context is cancelled (menu Close OR a signal).
	go func() {
		<-ctx.Done()
		C.jarvisTrayQuit()
	}()
	C.jarvisTrayRun() // blocks on [NSApp run]
}
