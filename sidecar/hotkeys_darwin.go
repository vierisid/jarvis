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
