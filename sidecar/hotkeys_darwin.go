//go:build darwin

package main

// macOS global hotkeys via NSEvent addGlobalMonitorForEvents.
//
// COMPILE-UNVERIFIED in the Linux/WSL dev environment - must be checked on a
// Mac. Everything in this file that CAN be decided without AppKit has been
// moved to hotkeys_keyspec.go, which carries no build tag and is table-tested
// on Linux: the keyspec grammar, the hardware key codes, and the exact-match
// rule the monitor applies. What is left here is the monitor itself.
//
// Two things a reader needs to know about this backend, both of them #563:
//
//  1. A global monitor is a PASSIVE OBSERVER. Its handler returns void, so the
//     keystroke cannot be consumed: the hotkey fires IN ADDITION to whatever the
//     OS or the focused app does with the same combination, and a combination
//     that is already taken produces no error at all. Windows (RegisterHotKey)
//     and Linux (XGrabKey) both consume the key; macOS cannot. That is why the
//     bindings are configurable and why `""` is a supported value.
//     docs/PEBBLE_HOTKEYS.md has the whole story.
//  2. Global KEY-DOWN monitors only fire when the process is trusted for
//     Accessibility. Without it the monitor installs successfully and never
//     fires, which used to be logged as "registered" - the single worst thing
//     the log could say to someone debugging a dead hotkey. It is probed and
//     reported now; see hotkeyAccessibilityCaveat.
//
// An unfired hotkey stays non-fatal: clicking the pebble disc does the same job.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework AppKit

#import <Cocoa/Cocoa.h>

extern void goHotkeyFire(unsigned long long hotkeyID);

// Returns a retained handle (void*) for the installed monitor; remove via
// jarvisHotkeyRemove. keyCode is the hardware key code. NOTE: the id param must
// not be named `id` -- that shadows the Objective-C `id` type used for the
// monitor handle below.
//
// modMask is the NSEventModifierFlags the user asked for and modCompareMask is
// the set of bits that may take part in the comparison. BOTH come from Go
// (parseDarwinKeyspec and darwinModifierCompareMask), so this block cannot
// disagree with darwinHotkeyMatches, which is the same rule written where a test
// can reach it.
static void* jarvisHotkeyAdd(unsigned long modMask, unsigned long modCompareMask, unsigned short keyCode, unsigned long long hotkeyID) {
    NSEventModifierFlags want = (NSEventModifierFlags)modMask;
    NSEventModifierFlags cmp  = (NSEventModifierFlags)modCompareMask;
    id mon = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                    handler:^(NSEvent* e) {
        // EXACT equality, not the old `(got & want) == want`, which matched any
        // keystroke that merely INCLUDED the wanted modifiers -- so a
        // `ctrl+space` binding also fired on Ctrl+Cmd+Space (the Character
        // Viewer), Ctrl+Shift+Space and Ctrl+Option+Space.
        //
        // cmp, not NSEventModifierFlagDeviceIndependentFlagsMask: that mask also
        // carries CapsLock, NumericPad, Help and Function, and macOS sets
        // Function on every F-key and arrow (plus NumericPad on the arrows), so
        // comparing those bits would make an f13 or arrow binding impossible to
        // press and would break every hotkey while Caps Lock was on.
        if ([e keyCode] == keyCode && ([e modifierFlags] & cmp) == want) {
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
	"sync"
	"sync/atomic"
)

var hotkeyRegDarwin sync.Map // uint64 -> func()
var hotkeyCounterDarwin atomic.Uint64

func startHotkeyListener(keyspec string, onFire func()) (func(), error) {
	mods, keyCode, err := parseDarwinKeyspec(keyspec)
	if err != nil {
		return nil, err
	}
	id := hotkeyCounterDarwin.Add(1)
	hotkeyRegDarwin.Store(id, onFire)
	mon := C.jarvisHotkeyAdd(C.ulong(mods), C.ulong(darwinModifierCompareMask), C.ushort(keyCode), C.ulonglong(id))
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

// hotkeyAccessibilityCaveat is what a successful registration has to admit on
// macOS: a global key-down monitor installs whether or not the process is
// trusted for Accessibility, and without that trust it never fires. Returns ""
// when there is nothing to admit, and a clause to append to the caller's
// "registered" line when there is.
//
// It is the caller's log line that has to change, not this function's, because
// "registered" is the part that was wrong. Callers: pebble_overlay_darwin.go
// (both hotkeys). panels_runtime.go registers a panel summon hotkey through the
// same startHotkeyListener and does NOT append this, which is a gap rather than
// a decision - nothing sets PanelSpec.SummonHotkey today, so that path is
// unreachable, and appending it there would need a non-darwin stub for a
// build-tag-free file.
//
// Deliberately a PROBE and not a request: setupAXTrusted calls
// AXIsProcessTrusted, which never prompts. The onboarding wizard owns the
// prompt (setupRequestPermission), and a background hotkey registration popping
// a permission dialog would be the wrong moment for it.
//
// Note what this cannot do: a monitor installed while untrusted does not start
// firing when the permission is granted later, so the message says to relaunch.
// The reverse case is the reason this is only a caveat on an otherwise
// successful registration rather than a refusal to install at all - a machine
// where the monitor works but AXIsProcessTrusted reports false (Input Monitoring
// granted instead, say) must still get its hotkey.
func hotkeyAccessibilityCaveat() string {
	if setupAXTrusted() {
		return ""
	}
	return " -- but it will NOT fire yet: Jarvis is not trusted for Accessibility." +
		" Grant it in System Settings -> Privacy & Security -> Accessibility, then relaunch Jarvis"
}
