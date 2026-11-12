package main

import "testing"

// notchTestPicture is a sample whose every point depends on n, so two
// different n give two wholly different pictures.
func notchTestPicture(n int) []uint32 {
	out := make([]uint32, notchSampleCols*notchSampleRows)
	for i := range out {
		v := uint32((i*7 + n*97) % 256)
		out[i] = v<<16 | (255-v)<<8 | uint32((i+n*53)%256)
	}
	return out
}

// notchTestNudge changes the given share of a picture's points and leaves the
// rest exactly as they were.
func notchTestNudge(picture []uint32, share float64) []uint32 {
	out := append([]uint32(nil), picture...)
	n := int(float64(len(out)) * share)
	for i := 0; i < n; i++ {
		out[i] ^= 0x00ffffff
	}
	return out
}

func TestNotchVideoIsBelievedAfterThreeMovingSamplesWithHandsOff(t *testing.T) {
	var v notchVideoWatch
	if v.observe(notchTestPicture(0), false) {
		t.Fatal("one look is nothing to compare")
	}
	for i := 1; i < notchPlayingRun; i++ {
		if v.observe(notchTestPicture(i), false) {
			t.Fatalf("believed after %d moving samples, want %d", i, notchPlayingRun)
		}
	}
	if !v.observe(notchTestPicture(notchPlayingRun), false) {
		t.Fatalf("not believed after %d moving samples in a row", notchPlayingRun)
	}
}

// The fault this replaces: a page in a fullscreen browser, being read.
func TestNotchPageBeingReadIsNeverAVideo(t *testing.T) {
	var v notchVideoWatch
	page := notchTestPicture(0)
	for i := 0; i < 200; i++ {
		// A blinking cursor and a spinner: a few points in a hundred.
		look := page
		if i%2 == 1 {
			look = notchTestNudge(page, 0.04)
		}
		if v.observe(look, false) {
			t.Fatalf("a page being read was taken for a video at sample %d", i)
		}
	}
}

// Scrolling changes the whole picture, for as long as the person keeps at it.
// A hand on the mouse explains it, so it is never a video.
func TestNotchScrollingIsNeverAVideo(t *testing.T) {
	var v notchVideoWatch
	for i := 0; i < 100; i++ {
		if v.observe(notchTestPicture(i), true) {
			t.Fatalf("scrolling was taken for a video at sample %d", i)
		}
	}
	// And what a scroll leaves running once the hand is off does not add up
	// to a video either: two moving samples, then the page is still.
	v.observe(notchTestPicture(100), false)
	v.observe(notchTestPicture(101), false)
	still := notchTestPicture(101)
	if v.observe(still, false) {
		t.Fatal("the tail of a scroll was taken for a video")
	}
}

// A hand on the mouse during a film proves nothing either way: it must not
// count towards a video, and it must not undo one.
func TestNotchInputDuringAFilmNeitherCountsNorResets(t *testing.T) {
	var v notchVideoWatch
	v.observe(notchTestPicture(0), false)
	v.observe(notchTestPicture(1), false)
	v.observe(notchTestPicture(2), false)
	if v.observe(notchTestPicture(3), true) {
		t.Fatal("a sample with a hand on the mouse counted towards a video")
	}
	if !v.observe(notchTestPicture(4), false) {
		t.Fatal("the run was lost to one sample with a hand on the mouse")
	}
	for i := 5; i < 60; i++ {
		if !v.observe(notchTestPicture(i), true) {
			t.Fatalf("moving the mouse over a playing film ended it at sample %d", i)
		}
	}
}

func TestNotchVideoEndsOnlyAfterALongStillness(t *testing.T) {
	var v notchVideoWatch
	for i := 0; i <= notchPlayingRun; i++ {
		v.observe(notchTestPicture(i), false)
	}
	frame := notchTestPicture(notchPlayingRun)
	// A quiet shot: still for one sample short of the limit, then moving again.
	for i := 1; i < notchStillRun; i++ {
		if !v.observe(frame, false) {
			t.Fatalf("a quiet shot ended the video after %d still samples, want %d", i, notchStillRun)
		}
	}
	if !v.observe(notchTestPicture(99), false) {
		t.Fatal("the video should still be playing when the picture moves again")
	}
	// Paused: the limit is reached and the notch comes back.
	frame = notchTestPicture(99)
	for i := 1; i < notchStillRun; i++ {
		v.observe(frame, false)
	}
	if v.observe(frame, false) {
		t.Fatalf("a film paused for %d samples should be over", notchStillRun)
	}
}

func TestNotchVideoWatchForgetsOnReset(t *testing.T) {
	var v notchVideoWatch
	for i := 0; i <= notchPlayingRun; i++ {
		v.observe(notchTestPicture(i), false)
	}
	v.reset()
	// The next app's first picture is not compared with the last app's.
	if v.observe(notchTestPicture(50), false) || v.observe(notchTestPicture(51), false) {
		t.Fatal("a reset watch believed a video too early")
	}
}

func TestNotchSampleChangeCountsPointsNotNoise(t *testing.T) {
	a := notchTestPicture(0)
	if got := notchSampleChange(a, a); got != 0 {
		t.Fatalf("a picture differs from itself by %v", got)
	}
	// Every point a little off, as dither and compression leave it: no change.
	noisy := append([]uint32(nil), a...)
	for i := range noisy {
		noisy[i] ^= 0x00030303
	}
	if got := notchSampleChange(a, noisy); got != 0 {
		t.Fatalf("noise counted as change: %v", got)
	}
	if got := notchSampleChange(a, notchTestNudge(a, 0.25)); got < 0.24 || got > 0.26 {
		t.Fatalf("a quarter of the points changed, got %v", got)
	}
	if got := notchSampleChange(a, a[:10]); got != 0 {
		t.Fatalf("pictures of different sizes cannot be compared, got %v", got)
	}
}
