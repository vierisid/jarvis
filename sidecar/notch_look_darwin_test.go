//go:build darwin

package main

import (
	"runtime"
	"testing"
	"time"
)

// The main thread of a test binary belongs to the goroutine that starts the
// tests, from here on, and that goroutine only waits for them. So no test
// ever runs on the main thread, where a wait for the main thread is answered
// in place and the test below would pass by luck on code that is wrong. No
// darwin test needs the main thread: none makes a window or runs a loop.
func init() {
	runtime.LockOSThread()
}

// The freeze on a Mac (docs/notch/fixes/10-sidecar-platform.md): sending a
// pointer home asked the main thread how tall the camera housing is, and
// waited, with the hands' lock held and mostly the look's as well. The main
// thread takes both inside the taps, so a move of the pointer or a key at
// that moment left the two waiting for each other for good.
//
// A test has no main thread that serves its queue, so anything here that
// waits for the main thread waits for ever: before the fix this test ran out
// of time, on any Mac, with no display and no permission needed. It is the
// one test of the Mac's own hands; the orders themselves are played on every
// system in notch_look_main_test.go.
//
// Written on a machine that cannot build for macOS, and first run by the
// macOS job in CI (sidecar-build-darwin).
func TestNotchLookMacHomeNeverWaitsOnTheMainThread(t *testing.T) {
	m := &lookMac{look: newNotchLook()}
	done := make(chan lookPoint, 1)
	go func() {
		// As every caller of home has it: with the lock held.
		m.mu.Lock()
		defer m.mu.Unlock()
		done <- m.home()
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("home waits for the main thread with the hands' lock held: on a running Mac that is the freeze")
	}
}
