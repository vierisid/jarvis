//go:build windows

package main

import (
	"bytes"
	"image/png"
	"os"
	"sync"
	"testing"
	"time"
)

// Reads the window that is in front, the way the notch does. It looks and
// does nothing else. On a machine with no window in front (a build server)
// there is nothing to read, and the test says so.
func TestNotchWhereReadsTheWindowInFront(t *testing.T) {
	front := win32GetForegroundWindow()
	if front == 0 {
		t.Skip("no window is in front on this machine")
	}
	pid := win32GetWindowPid(front)
	path := processImagePath(pid)
	if path == "" {
		t.Skipf("Windows will not say which program pid %d is (it runs as administrator)", pid)
	}
	name := exeDisplayName(path)
	icon := exeIconPNG(path)
	t.Logf("in front: key %q, name %q, icon %d bytes", notchAppKey(path), name, len(icon))
	if notchAppKey(path) == "" {
		t.Errorf("no key for %q", path)
	}
	if len(icon) > 0 {
		img, err := png.Decode(bytes.NewReader(icon))
		if err != nil {
			t.Fatalf("the icon is not a PNG: %v", err)
		}
		if b := img.Bounds(); b.Dx() < 16 || b.Dx() > 256 || b.Dx() != b.Dy() {
			t.Errorf("the icon is %dx%d", b.Dx(), b.Dy())
		}
		if len(icon) > notchIconMaxBytes {
			t.Errorf("the icon weighs %d bytes, more than is sent", len(icon))
		}
	}
}

// This program's own file has a name and can be asked for an icon without harm.
func TestNotchWhereReadsAProgramFile(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	// A test program has no version information and the stock icon: neither
	// call may fail badly, whatever they find.
	_ = exeDisplayName(self)
	if icon := exeIconPNG(self); len(icon) > 0 {
		if _, err := png.Decode(bytes.NewReader(icon)); err != nil {
			t.Errorf("the icon is not a PNG: %v", err)
		}
	}
	if got := exeDisplayName(`C:\no\such\program.exe`); got != "" {
		t.Errorf("a file that is not there has no name, got %q", got)
	}
	if icon := exeIconPNG(`C:\no\such\program.exe`); len(icon) > notchIconMaxBytes {
		t.Errorf("a file that is not there gave %d bytes", len(icon))
	}
}

// The listening starts, says what it finds, and stops when told.
func TestNotchWhereListensAndStops(t *testing.T) {
	w := &NotchWhere{icons: map[string][]byte{}}
	var mu sync.Mutex
	var said []map[string]any
	w.Use(func(payload map[string]any, icon []byte) {
		mu.Lock()
		said = append(said, payload)
		mu.Unlock()
	})
	stop := platformNotchWhereStart(w)
	time.Sleep(1500 * time.Millisecond)
	stopped := make(chan struct{})
	go func() { stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("it did not stop within five seconds")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(said) == 0 {
		t.Fatal("nothing was said at all")
	}
	last := said[len(said)-1]
	t.Logf("said %d times; last: app %q, name %q, look %q, still %v, title %d characters",
		len(said), last["app"], last["name"], last["look"], last["still"], len([]rune(last["title"].(string))))
	if win32GetForegroundWindow() != 0 && last["app"] == "" && processImagePath(win32GetWindowPid(win32GetForegroundWindow())) != "" {
		t.Errorf("a window is in front and no app was named: %v", last)
	}
}

// Asking whether a password field has the keyboard answers, and soon.
func TestNotchPasswordFocusedAnswers(t *testing.T) {
	again := make(chan byte, 1)
	start := time.Now()
	is := notchPasswordFocused(false, again)
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("it took %v", took)
	}
	t.Logf("a password field has the keyboard: %v", is)
}
