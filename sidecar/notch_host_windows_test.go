//go:build windows

package main

import (
	"runtime"
	"strings"
	"testing"
	"time"

	ole "github.com/go-ole/go-ole"
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

// The other two signs, read for real: where the pointer is and whether it is
// drawn, and which programs are playing sound. Neither may fail or crash on a
// machine with nothing playing.
func TestNotchReadsThePointerAndTheProgramsPlayingSound(t *testing.T) {
	fg, _, _ := procGetForegroundWindow.Call()
	hidden, elsewhere := notchPointerState(fg)
	if hidden && elsewhere {
		t.Fatal("a pointer on another display cannot also be hidden on this one")
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err == nil {
		defer ole.CoUninitialize()
	}
	start := time.Now()
	programs, err := notchProgramsPlayingSound()
	took := time.Since(start)
	if err != nil {
		t.Skipf("no audio to ask here: %v", err)
	}
	for _, p := range programs {
		if p == "" || p != strings.ToLower(p) {
			t.Fatalf("program names come back lower case and not empty, got %q", p)
		}
	}
	program, class := notchForeground()
	t.Logf("pointer hidden %v, elsewhere %v; playing sound: %v (asked in %v); in front: %s (%s), plays sound: %v",
		hidden, elsewhere, programs, took, program, class, notchAppPlaysSound(program, programs))
	if took > 250*time.Millisecond {
		t.Fatalf("asking which programs play sound took %v", took)
	}
}
