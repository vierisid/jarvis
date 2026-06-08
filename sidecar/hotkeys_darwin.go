//go:build darwin

package main

// macOS global hotkeys via NSEvent addGlobalMonitorForEvents.
//
// COMPILE-UNVERIFIED in the Linux/WSL dev environment — must be checked on a
// Mac. NOTE: global key-down monitors require the process to be trusted for
// Accessibility (System Settings -> Privacy & Security -> Accessibility);
// without it the monitor installs but never fires. A failed/unfired hotkey is
// non-fatal (the disc click is the intended fallback once pebble input lands).

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework AppKit

#import <Cocoa/Cocoa.h>

extern void goHotkeyFire(unsigned long long hotkeyID);

// Returns a retained handle (void*) for the installed monitor; remove via
// jarvisHotkeyRemove. modMask is an NSEventModifierFlags subset; keyCode is the
// hardware key code. NOTE: the id param must not be named `id` -- that shadows
// the Objective-C `id` type used for the monitor handle below.
static void* jarvisHotkeyAdd(unsigned long modMask, unsigned short keyCode, unsigned long long hotkeyID) {
    NSEventModifierFlags want = (NSEventModifierFlags)modMask;
    id mon = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                    handler:^(NSEvent* e) {
        NSEventModifierFlags got = [e modifierFlags] & NSEventModifierFlagDeviceIndependentFlagsMask;
        if ([e keyCode] == keyCode && (got & want) == want) {
            goHotkeyFire(hotkeyID);
        }
    }];
    if (!mon) return NULL;
    return (__bridge_retained void*)mon;
}

static void jarvisHotkeyRemove(void* p) {
    if (!p) return;
    id mon = (__bridge_transfer id)p;
    [NSEvent removeMonitor:mon];
}
*/
import "C"

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
)

// NSEventModifierFlags (device-independent) subset.
const (
	hkdShift   = 1 << 17
	hkdControl = 1 << 18
	hkdOption  = 1 << 19
	hkdCommand = 1 << 20
)

var hotkeyRegDarwin sync.Map // uint64 -> func()
var hotkeyCounterDarwin atomic.Uint64

// darwinKeyCodes maps key names to macOS hardware key codes (US ANSI layout).
var darwinKeyCodes = map[string]uint16{
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
	"b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
	"i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
	"1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
	"return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
}

func startHotkeyListener(keyspec string, onFire func()) (func(), error) {
	mods, keyCode, err := parseDarwinKeyspec(keyspec)
	if err != nil {
		return nil, err
	}
	id := hotkeyCounterDarwin.Add(1)
	hotkeyRegDarwin.Store(id, onFire)
	mon := C.jarvisHotkeyAdd(C.ulong(mods), C.ushort(keyCode), C.ulonglong(id))
	if mon == nil {
		hotkeyRegDarwin.Delete(id)
		return nil, fmt.Errorf("addGlobalMonitor failed for %q (Accessibility permission?)", keyspec)
	}
	stop := func() {
		C.jarvisHotkeyRemove(mon)
		hotkeyRegDarwin.Delete(id)
	}
	return stop, nil
}

// parseDarwinKeyspec turns "cmd+k" / "ctrl+space" into an NSEventModifierFlags
// mask + a macOS hardware key code.
func parseDarwinKeyspec(spec string) (mods uint, keyCode uint16, err error) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(spec)), "+")
	if len(parts) == 0 || parts[len(parts)-1] == "" {
		return 0, 0, fmt.Errorf("empty hotkey spec")
	}
	keyTok := parts[len(parts)-1]
	for _, m := range parts[:len(parts)-1] {
		switch m {
		case "ctrl", "control":
			mods |= hkdControl
		case "shift":
			mods |= hkdShift
		case "alt", "option":
			mods |= hkdOption
		case "cmd", "command", "super", "win", "meta":
			mods |= hkdCommand
		default:
			return 0, 0, fmt.Errorf("unknown modifier %q in %q", m, spec)
		}
	}
	if keyTok == " " || keyTok == "spacebar" {
		keyTok = "space"
	}
	code, ok := darwinKeyCodes[keyTok]
	if !ok {
		return 0, 0, fmt.Errorf("unsupported key %q in %q", keyTok, spec)
	}
	return mods, code, nil
}
