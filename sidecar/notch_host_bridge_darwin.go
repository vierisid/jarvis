//go:build darwin

package main

// C to Go bridge for the notch's window (a file of its own, by the cgo rule
// that a file with //export may not also define C functions).

import "C"

// goNotchFacts is the window's timer saying what it sees: whether the app in
// front covers the display, and whether that app keeps the display awake
// itself (on the Mac that is also how a playing video is known). It is called
// on the main thread, so it only puts the facts down (notchFactsRelay) and
// takes no lock: the rule is applied on a goroutine.
//
//export goNotchFacts
func goNotchFacts(fullscreen, awake C.int) {
	notchMacFacts.Report(notchHostFacts{
		FullscreenInFront: fullscreen != 0,
		DisplayKeptAwake:  awake != 0,
		VideoPlaying:      awake != 0,
	})
}
