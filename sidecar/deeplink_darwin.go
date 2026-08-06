//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

// macOS URL-open receiver for jarvis:// deep links. Unlike Linux/Windows,
// LaunchServices never passes the URI in argv: it activates the running app
// (or launches it) and delivers a kAEGetURL Apple Event. The scheme itself is
// claimed by the app bundle's Info.plist (CFBundleURLTypes) — this file only
// installs the handler that RECEIVES the opens.

// char* (not const char*) to match cgo's generated signature exactly — the
// prototypes live in different TUs so a mismatch would link anyway, but only
// by accident.
extern void goHandleURLOpen(char* url);

@interface JarvisURLHandler : NSObject
- (void)handleGetURL:(NSAppleEventDescriptor*)event withReply:(NSAppleEventDescriptor*)reply;
@end

@implementation JarvisURLHandler
- (void)handleGetURL:(NSAppleEventDescriptor*)event withReply:(NSAppleEventDescriptor*)reply {
    NSString* s = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
    if (s != nil) {
        goHandleURLOpen((char*)[s UTF8String]);
    }
}
@end

static JarvisURLHandler* jarvisURLHandler = nil;

// Installed via the main queue. Ordering, made explicit so nobody re-derives
// it: on a launched-BY-URL cold start, AppKit delivers the queued launch
// Apple Event during finishLaunching — at the top of the first run loop —
// while main-queue blocks drain only once the loop is pumping, so the launch
// URL is DETERMINISTICALLY dropped, not racily. That is acceptable: a cold
// start has no live handshake to match anyway, and the app opens into
// onboarding, where the user's next click on the page arrives normally. It is
// also a platform asymmetry vs Linux/Windows (maybeDropProtocolLaunch): on
// macOS a jarvis:// click while the app is closed DOES cold-boot the full
// app via LaunchServices — behind a browser prompt, into onboarding, so it
// behaves like opening the app. 'GURL'/'GURL' are the classic
// kInternetEventClass / kAEGetURL four-char codes, spelled literally to avoid
// the Carbon header.
static void jarvisInstallURLHandler(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (jarvisURLHandler != nil) {
            return;
        }
        jarvisURLHandler = [[JarvisURLHandler alloc] init];
        [[NSAppleEventManager sharedAppleEventManager]
            setEventHandler:jarvisURLHandler
            andSelector:@selector(handleGetURL:withReply:)
            forEventClass:'GURL'
            andEventID:'GURL'];
    });
}
*/
import "C"

// installURLOpenHandler queues the Apple Event registration onto the Cocoa
// main queue (drained by whichever loop owns the main thread — the first-run
// webview during onboarding, [NSApp run] under the tray afterwards).
func installURLOpenHandler() {
	C.jarvisInstallURLHandler()
}
