//go:build windows

package main

import (
	"testing"
	"time"
)

// The video rule stands on being able to read the screen cheaply. This reads
// it for real. A machine with no desktop to read (some build machines) skips.
func TestNotchScreenSamplerReadsAGridFromTheScreen(t *testing.T) {
	fg, _, _ := procGetForegroundWindow.Call()
	var s notchScreenSampler
	defer s.release()

	start := time.Now()
	first, ok := s.take(fg)
	firstTook := time.Since(start)
	if !ok {
		t.Skip("no screen to read here")
	}
	if len(first) != notchSampleCols*notchSampleRows {
		t.Fatalf("a sample has %d points, want %d", len(first), notchSampleCols*notchSampleRows)
	}
	for i, c := range first {
		if c>>24 != 0 {
			t.Fatalf("point %d carries more than a colour: %#x", i, c)
		}
	}
	kept := append([]uint32(nil), first...)

	start = time.Now()
	second, ok := s.take(fg)
	secondTook := time.Since(start)
	if !ok || len(second) != len(kept) {
		t.Fatalf("the second read failed (ok=%v, %d points)", ok, len(second))
	}
	t.Logf("first read %v, second read %v, change between them %.3f, last input %d ms ago",
		firstTook, secondTook, notchSampleChange(kept, second), notchIdleMs())
	// It runs twice a second while a fullscreen app is in front. Anything near
	// this limit would be felt.
	if secondTook > 250*time.Millisecond {
		t.Fatalf("reading the screen took %v", secondTook)
	}
}
