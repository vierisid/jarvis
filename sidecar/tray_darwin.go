//go:build darwin

package main

// macOS menu-bar (status item) icon.
//
// NSStatusItem + its menu must live on the main thread under a running
// NSApplication. So on macOS the tray takes over the main thread (`[NSApp run]`)
// and the client runs on a goroutine — the inverse of Windows. A side benefit:
// this establishes the process's Cocoa main run loop, which is what the pebble /
// panels overlays need for their dispatch_async(main_queue) work to drain.
//
// The "Close" menu item stops the sidecar (client.Stop + cancel); cancelling the
// context quits the run loop, so a signal (SIGINT/TERM) shuts down the same way.
//
// COMPILE-UNVERIFIED in the Linux/WSL dev box (no Cocoa SDK) — must be checked on
// a Mac. The icon is a placeholder (an SF Symbol / letter), to be branded later.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

extern void goTrayClose(void);
extern void goTrayOpenChat(void);
extern void goTrayOpenSettings(void);
extern void goTrayOpenLogs(void);

// Menu action target: forwards clicks back into Go. Also acts as the
// NSApplication delegate (set in jarvisTraySetup) so that webview_go's panel
// engine, on first construction, sees a non-nil app delegate and goes straight
// to creating its window instead of spinning up its own temporary [NSApp run]
// loop on a background goroutine (which would never receive the already-fired
// didFinishLaunching and would hang / race the tray's run loop).
@interface JarvisTrayTarget : NSObject <NSApplicationDelegate>
- (void)onClose:(id)sender;
- (void)onChat:(id)sender;
- (void)onSettings:(id)sender;
- (void)onLogs:(id)sender;
@end
@implementation JarvisTrayTarget
- (void)onClose:(id)sender    { (void)sender; goTrayClose(); }
- (void)onChat:(id)sender     { (void)sender; goTrayOpenChat(); }
- (void)onSettings:(id)sender { (void)sender; goTrayOpenSettings(); }
- (void)onLogs:(id)sender     { (void)sender; goTrayOpenLogs(); }
@end

static NSStatusItem*     gStatusItem     = nil;
static JarvisTrayTarget* gTrayTarget     = nil;
static NSMenuItem*       gStatusMenuItem = nil; // the disabled "Connected"/"Disconnected" line

// jarvisTraySetup creates the status item + menu. Main thread only.
static void jarvisTraySetup(void) {
    [NSApplication sharedApplication];
    // Accessory = menu-bar app with no Dock icon.
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    gStatusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    NSStatusBarButton* btn = gStatusItem.button;
    if (@available(macOS 11.0, *)) {
        NSImage* img = [NSImage imageWithSystemSymbolName:@"circle.fill" accessibilityDescription:@"JARVIS Sidecar"];
        if (img) { [img setTemplate:YES]; btn.image = img; }
        else { btn.title = @"J"; }
    } else {
        btn.title = @"J";
    }
    btn.toolTip = @"JARVIS Sidecar";

    gTrayTarget = [[JarvisTrayTarget alloc] init];
    // Become the app delegate so panel webviews skip their own bootstrap run
    // loop (see the JarvisTrayTarget interface comment).
    [NSApp setDelegate:gTrayTarget];
    NSMenu* menu = [[NSMenu alloc] init];

    // Connection status — disabled (unclickable) info line. action:nil keeps it
    // non-selectable.
    gStatusMenuItem = [[NSMenuItem alloc] initWithTitle:@"Disconnected" action:nil keyEquivalent:@""];
    [gStatusMenuItem setEnabled:NO];
    [menu addItem:gStatusMenuItem];
    [menu addItem:[NSMenuItem separatorItem]];

    NSMenuItem* chatItem = [[NSMenuItem alloc] initWithTitle:@"Jarvis" action:@selector(onChat:) keyEquivalent:@""];
    [chatItem setTarget:gTrayTarget];
    [menu addItem:chatItem];
    NSMenuItem* settingsItem = [[NSMenuItem alloc] initWithTitle:@"Settings" action:@selector(onSettings:) keyEquivalent:@""];
    [settingsItem setTarget:gTrayTarget];
    [menu addItem:settingsItem];
    NSMenuItem* logsItem = [[NSMenuItem alloc] initWithTitle:@"Logs" action:@selector(onLogs:) keyEquivalent:@""];
    [logsItem setTarget:gTrayTarget];
    [menu addItem:logsItem];
    [menu addItem:[NSMenuItem separatorItem]];

    NSMenuItem* closeItem = [[NSMenuItem alloc] initWithTitle:@"Close"
                                                       action:@selector(onClose:)
                                                keyEquivalent:@""];
    [closeItem setTarget:gTrayTarget];
    [menu addItem:closeItem];

    gStatusItem.menu = menu;
}

// jarvisTraySetConnState updates the status line + menu-bar icon. state:
// 0 = connecting, 1 = connected, 2 = connection error. Safe to call from any
// goroutine — marshals onto the main queue.
static void jarvisTraySetConnState(int state) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (gStatusMenuItem) {
            gStatusMenuItem.title = (state == 1) ? @"Connected"
                                  : (state == 2) ? @"Connection error"
                                                 : @"Disconnected";
        }
        if (gStatusItem) {
            NSStatusBarButton* btn = gStatusItem.button;
            if (@available(macOS 11.0, *)) {
                // TODO: brand a dedicated connection-error glyph. For now the
                // default placeholder: a warning triangle vs the normal disc.
                NSString* sym = (state == 2) ? @"exclamationmark.triangle.fill" : @"circle.fill";
                NSImage* img = [NSImage imageWithSystemSymbolName:sym accessibilityDescription:@"JARVIS Sidecar"];
                if (img) { [img setTemplate:YES]; btn.image = img; }
            }
        }
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
	"time"
)

// Pin the main goroutine to the process's main OS thread (thread 0) for the
// whole program, so [NSApp run] + the status item run where Cocoa requires.
func init() { runtime.LockOSThread() }

var (
	trayOnCloseDarwin      func()
	trayOpenChatDarwin     func()
	trayOpenSettingsDarwin func()
	trayOpenLogsDarwin     func()
)

// runWithTray (macOS): client on a goroutine, tray + NSApp run loop on the main
// thread. Blocks until "Close" (or a signal cancels the context).
func runWithTray(ctx context.Context, cancel context.CancelFunc, client *SidecarClient) {
	trayOnCloseDarwin = func() {
		client.Stop()
		cancel()
	}
	client.SetShutdown(trayOnCloseDarwin)
	trayOpenChatDarwin = client.OpenChat
	trayOpenSettingsDarwin = client.OpenSettings
	trayOpenLogsDarwin = client.OpenLogViewer

	go client.Start(ctx)

	C.jarvisTraySetup()
	// Poll the connection state and push it to the status item (text + icon) on change.
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
					C.jarvisTraySetConnState(C.int(cur))
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
