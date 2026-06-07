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

// Menu action target: forwards the "Close" click back into Go.
@interface JarvisTrayTarget : NSObject
- (void)onClose:(id)sender;
@end
@implementation JarvisTrayTarget
- (void)onClose:(id)sender { (void)sender; goTrayClose(); }
@end

static NSStatusItem*     gStatusItem  = nil;
static JarvisTrayTarget* gTrayTarget  = nil;

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
    NSMenu* menu = [[NSMenu alloc] init];
    NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:@"Close"
                                                  action:@selector(onClose:)
                                           keyEquivalent:@""];
    [item setTarget:gTrayTarget];
    [menu addItem:item];
    gStatusItem.menu = menu;
}

// jarvisTrayRun runs the Cocoa main loop (blocks until jarvisTrayQuit).
static void jarvisTrayRun(void) { [NSApp run]; }

// jarvisTrayQuit removes the status item and stops the run loop. Safe to call
// from any goroutine — it marshals onto the main queue and posts a dummy event
// so -stop takes effect immediately.
static void jarvisTrayQuit(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (gStatusItem) {
            [[NSStatusBar systemStatusBar] removeStatusItem:gStatusItem];
            gStatusItem = nil;
        }
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
)

// Pin the main goroutine to the process's main OS thread (thread 0) for the
// whole program, so [NSApp run] + the status item run where Cocoa requires.
func init() { runtime.LockOSThread() }

var trayOnCloseDarwin func()

// runWithTray (macOS): client on a goroutine, tray + NSApp run loop on the main
// thread. Blocks until "Close" (or a signal cancels the context).
func runWithTray(ctx context.Context, cancel context.CancelFunc, client *SidecarClient) {
	trayOnCloseDarwin = func() {
		client.Stop()
		cancel()
	}

	go client.Start(ctx)

	C.jarvisTraySetup()
	// Quit the run loop when the context is cancelled (menu Close OR a signal).
	go func() {
		<-ctx.Done()
		C.jarvisTrayQuit()
	}()
	C.jarvisTrayRun() // blocks on [NSApp run]
}
