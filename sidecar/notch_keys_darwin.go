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
// already asks for in its setup. It never prompts from here: without the
// permission it does not start, and says so.
//
// Most of the deciding whether to wake Go at all is done in C, because a tap
// sees every key pressed on the machine: plain typing, with no Ctrl, Option or
// Cmd down, never crosses into Go. What does cross is a change of modifiers,
// Esc, and a key pressed while a modifier is held, and of that last only the
// fact, never the key.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework ApplicationServices

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

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
	"fmt"
	"sync"
	"sync/atomic"
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

// platformNotchKeysAvailable says whether the keys can be watched here. The
// tap needs the Accessibility permission, which is asked for in setup and
// never from here.
func platformNotchKeysAvailable() string {
	if !setupAXTrusted() {
		return notchKeysBlocked
	}
	return notchKeysWatch
}

// platformNotchKeysStart puts the tap in. The function it returns takes it out.
func platformNotchKeysStart(kb *notchKeyboard) (stop func(), err error) {
	if !setupAXTrusted() {
		return nil, fmt.Errorf("the keys need the Accessibility permission (System Settings, Privacy & Security, Accessibility); grant it and start Jarvis again")
	}
	notchTapKeyboard.Store(kb)
	if C.jarvis_notch_tap_start() == 0 {
		notchTapKeyboard.CompareAndSwap(kb, nil)
		return nil, fmt.Errorf("the system refused the keyboard tap")
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			C.jarvis_notch_tap_stop()
			notchTapKeyboard.CompareAndSwap(kb, nil)
		})
	}, nil
}
