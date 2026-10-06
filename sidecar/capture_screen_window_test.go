//go:build linux

package main

import (
	"errors"
	"strings"
	"testing"
)

// #710: capture_screen has no window capture, and it used to ignore `pid`, so
// a desktop_screenshot routed with one came back as the whole desktop. The
// daemon now refuses that before dispatching; this is the same refusal here,
// for a daemon that predates it. PATH is emptied so that, were the handler to
// reach the capture, it would fail as a capture rather than take a picture of
// the machine running the test -- which is exactly what the pre-fix handler
// did, so the code check below is what tells the two apart.
func TestCaptureScreenRefusesAWindowItCannotCapture(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	// A number, a zero, and the string an older daemon could pass through.
	for _, pid := range []any{float64(4242), float64(0), "4242"} {
		_, err := handleCaptureScreen(map[string]any{"pid": pid})
		var coded *codedError
		if !errors.As(err, &coded) || coded.code != "SCREENSHOT_WINDOW_UNSUPPORTED" {
			t.Fatalf("pid %#v was not refused as SCREENSHOT_WINDOW_UNSUPPORTED: %v", pid, err)
		}
		if !strings.Contains(err.Error(), "without pid") {
			t.Errorf("refusal %q does not say how to get a capture", err)
		}
	}
}
