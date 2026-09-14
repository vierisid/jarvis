//go:build linux

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
	"unsafe"
)

// The tracking map is what keeps a queued panel call off a destroyed GtkWindow
// and what ends a panel when GTK destroys its window. The destroy signal is
// stubbed so this runs without a display; goGTKWindowDestroyed is the same
// function the real signal calls.
func TestGTKWindowTracking(t *testing.T) {
	watched := 0
	orig := gtkWatchWindow
	gtkWatchWindow = func(unsafe.Pointer) { watched++ }
	defer func() { gtkWatchWindow = orig }()

	var a, b byte
	win, other := unsafe.Pointer(&a), unsafe.Pointer(&b)

	if gtkWindowAlive(win) {
		t.Fatal("untracked window reported alive")
	}
	early := 0
	gtkOnWindowDestroyed(other, func() { early++ })
	if early != 1 {
		t.Fatalf("destroy callback for an untracked window fired %d times, want 1 (right away)", early)
	}

	gtkTrackWindow(win)
	gtkTrackWindow(win)
	if watched != 1 {
		t.Fatalf("destroy signal connected %d times, want 1", watched)
	}
	if !gtkWindowAlive(win) {
		t.Fatal("tracked window reported dead")
	}

	first, second := 0, 0
	gtkOnWindowDestroyed(win, func() { first++ })
	gtkOnWindowDestroyed(win, func() { second++ })
	if first != 0 || second != 0 {
		t.Fatal("destroy callbacks fired before the window was destroyed")
	}

	goGTKWindowDestroyed(win)
	if first != 1 || second != 1 {
		t.Fatalf("destroy callbacks fired %d and %d times, want 1 each", first, second)
	}
	if gtkWindowAlive(win) {
		t.Fatal("destroyed window still reported alive")
	}
	goGTKWindowDestroyed(win)
	if first != 1 || second != 1 {
		t.Fatal("a second destroy re-ran the callbacks")
	}

	late := 0
	gtkOnWindowDestroyed(win, func() { late++ })
	if late != 1 {
		t.Fatalf("callback registered after destroy fired %d times, want 1 (right away)", late)
	}
}

// Before the client exists the connect and onboarding windows own GTK, so
// nothing may start the shared loop (and claim the run loop) from there.
func TestSharedGTKLoopRefusesToStartBeforeTheClient(t *testing.T) {
	if gtkLoopStarted.Load() {
		t.Skip("the shared GTK loop was already started in this process")
	}
	// Earlier tests create clients, which open the gate. Nothing has started
	// the loop yet, so closing it again for this test is safe.
	was := sharedGTKLoopAllowed.Load()
	sharedGTKLoopAllowed.Store(false)
	t.Cleanup(func() { sharedGTKLoopAllowed.Store(was) })

	ran := false
	if gtkInvokeSync(func() { ran = true }) {
		t.Fatal("gtkInvokeSync reported success before the client allowed the loop")
	}
	if ran {
		t.Fatal("gtkInvokeSync ran its function with no loop")
	}
	if gtkLoopStarted.Load() {
		t.Fatal("the shared GTK loop started before the client allowed it")
	}
	if _, _, err := platformGetCursorPos(); !errors.Is(err, errGTKUnavailable) {
		t.Fatalf("platformGetCursorPos before the client: err = %v, want errGTKUnavailable", err)
	}
}

const noDisplayChildEnv = "JARVIS_GTK_NO_DISPLAY_CHILD"

// With no display every entry point must fail fast rather than wait on a loop
// that never started. The checks run in a child process with the display
// stripped from its environment: GTK initialisation is once per process, and
// changing the environment of a process that has GLib threads is not safe.
func TestSharedGTKLoopWithoutDisplayFailsFast(t *testing.T) {
	if os.Getenv(noDisplayChildEnv) == "1" {
		checkGTKEntryPointsWithoutDisplay(t)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSharedGTKLoopWithoutDisplayFailsFast$", "-test.count=1", "-test.v")
	for _, kv := range os.Environ() {
		switch strings.SplitN(kv, "=", 2)[0] {
		case "DISPLAY", "WAYLAND_DISPLAY", "GDK_BACKEND", noDisplayChildEnv:
			continue
		}
		cmd.Env = append(cmd.Env, kv)
	}
	cmd.Env = append(cmd.Env, "GDK_BACKEND=x11", noDisplayChildEnv+"=1")
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("GTK entry points hung with no display:\n%s", out)
	}
	if err != nil {
		t.Fatalf("no-display child failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "--- PASS: TestSharedGTKLoopWithoutDisplayFailsFast") {
		t.Fatalf("no-display child did not run the checks:\n%s", out)
	}
}

func checkGTKEntryPointsWithoutDisplay(t *testing.T) {
	allowSharedUILoop()
	ran := false
	if gtkInvokeSync(func() { ran = true }) || ran {
		t.Error("gtkInvokeSync ran with no display")
	}
	var x byte
	if err := onGTKWindow(unsafe.Pointer(&x), func() {}); !errors.Is(err, errGTKUnavailable) {
		t.Errorf("onGTKWindow with no display: err = %v, want errGTKUnavailable", err)
	}
	if _, _, err := platformGetCursorPos(); !errors.Is(err, errGTKUnavailable) {
		t.Errorf("platformGetCursorPos with no display: err = %v, want errGTKUnavailable", err)
	}
	if wv := newPanelWebview(false); wv != nil {
		t.Error("newPanelWebview returned a webview with no display")
	}
	if sharedUILoopRunning() {
		t.Error("sharedUILoopRunning reports a loop with no display")
	}
}
