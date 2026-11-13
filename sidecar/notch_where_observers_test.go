package main

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// The observers ask before they look. These run the real observers with the
// platform swapped for counters, so a test fails if an observer stops asking.

// whereForTest puts the one notchWhere the observers ask into a known state
// and puts it back afterwards.
func whereForTest(t *testing.T, front notchFront, never []string) {
	t.Helper()
	prev := notchWhere
	notchWhere = &NotchWhere{icons: map[string][]byte{}}
	t.Cleanup(func() { notchWhere = prev })
	notchWhere.SetNever(never, nil)
	notchWhere.SetFront(front, nil)
	notchWhere.Use(func(map[string]any, []byte) {})
}

func observerSeams(t *testing.T, app, title string) (shots, windows *atomic.Int32) {
	t.Helper()
	shots, windows = &atomic.Int32{}, &atomic.Int32{}
	prevCap, prevWin := observerCaptureScreen, observerActiveWindow
	t.Cleanup(func() { observerCaptureScreen, observerActiveWindow = prevCap, prevWin })
	observerCaptureScreen = func() ([]byte, error) { shots.Add(1); return []byte("a picture of the screen"), nil }
	observerActiveWindow = func() (string, string) { windows.Add(1); return app, title }
	return shots, windows
}

func capturesIn(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func TestScreenObserverTakesNoPictureWhileLookingAway(t *testing.T) {
	for name, front := range map[string]notchFront{
		"an app the person said never to watch": {App: "steam", Name: "Steam", Title: "Steam"},
		"a password being typed":                {App: "chrome", Name: "Google Chrome", Title: "Sign in", Password: true},
		"a bank":                                {App: "chrome", Name: "Google Chrome", Title: "UniCredit | Banca via Internet"},
	} {
		whereForTest(t, front, []string{"steam"})
		shots, windows := observerSeams(t, front.App, front.Title)
		dir := t.TempDir()
		sent := 0
		o := &ScreenObserver{intervalMs: 1000, captureDir: dir}
		o.capture(context.Background(), func(context.Context, SidecarEvent, []byte) error { sent++; return nil })
		if shots.Load() != 0 || windows.Load() != 0 || sent != 0 || capturesIn(t, dir) != 0 {
			t.Errorf("%s: %d screenshots, %d window reads, %d events, %d files; want none of any",
				name, shots.Load(), windows.Load(), sent, capturesIn(t, dir))
		}
	}
}

func TestScreenObserverDropsACaptureOfWhatItMustNotSee(t *testing.T) {
	// What was heard last says Notepad is in front. By the time the observer
	// reads the window itself, the person is in Steam: the picture it just
	// took is of Steam.
	whereForTest(t, notchFront{App: "notepad", Name: "Notepad", Title: "Untitled - Notepad"}, []string{"steam"})
	shots, _ := observerSeams(t, "Steam", "Steam")
	dir := t.TempDir()
	sent := 0
	o := &ScreenObserver{intervalMs: 1000, captureDir: dir}
	o.capture(context.Background(), func(context.Context, SidecarEvent, []byte) error { sent++; return nil })
	if shots.Load() != 1 {
		t.Fatalf("the observer should have looked once, looked %d times", shots.Load())
	}
	if sent != 0 {
		t.Errorf("a capture of an app never to be watched was sent")
	}
	if n := capturesIn(t, dir); n != 0 {
		t.Errorf("%d capture files were left on disk", n)
	}
	// The same observer, with an ordinary app in front, works as before.
	observerActiveWindow = func() (string, string) { return "notepad", "Untitled - Notepad" }
	o2 := &ScreenObserver{intervalMs: 1000, captureDir: dir}
	o2.capture(context.Background(), func(context.Context, SidecarEvent, []byte) error { sent++; return nil })
	if sent != 1 || capturesIn(t, dir) != 1 {
		t.Errorf("an ordinary capture: %d events, %d files; want one of each", sent, capturesIn(t, dir))
	}
}

func TestWindowObserverReadsNoTitleWhileLookingAway(t *testing.T) {
	whereForTest(t, notchFront{App: "chrome", Name: "Google Chrome", Title: "PayPal: Summary"}, nil)
	_, windows := observerSeams(t, "chrome", "PayPal: Summary")
	sent := 0
	o := &WindowObserver{intervalMs: 5000, stuckThresholdMs: 120000, sameWindowSince: time.Now()}
	o.poll(context.Background(), func(context.Context, SidecarEvent, []byte) error { sent++; return nil })
	if windows.Load() != 0 || sent != 0 {
		t.Errorf("looking away: %d window reads, %d events; want none", windows.Load(), sent)
	}
	// And what it reads itself is judged too: the state says Notepad, the
	// window it finds is a bank.
	whereForTest(t, notchFront{App: "notepad", Name: "Notepad", Title: "Untitled - Notepad"}, nil)
	o.poll(context.Background(), func(context.Context, SidecarEvent, []byte) error { sent++; return nil })
	if sent != 0 {
		t.Errorf("a bank's title was sent as a change of window")
	}
	// An ordinary window is reported as before.
	observerActiveWindow = func() (string, string) { return "notepad", "Untitled - Notepad" }
	o.poll(context.Background(), func(context.Context, SidecarEvent, []byte) error { sent++; return nil })
	if sent != 1 {
		t.Errorf("an ordinary change of window: %d events, want 1", sent)
	}
}

func TestObserversAreAsTheyWereWithTheNotchOff(t *testing.T) {
	// The same state, but no brain with the notch on is connected.
	prev := notchWhere
	notchWhere = &NotchWhere{icons: map[string][]byte{}}
	t.Cleanup(func() { notchWhere = prev })
	notchWhere.SetNever([]string{"steam"}, nil)
	notchWhere.SetFront(notchFront{App: "steam", Name: "Steam", Title: "PayPal", Password: true}, nil)
	shots, _ := observerSeams(t, "steam", "PayPal")
	sent := 0
	o := &ScreenObserver{intervalMs: 1000, captureDir: t.TempDir()}
	o.capture(context.Background(), func(context.Context, SidecarEvent, []byte) error { sent++; return nil })
	if shots.Load() != 1 || sent != 1 {
		t.Errorf("with the notch off: %d screenshots, %d events; want one of each, as before", shots.Load(), sent)
	}
}
