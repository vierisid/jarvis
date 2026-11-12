package main

import "strings"

// Is a video playing in the fullscreen app?
//
// The notch hides for a fullscreen video and only then. "Something is keeping
// the display awake" was the first test for that. It is true while a video
// plays, but on a real machine it was also true all day with no video at all,
// held by some other program, and Windows does not say by whom without
// administrator rights. A browser put into fullscreen to read then lost the
// notch, which is the one thing the rule must not do.
//
// So the picture is asked directly. A video's picture keeps changing by
// itself. A page being read changes only when the person scrolls, and
// scrolling takes a hand on the mouse or keyboard. A sample of the screen that
// changed while nobody touched anything is a video.
//
// When in doubt the notch stays: a notch over a still frame is a smaller fault
// than a notch missing from a page.

const (
	// The grid of points a sample holds.
	notchSampleCols = 32
	notchSampleRows = 18
	// A point changed when its colour moved by more than this, added up over
	// red, green and blue (each 0 to 255). Below it is dither and noise.
	notchPointChanged = 36
	// A sample is moving when at least this share of its points changed. A
	// blinking cursor, a spinner or a small animation stays well under it.
	notchMovingShare = 0.10
	// Moving samples in a row before a video is believed: 3 samples at the
	// 400 ms the watch runs at is 1.2 s.
	notchPlayingRun = 3
	// Still samples in a row before it is over: 12 is 4.8 s, long enough for a
	// quiet shot, short enough that a paused film gets the notch back.
	notchStillRun = 12
	// Input this recent explains a changing picture: scrolling, and what a
	// scroll leaves running after the hand has stopped.
	notchInputGraceMs = 1200
)

// notchVideoWatch turns a run of screen samples into "a video is playing".
type notchVideoWatch struct {
	prev    []uint32
	playing int
	still   int
	video   bool
}

// reset forgets everything. It is called whenever there is no fullscreen app
// to look at, so one app's picture is never compared with the next one's.
func (v *notchVideoWatch) reset() {
	v.prev = v.prev[:0]
	v.playing, v.still, v.video = 0, 0, false
}

// observe takes the next sample, and whether the person touched the mouse or
// keyboard recently, and reports whether a video is playing. A sample is one
// colour per grid point as 0x00RRGGBB. The slice is copied, so the caller may
// reuse it.
func (v *notchVideoWatch) observe(sample []uint32, recentInput bool) bool {
	if len(v.prev) != len(sample) || len(sample) == 0 {
		// The first look: nothing to compare with yet.
		v.prev = append(v.prev[:0], sample...)
		return v.video
	}
	moving := notchSampleChange(v.prev, sample) >= notchMovingShare
	v.prev = append(v.prev[:0], sample...)
	switch {
	case moving && recentInput:
		// Could be scrolling, could be a film with a hand on the mouse. It
		// proves nothing either way, so nothing is counted.
	case moving:
		v.playing++
		v.still = 0
	default:
		v.still++
		v.playing = 0
	}
	if v.playing >= notchPlayingRun {
		v.video = true
	}
	if v.still >= notchStillRun {
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

// notchIsCaptureOverlay reports whether the program in front is a screen
// capture tool choosing its area. While it does, it covers the whole screen
// and is in front, which is exactly what a fullscreen app looks like. The
// names are Windows' own tools, as the desktop app reports a program: the file
// name with or without its ending, in any case.
func notchIsCaptureOverlay(program string) bool {
	name := strings.TrimSuffix(strings.ToLower(program), ".exe")
	return name == "snippingtool" || name == "screenclippinghost"
}
