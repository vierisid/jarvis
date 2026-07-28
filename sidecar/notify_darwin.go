//go:build darwin

package main

// macOS notifications — native UNUserNotification banners with inline action
// buttons (design §01). This requires the sidecar to run from inside a signed
// .app bundle (UNUserNotificationCenter is unavailable to a bare binary); the
// `make app-macos` target + packaging/macos/ produce that bundle. When run
// outside a bundle (bare dev binary) every call is a guarded no-op, so this is
// safe to keep compiled in.
//
// Buttons come from categories registered up front (one per kind): approval →
// Approve/Deny, done → View/Dismiss, sidecar → Open Jarvis/Dismiss. The user's
// tap arrives on the delegate and is forwarded to the brain as notify.action.
// (No jarvis:// protocol hop like Windows — macOS delivers the response into the
// running process directly.)
//
// COMPILE-UNVERIFIED on the Linux/WSL dev box (no Cocoa / UserNotifications
// SDK) — must be checked on a Mac.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation -framework UserNotifications

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdlib.h>

extern void goNotifyAction(char* id, char* kind, char* action);

// Delegate: presents banners even when frontmost and forwards taps to Go.
@interface JarvisNotifyDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation JarvisNotifyDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
       willPresentNotification:(UNNotification*)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    (void)center; (void)notification;
    if (@available(macOS 11.0, *)) {
        completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
    } else {
        completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
    }
}
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
didReceiveNotificationResponse:(UNNotificationResponse*)response
         withCompletionHandler:(void (^)(void))completionHandler {
    (void)center;
    NSDictionary* info = response.notification.request.content.userInfo;
    NSString* nid  = info[@"id"]   ?: @"";
    NSString* kind = info[@"kind"] ?: @"";
    NSString* action = response.actionIdentifier;
    // Tapping the banner body (not a button) → review/open the app.
    if ([action isEqualToString:UNNotificationDefaultActionIdentifier]) {
        action = @"review";
    } else if ([action isEqualToString:UNNotificationDismissActionIdentifier]) {
        action = @"dismiss";
    }
    goNotifyAction((char*)nid.UTF8String, (char*)kind.UTF8String, (char*)action.UTF8String);
    completionHandler();
}
@end

static JarvisNotifyDelegate* gNotifyDelegate = nil;

// bundled reports whether we're running from a .app (UN is otherwise unavailable).
static BOOL bundled(void) { return [[NSBundle mainBundle] bundleIdentifier] != nil; }

static void jarvisNotifySetup(void) {
    if (!bundled()) {
        NSLog(@"[notify] not running from a .app bundle — native notifications disabled");
        return;
    }
    if (@available(macOS 10.14, *)) {
        UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
        gNotifyDelegate = [[JarvisNotifyDelegate alloc] init];
        center.delegate = gNotifyDelegate;

        UNNotificationAction* approve = [UNNotificationAction actionWithIdentifier:@"approve" title:@"Approve" options:UNNotificationActionOptionAuthenticationRequired];
        UNNotificationAction* deny    = [UNNotificationAction actionWithIdentifier:@"deny"    title:@"Deny"    options:UNNotificationActionOptionDestructive];
        UNNotificationCategory* approval = [UNNotificationCategory categoryWithIdentifier:@"approval" actions:@[deny, approve] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone];

        UNNotificationAction* view      = [UNNotificationAction actionWithIdentifier:@"view"    title:@"View"    options:UNNotificationActionOptionForeground];
        UNNotificationAction* dismissD  = [UNNotificationAction actionWithIdentifier:@"dismiss" title:@"Dismiss" options:UNNotificationActionOptionNone];
        UNNotificationCategory* done = [UNNotificationCategory categoryWithIdentifier:@"done" actions:@[view, dismissD] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone];

        UNNotificationAction* open      = [UNNotificationAction actionWithIdentifier:@"review"  title:@"Open Jarvis" options:UNNotificationActionOptionForeground];
        UNNotificationAction* dismissS  = [UNNotificationAction actionWithIdentifier:@"dismiss" title:@"Dismiss"     options:UNNotificationActionOptionNone];
        UNNotificationCategory* sidecar = [UNNotificationCategory categoryWithIdentifier:@"sidecar" actions:@[open, dismissS] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone];

        UNNotificationAction* openU     = [UNNotificationAction actionWithIdentifier:@"review" title:@"Open Jarvis" options:UNNotificationActionOptionForeground];
        UNNotificationAction* later     = [UNNotificationAction actionWithIdentifier:@"later"  title:@"Later"       options:UNNotificationActionOptionNone];
        UNNotificationCategory* update  = [UNNotificationCategory categoryWithIdentifier:@"update" actions:@[openU, later] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone];

        [center setNotificationCategories:[NSSet setWithObjects:approval, done, sidecar, update, nil]];

        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                              completionHandler:^(BOOL granted, NSError* _Nullable error) {
            if (!granted) { NSLog(@"[notify] notification authorization not granted: %@", error); }
        }];
    }
}

static void jarvisNotifyShow(const char* cid, const char* ckind, const char* ctitle, const char* cbody) {
    if (!bundled()) { return; }
    if (@available(macOS 10.14, *)) {
        NSString* nid   = [NSString stringWithUTF8String:cid   ? cid   : ""];
        NSString* kind  = [NSString stringWithUTF8String:ckind ? ckind : ""];
        NSString* title = [NSString stringWithUTF8String:ctitle ? ctitle : ""];
        NSString* body  = [NSString stringWithUTF8String:cbody  ? cbody  : ""];
        dispatch_async(dispatch_get_main_queue(), ^{
            UNMutableNotificationContent* content = [[UNMutableNotificationContent alloc] init];
            content.title = title;
            content.body  = body;
            content.sound = [UNNotificationSound defaultSound];
            content.categoryIdentifier = kind; // approval / done / sidecar
            content.userInfo = @{@"id": nid, @"kind": kind};
            UNNotificationRequest* req = [UNNotificationRequest requestWithIdentifier:[[NSUUID UUID] UUIDString]
                                                                              content:content
                                                                              trigger:nil];
            [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:req
                                                                  withCompletionHandler:^(NSError* _Nullable error) {
                if (error) { NSLog(@"[notify] add request failed: %@", error); }
            }];
        });
    }
}
*/
import "C"

import "unsafe"

func init() {
	showNotification = darwinShowNotification
	setupNotifications = darwinSetupNotifications
	// maybeForwardProtocolLaunch stays the default no-op: macOS delivers action
	// responses in-process via the delegate, so there's no jarvis:// hop.
}

func darwinSetupNotifications() {
	C.jarvisNotifySetup()
}

func darwinShowNotification(n Notification) {
	body := n.Body
	if n.Meta != "" {
		body += " · " + n.Meta
	}
	cid := C.CString(n.ID)
	ckind := C.CString(n.Kind)
	ctitle := C.CString(n.Title)
	cbody := C.CString(body)
	defer C.free(unsafe.Pointer(cid))
	defer C.free(unsafe.Pointer(ckind))
	defer C.free(unsafe.Pointer(ctitle))
	defer C.free(unsafe.Pointer(cbody))
	C.jarvisNotifyShow(cid, ckind, ctitle, cbody)
}
