//go:build darwin

package main

// The notch's keys on macOS: an event tap.
//
// NOT YET RUN. Written alongside the Windows hook on a machine that cannot
// build for macOS; it is compiled in CI and nothing more.
//
// A tap, because the keys are pairs of modifiers held and let go, and because
// Esc has to be kept from the app in front while the notch has something on.
// A global key monitor (hotkeys_darwin.go) can do neither: it hears key-downs
// only and cannot keep a key. docs/PEBBLE_HOTKEYS.md weighs a tap against that
// monitor for an ordinary hotkey and rejects it; this is the case it does not
// cover, and docs/notch/README.md says what the tap may look at.
//
// It is an active tap, so it needs the Accessibility permission, which the app
// already asks for in its setup. It never prompts from here.
//
// Without the permission the keys are not dead: the two pairs are read by
// looking at the keyboard's state instead, which any program may do
// (notch_keys_poll.go has why, and what that cannot do). The third run on a
// real Mac, 19 November 2026, is why: the permission was on in the list and
// macOS did not honour it.
//
// Most of the deciding whether to wake Go at all is done in C, because a tap
// sees every key pressed on the machine: plain typing, with no Ctrl, Option or
// Cmd down, never crosses into Go. What does cross is a change of modifiers,
// Esc, and a key pressed while a modifier is held, and of that last only the
// fact, never the key.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework ApplicationServices -framework Security

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Security/Security.h>
#include <stdio.h>

extern int goNotchKey(int kind, int mods);

static CFMachPortRef jarvis_notch_tap = NULL;
static CFRunLoopSourceRef jarvis_notch_tap_source = NULL;

// The same bits as notchMods in notch_keys.go.
static int jarvis_notch_mods(CGEventFlags flags) {
    int mods = 0;
    if (flags & kCGEventFlagMaskControl) mods |= 1;
    if (flags & kCGEventFlagMaskAlternate) mods |= 2;
    if (flags & kCGEventFlagMaskCommand) mods |= 4;
    if (flags & kCGEventFlagMaskShift) mods |= 8;
    return mods;
}

// kind: 0 modifiers changed, 1 Esc down, 2 Esc up, 3 another key down,
// 4 the tap was switched off by the system and is back (forget every key).
static CGEventRef jarvis_notch_tap_callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void* info) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (jarvis_notch_tap != NULL) CGEventTapEnable(jarvis_notch_tap, true);
        goNotchKey(4, 0);
        return event;
    }
    // A key a program posted is not a key a person pressed, and only a person
    // talks to the notch: Jarvis itself presses keys in other apps. Events from
    // the keyboard carry no process id; posted ones carry the poster's.
    if (CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID) != 0) return event;
    CGEventFlags flags = CGEventGetFlags(event);
    int mods = jarvis_notch_mods(flags);
    if (type == kCGEventFlagsChanged) {
        goNotchKey(0, mods);
        return event;
    }
    if (type != kCGEventKeyDown && type != kCGEventKeyUp) return event;
    int64_t code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (code == 53) {
        // Esc. The only key that is ever kept from the app in front.
        return goNotchKey(type == kCGEventKeyDown ? 1 : 2, mods) ? NULL : event;
    }
    // Any other key: only its going down matters, and only while Ctrl, Option
    // or Cmd is held (it makes the modifiers somebody's shortcut). Plain
    // typing goes straight on, unseen by Go.
    if (type == kCGEventKeyDown && (flags & (kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand)) != 0) {
        goNotchKey(3, mods);
    }
    return event;
}

// Returns 1 when the tap is in, 0 when the system refused it.
static int jarvis_notch_tap_start(void) {
    if (jarvis_notch_tap != NULL) return 1;
    CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp);
    CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
        mask, jarvis_notch_tap_callback, NULL);
    if (tap == NULL) return 0;
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
    if (source == NULL) {
        CFRelease(tap);
        return 0;
    }
    jarvis_notch_tap = tap;
    jarvis_notch_tap_source = source;
    // On the app's own run loop, which the tray keeps running.
    CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CGEventTapEnable(tap, true);
    CFRunLoopWakeUp(CFRunLoopGetMain());
    return 1;
}

// The keyboard right now, asked of the system and not heard from it: which
// modifiers are down, how many keys have gone down since the system started,
// and whether Esc is down. The keyboard itself only (the HID state), so a key
// Jarvis presses in another app is not taken for the person's. None of the
// three needs a permission, and none says which key was typed.
static void jarvis_notch_keys_now(int* mods, unsigned int* downs, int* esc) {
    *mods = jarvis_notch_mods(CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState));
    *downs = (unsigned int)CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventKeyDown);
    *esc = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, (CGKeyCode)53) ? 1 : 0;
}

// What macOS makes of this program, for one line in the log. A permission that
// is on in System Settings and not honoured (the third run on a real Mac) can
// only be told apart from one that was never given by what is written here:
// who macOS takes the program for, whether its signature holds for the program
// as it runs, and what each permission answers when asked without prompting.
//
// out: "<bundle id>|<signed as>|<signature flags, hex>|<0 when the signature holds, else the system's code>"
static void jarvis_notch_self(char* out, int n) {
    if (n <= 0) return;
    out[0] = 0;
    @autoreleasepool {
        NSString* bundle = [[NSBundle mainBundle] bundleIdentifier];
        NSString* signedAs = @"?";
        unsigned int flags = 0;
        int holds = -1;
        SecCodeRef me = NULL;
        if (SecCodeCopySelf(kSecCSDefaultFlags, &me) == errSecSuccess && me != NULL) {
            holds = (int)SecCodeCheckValidity(me, kSecCSDefaultFlags, NULL);
            SecStaticCodeRef onDisk = NULL;
            if (SecCodeCopyStaticCode(me, kSecCSDefaultFlags, &onDisk) == errSecSuccess && onDisk != NULL) {
                CFDictionaryRef info = NULL;
                if (SecCodeCopySigningInformation(onDisk, kSecCSSigningInformation, &info) == errSecSuccess && info != NULL) {
                    NSDictionary* d = (__bridge NSDictionary*)info;
                    id name = d[(__bridge NSString*)kSecCodeInfoIdentifier];
                    if ([name isKindOfClass:[NSString class]]) signedAs = [(NSString*)name copy];
                    id f = d[(__bridge NSString*)kSecCodeInfoFlags];
                    if ([f isKindOfClass:[NSNumber class]]) flags = [(NSNumber*)f unsignedIntValue];
                    CFRelease(info);
                }
                CFRelease(onDisk);
            }
            CFRelease(me);
        }
        snprintf(out, (size_t)n, "%s|%s|%x|%d", bundle != nil ? bundle.UTF8String : "none", signedAs.UTF8String, flags, holds);
    }
}

// Each permission's answer when asked without prompting. 1 yes, 0 no.
static void jarvis_notch_permissions(int* ax, int* listen, int* post, int* screen) {
    *ax = AXIsProcessTrusted() ? 1 : 0;
    *listen = CGPreflightListenEventAccess() ? 1 : 0;
    *post = CGPreflightPostEventAccess() ? 1 : 0;
    *screen = CGPreflightScreenCaptureAccess() ? 1 : 0;
}

static void jarvis_notch_tap_stop(void) {
    CFMachPortRef tap = jarvis_notch_tap;
    CFRunLoopSourceRef source = jarvis_notch_tap_source;
    jarvis_notch_tap = NULL;
    jarvis_notch_tap_source = NULL;
    if (tap != NULL) CGEventTapEnable(tap, false);
    if (source != NULL) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
        CFRelease(source);
    }
    if (tap != NULL) {
        CFMachPortInvalidate(tap);
        CFRelease(tap);
    }
}
*/
import "C"

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// The keyboard the tap feeds. One notch per process, so one of these.
var notchTapKeyboard atomic.Pointer[notchKeyboard]

// notchTapSeen is what the tap's callback hands to Go. It reports whether to
// keep the key from the app in front.
func notchTapSeen(kind, mods int) bool {
	kb := notchTapKeyboard.Load()
	if kb == nil {
		return false
	}
	switch kind {
	case 0:
		return kb.key(notchKeyModifiers, notchMods(mods))
	case 1:
		return kb.key(notchKeyEscDown, notchMods(mods))
	case 2:
		return kb.key(notchKeyEscUp, notchMods(mods))
	case 3:
		return kb.key(notchKeyOther, notchMods(mods))
	case 4:
		// The system switched the tap off for a while: keys came and went
		// unseen, so none can be taken as still down.
		kb.reset()
	}
	return false
}

// platformNotchKeysAvailable says how the keys can be watched here: with the
// tap when the Accessibility permission is given, and by looking at the
// keyboard's state when it is not. Either way the two pairs work. It never
// prompts.
func platformNotchKeysAvailable() string {
	if !setupAXTrusted() {
		return notchKeysPairs
	}
	return notchKeysWatch
}

// notchAXAsked is set once this process has asked macOS for the Accessibility
// permission.
var notchAXAsked atomic.Bool

// notchPermWatchOnce starts the watch for the answer once in the life of the
// program.
var notchPermWatchOnce sync.Once

// How often the answer is looked for. The screen's answer costs a small
// program of its own each time (notchScreenAllowedFresh).
const notchPermLookEvery = 3 * time.Second

// notchAskForPermissions asks macOS for the two permissions the notch cannot
// do without, once each in the life of the program and only as the app it
// is, and then watches for the answer (notch_perms.go).
//
// Asking is how an app gets into the list where a permission is given. The
// notch never asked: it left that to the first-launch screen
// (setup_onboarding.go), which an install by scripts/notch/try.sh never
// shows. So on the fifth run on a real Mac (19 November 2026) the person
// went to System Settings to give it by hand, chose Jarvis, and Jarvis did
// not appear in the list at all. macOS shows its own window for each, with a
// button that opens the list; nothing of the notch's is added.
//
// A program that is not an app is not asked for: the permission would be
// offered to whatever started it (permissions_rpc.go has the same rule).
func notchAskForPermissions() {
	if !setupProcessBundled() {
		return
	}
	if !setupAXTrusted() && notchAXAsked.CompareAndSwap(false, true) {
		setupRequestPermission("accessibility")
		log.Printf("[notch] macOS was asked for the Accessibility permission, so that Jarvis is in its list " +
			"(System Settings, Privacy & Security, Accessibility; newer versions of macOS call the list Device Control and Data Access)")
	}
	if !setupScreenAllowed() && screenAsked.CompareAndSwap(false, true) {
		setupRequestPermission("screen")
		log.Printf("[notch] macOS was asked for the Screen Recording permission, so that Jarvis is in its list " +
			"(System Settings, Privacy & Security, Screen & System Audio Recording)")
	}
	notchPermWatchOnce.Do(notchWatchPermissions)
}

// notchWatchPermissions watches for what macOS allows since the start, and
// starts the app again when it is time (notch_perms.go says when). What was
// given takes effect only in a program that starts with it.
func notchWatchPermissions() {
	w := newNotchPermWatcher(notchPermState{Accessibility: setupAXTrusted(), Screen: setupScreenAllowed()})
	if !w.needed() {
		return
	}
	go func() {
		until := time.Now().Add(notchPermWatchFor)
		for time.Now().Before(until) {
			time.Sleep(notchPermLookEvery)
			// The screen's answer is fixed for the life of a program, so it is
			// asked of a new one each time, until it is yes.
			now := notchPermState{Accessibility: setupAXTrusted(), Screen: w.last.Screen || notchScreenAllowedFresh()}
			if !w.seen(now, time.Now()) {
				continue
			}
			log.Printf("[notch] macOS now allows Jarvis more than when it started (Accessibility: %v, Screen Recording: %v): "+
				"starting again, so that it takes effect", w.last.Accessibility, w.last.Screen)
			client := trayClientDarwin
			if client == nil {
				log.Printf("[notch] could not start again by itself: quit Jarvis and start it again")
				return
			}
			if err := client.Restart(); err != nil {
				log.Printf("[notch] could not start again by itself (%v): quit Jarvis and start it again", err)
			}
			return
		}
	}()
}

// The name a program of this app is started under to answer one question
// about a permission and end (platformPermissionProbe).
const notchProbeEnv = "JARVIS_PERMISSION_PROBE"

// notchScreenAllowedFresh asks whether macOS lets Jarvis see the screen, of a
// program that has only just started: this one's answer does not change while
// it runs. The program is this app's own, started for the one question, and
// macOS counts it as Jarvis.
func notchScreenAllowedFresh() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe)
	cmd.Env = append(os.Environ(), notchProbeEnv+"=screen")
	out, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(out)) == "yes"
}

// platformPermissionProbe answers the one question and says the program is
// done, when it was started for that. Called first thing in main.
func platformPermissionProbe() bool {
	if os.Getenv(notchProbeEnv) != "screen" {
		return false
	}
	if setupScreenAllowed() {
		os.Stdout.WriteString("yes")
	} else {
		os.Stdout.WriteString("no")
	}
	return true
}

// How often the keyboard is looked at without the tap. A tap of a pair lasts
// a tenth of a second or so; this sees each key of it go down and come up.
const notchKeysLookEvery = 8 * time.Millisecond

// platformNotchKeysStart starts the watch on the keyboard: the tap when it is
// allowed, else the looking. The function it returns ends it.
func platformNotchKeysStart(kb *notchKeyboard) (stop func(), err error) {
	// On a goroutine: checking the signature reads the whole program from disk.
	go notchLogMacPermissions()
	notchAskForPermissions()
	if setupAXTrusted() {
		notchTapKeyboard.Store(kb)
		if C.jarvis_notch_tap_start() != 0 {
			var once sync.Once
			return func() {
				once.Do(func() {
					C.jarvis_notch_tap_stop()
					notchTapKeyboard.CompareAndSwap(kb, nil)
				})
			}, nil
		}
		notchTapKeyboard.CompareAndSwap(kb, nil)
		log.Printf("[notch] keys: the system refused the keyboard tap although the Accessibility permission is given")
	}
	log.Printf("[notch] keys: without the Accessibility permission the two pairs are read from the keyboard's state. " +
		"Esc is heard and not kept from the app in front, and drawing round a thing needs the permission " +
		"(System Settings, Privacy & Security, Accessibility; newer versions of macOS call the list Device Control and Data Access), then Jarvis started again")
	return notchKeysLookStart(kb), nil
}

// notchKeysLookStart feeds the keyboard from looks at its state, on a
// goroutine of its own. The function it returns ends it and waits for it.
func notchKeysLookStart(kb *notchKeyboard) (stop func()) {
	quit := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(notchKeysLookEvery)
		defer ticker.Stop()
		var poll notchKeyPoll
		last := time.Now()
		for {
			select {
			case <-quit:
				return
			case now := <-ticker.C:
				// The machine slept, or this was held up: what the keyboard did
				// meanwhile was not seen, so no key can be taken as still down.
				if now.Sub(last) > time.Second {
					poll.reset()
					kb.reset()
				}
				last = now
				var mods, esc C.int
				var downs C.uint
				C.jarvis_notch_keys_now(&mods, &downs, &esc)
				for _, e := range poll.step(notchKeyLook{Mods: notchMods(mods), Downs: uint32(downs), Esc: esc != 0}) {
					kb.key(e.Kind, e.Mods)
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(quit)
			<-done
		})
	}
}

// notchLogMacPermissions writes what macOS makes of this program: one line,
// once for each time the keys are started.
func notchLogMacPermissions() {
	buf := make([]byte, 512)
	C.jarvis_notch_self((*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf)))
	parts := strings.SplitN(C.GoString((*C.char)(unsafe.Pointer(&buf[0]))), "|", 4)
	for len(parts) < 4 {
		parts = append(parts, "?")
	}
	var ax, listen, post, screen C.int
	C.jarvis_notch_permissions(&ax, &listen, &post, &screen)
	yes := func(v C.int) string {
		if v != 0 {
			return "yes"
		}
		return "no"
	}
	holds := "holds"
	if parts[3] != "0" {
		holds = "does NOT hold (the system's code " + parts[3] + ")"
	}
	log.Printf("[notch] to macOS this program is %q, signed as %q (flags %s); its signature %s as it runs. "+
		"Accessibility: %s. Hearing keys: %s. Pressing keys: %s. Screen recording: %s.",
		parts[0], parts[1], parts[2], holds, yes(ax), yes(listen), yes(post), yes(screen))
}
