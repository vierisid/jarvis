//go:build darwin

package main

// TCC permission checks + requests for the --setup onboarding wizard. This is
// the only place the sidecar interrogates TCC directly; everywhere else the
// prompts fire implicitly on first use (malgo capture, screencapture, ...).
// Grants attach to this bundle's identifier + signing identity, which is why
// the installer never requests them — only the installed, signed Jarvis.app
// may (see code-signing/macos-setup.md in the usejarvis-docs repo).
//
// Status legend used across the C bridges:
//   0 = undetermined (never asked)   1 = granted
//   2 = denied/restricted            3 = not applicable (e.g. not bundled)
//
// COMPILE-UNVERIFIED: CGO/ObjC, built only on macOS - it cannot be compiled or
// run on a Linux dev box and must be checked on a Mac, the same caveat as
// tray_darwin.go and panels_extnav_darwin.go carry.

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework AVFoundation -framework CoreGraphics -framework ApplicationServices -framework UserNotifications

#import <Cocoa/Cocoa.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>
#import <UserNotifications/UserNotifications.h>

// Does this process have a bundle identity for TCC to hang grants on?
// A bare binary has none: the grants attach to whatever launched it (the
// terminal), so every row would describe a different app's permissions.
static int setup_bundled(void) {
    return [NSBundle mainBundle].bundleIdentifier ? 1 : 0;
}

// Notifications. UNUserNotificationCenter throws when the process has no
// bundle identifier (bare binary), so guard like notify_darwin.m's bundled().
// The settings read is async; wait briefly so the wizard's poll gets a real
// answer (completion normally lands in well under a second).
static int setup_notif_status(void) {
    if (!setup_bundled()) return 3;
    __block int result = 0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [[UNUserNotificationCenter currentNotificationCenter]
        getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *st) {
            switch (st.authorizationStatus) {
            case UNAuthorizationStatusAuthorized:
            case UNAuthorizationStatusProvisional: result = 1; break;
            case UNAuthorizationStatusNotDetermined: result = 0; break;
            default: result = 2; break;
            }
            dispatch_semaphore_signal(sem);
        }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)));
    // No dispatch_release: cgo compiles this with ARC, under which dispatch
    // objects are ObjC objects managed automatically — calling it is a hard
    // compile error ("ARC forbids explicit message send of 'release'").
    // The completion block retains sem for as long as it needs it, so the
    // timeout path is safe too.
    return result;
}

static void setup_notif_request(void) {
    if (!setup_bundled()) return;
    [[UNUserNotificationCenter currentNotificationCenter]
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                      completionHandler:^(BOOL granted, NSError *error) { (void)granted; (void)error; }];
}

// Microphone. AVCaptureDevice gives status readback (malgo's implicit prompt
// doesn't), which is what lets the wizard poll a row live.
static int setup_mic_status(void) {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
    case AVAuthorizationStatusAuthorized: return 1;
    case AVAuthorizationStatusNotDetermined: return 0;
    default: return 2;
    }
}

static void setup_mic_request(void) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) { (void)granted; }];
}

// Screen Recording. There is no "undetermined" — preflight is a boolean.
// The request makes Jarvis appear in the Settings pane list; macOS never
// shows a grant dialog for this one, the user must flip the toggle.
static int setup_screen_status(void) {
    return CGPreflightScreenCaptureAccess() ? 1 : 2;
}

static void setup_screen_request(void) {
    CGRequestScreenCaptureAccess();
}

// Accessibility (global hotkeys). Same shape as Screen Recording, but the
// prompt option pops the "grant in Settings" dialog once.
static int setup_ax_status(void) {
    return AXIsProcessTrusted() ? 1 : 2;
}

static void setup_ax_request(void) {
    CFStringRef keys[] = { kAXTrustedCheckOptionPrompt };
    CFBooleanRef values[] = { kCFBooleanTrue };
    CFDictionaryRef opts = CFDictionaryCreate(NULL,
        (const void **)keys, (const void **)values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    AXIsProcessTrustedWithOptions(opts);
    CFRelease(opts);
}
*/
import "C"

import (
	"fmt"
	"os/exec"
)

func permStatusString(v C.int) string {
	switch v {
	case 1:
		return "granted"
	case 2:
		return "denied"
	case 3:
		return "na"
	default:
		return "undetermined"
	}
}

// setupPermissionStatuses returns the wizard's four row states.
func setupPermissionStatuses() (notif, mic, screen, ax string) {
	return permStatusString(C.setup_notif_status()),
		permStatusString(C.setup_mic_status()),
		permStatusString(C.setup_screen_status()),
		permStatusString(C.setup_ax_status())
}

// setupRequestPermission triggers the OS prompt (or pane registration) for one
// permission. All requests are async/fire-and-forget; the wizard's poll picks
// up the outcome.
func setupRequestPermission(name string) {
	switch name {
	case "notifications":
		C.setup_notif_request()
	case "microphone":
		C.setup_mic_request()
	case "screen":
		C.setup_screen_request()
	case "accessibility":
		C.setup_ax_request()
	}
}

// setupPaneURLs maps wizard rows to System Settings deep links.
var setupPaneURLs = map[string]string{
	"notifications": "x-apple.systempreferences:com.apple.preference.notifications",
	"microphone":    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
	"screen":        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	"accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
}

// setupOpenPane deep-links the System Settings pane for a permission row.
// Through startPaneLauncher so a launcher that fails after fork is reported
// rather than counted as a window, and so the child is reaped: the RPC path
// runs this in a process that lives for weeks, not one about to re-exec.
func setupOpenPane(name string) error {
	url, ok := setupPaneURLs[name]
	if !ok {
		return fmt.Errorf("unknown permission %q", name)
	}
	return startPaneLauncher(exec.Command("open", url))
}

// setupPermissionGrant says HOW each row is obtained on macOS.
//
// The split is the OS's, not ours: notifications and the microphone have a
// real dialog, so requesting them can finish inside the app. Screen Recording
// and Accessibility have none - the request only registers Jarvis in the
// pane's list, and the user has to flip the toggle themselves. A wizard that
// treats the two the same either waits forever for a dialog that never comes
// or sends someone to a pane they didn't need.
func setupPermissionGrant(name string) string {
	switch name {
	case "notifications", "microphone":
		return grantPrompt
	case "screen", "accessibility":
		return grantPane
	}
	return grantNone
}

// setupProcessBundled reports whether TCC has an app identity to attach grants
// to. False when the sidecar runs as a bare binary instead of Jarvis.app.
func setupProcessBundled() bool { return C.setup_bundled() == 1 }

const setupPlatform = "darwin"
