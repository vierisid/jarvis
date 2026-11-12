package main

import "strings"

// Is a video playing in the fullscreen app?
//
// The notch hides for a fullscreen video and only then. Two answers were tried
// on a real machine and failed, and the third is built on why.
//
//  1. "Something is keeping the display awake." True while a video plays, but
//     on that machine it was also true all day with no video, held by some
//     other program, and Windows does not say by whom without administrator
//     rights. A browser put into fullscreen to read lost the notch.
//  2. "The picture keeps changing by itself." A film does. But much of what
//     people watch barely moves: measured on screen recordings and interface
//     demos, half the samples showed no change at all and only one in six
//     changed by a tenth. A fullscreen video kept the notch for 15 seconds.
//
// What a player does that a page does not: it hides the mouse pointer once the
// hand is off the mouse. A page being read never does. So that is the test,
// with one thing beside it to show something is really playing: the app's own
// sound, or a picture that moves. Sound covers the video that does not move (a
// lecture, a protected film that reads as black); the picture covers the one
// that is muted.
//
// When in doubt the notch stays: a notch over a film is a smaller fault than a
// notch missing from a page.

const (
	// The grid of points a sample of the picture holds.
	notchSampleCols = 32
	notchSampleRows = 18
	// A point changed when its colour moved by more than this, added up over
	// red, green and blue (each 0 to 255). Below it is dither and noise.
	notchPointChanged = 36
	// The picture moved when at least this share of its points changed: 9 of
	// the 576. A text cursor or a spinner touches one or two.
	notchMovingShare = 0.015
	// How many samples back a moving picture still counts. Calm footage moves
	// only now and then; 8 samples at the 400 ms the watch runs at is 3.2 s.
	notchMovedWindow = 8
	// Samples in a row that say "being watched" before the notch hides.
	notchPlayingRun = 2
	// Samples in a row that do not, before it returns: 12 is 4.8 s. A player
	// shows the pointer again for about 3 s when the mouse is nudged, and that
	// must not bring the notch back; a paused film must.
	notchStillRun = 12
	// Input this recent means a hand is on the mouse or keyboard.
	notchInputGraceMs = 1200
)

// notchVideoSigns is what one look at the machine found.
type notchVideoSigns struct {
	// No mouse or keyboard input in the last notchInputGraceMs.
	handsOff bool
	// The mouse pointer is on the notch's display and is not being drawn: the
	// app in front has hidden it.
	pointerHidden bool
	// The mouse pointer is on another display, so it says nothing either way.
	pointerElsewhere bool
	// The app in front is playing sound.
	appSound bool
	// The share of the picture that changed since the last look, 0 to 1.
	change float64
}

// notchVideoWatch turns a run of looks into "a video is being watched".
type notchVideoWatch struct {
	prev     []uint32
	remember int // looks left for which the picture's last movement, hands off, is remembered
	watching int
	quiet    int
	video    bool
}

// reset forgets everything. It is called whenever there is no fullscreen app
// to look at, so one app is never judged by what the last one did.
func (v *notchVideoWatch) reset() {
	v.prev = v.prev[:0]
	v.remember, v.watching, v.quiet, v.video = 0, 0, 0, false
}

// change takes the next sample of the picture and returns the share of it that
// changed since the one before, 0 when there is none to compare with. A sample
// is one colour per grid point as 0x00RRGGBB. The slice is copied, so the
// caller may reuse it.
func (v *notchVideoWatch) change(sample []uint32) float64 {
	share := 0.0
	if len(v.prev) == len(sample) {
		share = notchSampleChange(v.prev, sample)
	}
	v.prev = append(v.prev[:0], sample...)
	return share
}

// observe takes one look and reports whether a video is being watched.
func (v *notchVideoWatch) observe(s notchVideoSigns) bool {
	// A picture that moves while a hand is on the mouse is scrolling as far as
	// anyone can tell, so only movement with hands off is remembered.
	// remember counts down the looks for which that movement is remembered.
	if s.handsOff && s.change >= notchMovingShare {
		v.remember = notchMovedWindow
	} else if v.remember > 0 {
		v.remember--
	}
	moved := v.remember > 0
	watching := false
	switch {
	case !s.handsOff:
	case s.pointerHidden:
		watching = s.appSound || moved
	case s.pointerElsewhere:
		// Without the pointer's word, ask for both.
		watching = s.appSound && moved
	}
	if watching {
		v.watching++
		v.quiet = 0
	} else {
		v.quiet++
		v.watching = 0
	}
	if v.watching >= notchPlayingRun {
		v.video = true
	}
	if v.quiet >= notchStillRun {
		v.video = false
	}
	return v.video
}

// notchSampleChange is the share of points whose colour changed between two
// samples of the same size, from 0 to 1.
func notchSampleChange(a, b []uint32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	changed := 0
	for i := range a {
		if notchColourDistance(a[i], b[i]) > notchPointChanged {
			changed++
		}
	}
	return float64(changed) / float64(len(a))
}

func notchColourDistance(a, b uint32) int {
	d := 0
	for shift := uint(0); shift <= 16; shift += 8 {
		x, y := int(a>>shift&0xff), int(b>>shift&0xff)
		if x > y {
			d += x - y
		} else {
			d += y - x
		}
	}
	return d
}

// notchAppPlaysSound reports whether the program in front is among the ones
// playing sound. Names are compared as the desktop app reports a program: the
// file name without its ending, in any case. A browser's sound comes from a
// helper process with the browser's own name, so the name is what matches.
//
// One exception: a Store app's window belongs to a host process that plays
// nothing itself, so for it any program playing sound counts.
func notchAppPlaysSound(program string, playing []string) bool {
	name := strings.TrimSuffix(strings.ToLower(program), ".exe")
	if name == "" || len(playing) == 0 {
		return false
	}
	if name == "applicationframehost" {
		return true
	}
	for _, p := range playing {
		if strings.TrimSuffix(strings.ToLower(p), ".exe") == name {
			return true
		}
	}
	return false
}

// notchIsCaptureOverlay reports whether the program in front is a screen
// capture tool choosing its area. While it does, it covers the whole screen
// and is in front, which is exactly what a fullscreen app looks like. The
// names are Windows' own tools, as the desktop app reports a program: the file
// name with or without its ending, in any case.
func notchIsCaptureOverlay(program string) bool {
	name := strings.TrimSuffix(strings.ToLower(program), ".exe")
	return name == "snippingtool" || name == "screenclippinghost"
}
