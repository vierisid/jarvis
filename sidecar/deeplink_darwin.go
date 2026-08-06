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

extern void goHandleURLOpen(const char* url);

@interface JarvisURLHandler : NSObject
- (void)handleGetURL:(NSAppleEventDescriptor*)event withReply:(NSAppleEventDescriptor*)reply;
@end

@implementation JarvisURLHandler
- (void)handleGetURL:(NSAppleEventDescriptor*)event withReply:(NSAppleEventDescriptor*)reply {
    NSString* s = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
    if (s != nil) {
        goHandleURLOpen([s UTF8String]);
    }
}
@end

static JarvisURLHandler* jarvisURLHandler = nil;

// Installed via the main queue: registration races nothing that matters — a
// launched-BY-URL process has no first-run window (and thus no live handshake)
// yet, so an event slipping past before the handler lands would be dropped by
// the nonce gate anyway. 'GURL'/'GURL' are the classic kInternetEventClass /
// kAEGetURL four-char codes, spelled literally to avoid the Carbon header.
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
