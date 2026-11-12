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

// The looks the tests are built from.
var (
	// A film: hand off the mouse, the player has hidden the pointer, sound on.
	notchLookFilm = notchVideoSigns{handsOff: true, pointerHidden: true, appSound: true, change: 0.4}
	// A page in a fullscreen browser, being read: the pointer is in plain view.
	notchLookReading = notchVideoSigns{handsOff: true}
	// The same while the hand scrolls.
	notchLookScrolling = notchVideoSigns{change: 0.9}
)

func notchTestLooks(v *notchVideoWatch, look notchVideoSigns, n int) bool {
	video := false
	for i := 0; i < n; i++ {
		video = v.observe(look)
	}
	return video
}

func TestNotchFilmIsBelievedAfterTwoLooks(t *testing.T) {
	var v notchVideoWatch
	if v.observe(notchLookFilm) {
		t.Fatalf("believed after one look, want %d", notchPlayingRun)
	}
	if !v.observe(notchLookFilm) {
		t.Fatalf("not believed after %d looks at a playing film", notchPlayingRun)
	}
}

// The fault that started this: a page in a fullscreen browser, being read,
// lost the notch. Whatever else is true, a pointer in plain view keeps it.
func TestNotchPageBeingReadKeepsTheNotch(t *testing.T) {
	for name, look := range map[string]notchVideoSigns{
		"a quiet page":                             notchLookReading,
		"music playing in another tab":             {handsOff: true, appSound: true},
		"a page that keeps changing by itself":     {handsOff: true, change: 0.3},
		"music and a page that keeps changing":     {handsOff: true, appSound: true, change: 0.3},
		"scrolling":                                notchLookScrolling,
		"scrolling with music":                     {appSound: true, change: 0.9},
		"typing, which hides the pointer":          {pointerHidden: true, appSound: true, change: 0.02},
		"a pause in typing in a fullscreen editor": {handsOff: true, pointerHidden: true, change: 0.005},
	} {
		var v notchVideoWatch
		if notchTestLooks(&v, look, 300) {
			t.Errorf("%s was taken for a video", name)
		}
	}
}

// Much of what people watch barely moves. Sound says it is playing.
func TestNotchVideoThatDoesNotMoveIsBelievedByItsSound(t *testing.T) {
	var v notchVideoWatch
	lecture := notchVideoSigns{handsOff: true, pointerHidden: true, appSound: true}
	if !notchTestLooks(&v, lecture, notchPlayingRun) {
		t.Fatal("a lecture on one slide, with its sound, should be a video")
	}
}

// A muted video has only its picture, and calm footage moves now and then:
// measured, about one look in six. Movement is remembered for a few looks.
func TestNotchMutedVideoIsBelievedByItsPicture(t *testing.T) {
	var v notchVideoWatch
	still := notchVideoSigns{handsOff: true, pointerHidden: true}
	moving := notchVideoSigns{handsOff: true, pointerHidden: true, change: 0.03}
	if notchTestLooks(&v, still, 20) {
		t.Fatal("a muted picture that never moves is not known to be a video")
	}
	v.observe(moving)
	if !v.observe(still) {
		t.Fatal("movement one look ago should still count")
	}
	// It keeps being believed across the quiet stretches between movements.
	for i := 0; i < 60; i++ {
		look := still
		if i%6 == 0 {
			look = moving
		}
		if !v.observe(look) {
			t.Fatalf("a calm muted video was dropped at look %d", i)
		}
	}
}

// Scrolling moves the whole picture. If that were remembered, the pause after
// a scroll in an app that hides the pointer while typing would read as a film.
func TestNotchMovementWithAHandOnTheMouseIsNotRemembered(t *testing.T) {
	var v notchVideoWatch
	notchTestLooks(&v, notchVideoSigns{pointerHidden: true, change: 0.9}, 10)
	if notchTestLooks(&v, notchVideoSigns{handsOff: true, pointerHidden: true}, 30) {
		t.Fatal("movement made by the hand was taken for a video's")
	}
}

// A nudge of the mouse brings the player's controls and the pointer back for
// about three seconds. That must not bring the notch back.
func TestNotchStaysHiddenThroughANudgeOfTheMouse(t *testing.T) {
	var v notchVideoWatch
	notchTestLooks(&v, notchLookFilm, notchPlayingRun)
	nudge := notchVideoSigns{appSound: true, change: 0.4} // hand on, pointer shown
	shown := notchVideoSigns{handsOff: true, appSound: true, change: 0.4}
	for i := 0; i < 3; i++ {
		if !v.observe(nudge) {
			t.Fatal("a nudge of the mouse ended the video")
		}
	}
	for i := 0; i < notchStillRun-4; i++ {
		if !v.observe(shown) {
			t.Fatalf("the video ended while the player still showed the pointer, look %d", i)
		}
	}
	if !v.observe(notchLookFilm) {
		t.Fatal("the video should carry on once the pointer hides again")
	}
}

// A paused film keeps its pointer in view. After a while the notch returns.
func TestNotchReturnsWhenTheFilmIsPaused(t *testing.T) {
	var v notchVideoWatch
	notchTestLooks(&v, notchLookFilm, notchPlayingRun)
	paused := notchVideoSigns{handsOff: true}
	if !notchTestLooks(&v, paused, notchStillRun-1) {
		t.Fatalf("the notch returned before %d looks", notchStillRun)
	}
	if v.observe(paused) {
		t.Fatalf("a film paused for %d looks should be over", notchStillRun)
	}
}

// With the pointer on another display it says nothing, so both other signs
// are asked for.
func TestNotchPointerOnAnotherDisplayNeedsSoundAndMovement(t *testing.T) {
	for name, c := range map[string]struct {
		look notchVideoSigns
		want bool
	}{
		"sound only":         {notchVideoSigns{handsOff: true, pointerElsewhere: true, appSound: true}, false},
		"movement only":      {notchVideoSigns{handsOff: true, pointerElsewhere: true, change: 0.4}, false},
		"sound and movement": {notchVideoSigns{handsOff: true, pointerElsewhere: true, appSound: true, change: 0.4}, true},
	} {
		var v notchVideoWatch
		if got := notchTestLooks(&v, c.look, 20); got != c.want {
			t.Errorf("%s: video=%v, want %v", name, got, c.want)
		}
	}
}

func TestNotchVideoWatchForgetsOnReset(t *testing.T) {
	var v notchVideoWatch
	notchTestLooks(&v, notchLookFilm, notchPlayingRun)
	v.change(notchTestPicture(1))
	v.reset()
	if v.observe(notchLookFilm) {
		t.Fatal("a reset watch believed a video after one look")
	}
	// The next app's first picture is not compared with the last app's.
	if got := v.change(notchTestPicture(2)); got != 0 {
		t.Fatalf("the first picture after a reset changed by %v", got)
	}
}

func TestNotchPictureChangeIsMeasuredAgainstTheLastLook(t *testing.T) {
	var v notchVideoWatch
	picture := notchTestPicture(0)
	if got := v.change(picture); got != 0 {
		t.Fatalf("the first picture has nothing to differ from, got %v", got)
	}
	// The caller may reuse its slice: the watch must have kept its own copy.
	nudged := notchTestNudge(picture, 0.25)
	copy(picture, nudged)
	if got := v.change(picture); got < 0.24 || got > 0.26 {
		t.Fatalf("a quarter of the points changed, got %v", got)
	}
	if got := v.change(picture); got != 0 {
		t.Fatalf("the same picture again changed by %v", got)
	}
}

func TestNotchAppPlaysSoundMatchesByProgramName(t *testing.T) {
	playing := []string{"chrome", "spotify"}
	for program, want := range map[string]bool{
		"chrome":     true,
		"Chrome.exe": true,
		"Spotify":    true,
		"winword":    false,
		"":           false,
		// A Store app's window belongs to a host that plays nothing itself.
		"ApplicationFrameHost": true,
	} {
		if got := notchAppPlaysSound(program, playing); got != want {
			t.Errorf("%q with %v playing: %v, want %v", program, playing, got, want)
		}
	}
	if notchAppPlaysSound("chrome", nil) || notchAppPlaysSound("ApplicationFrameHost", nil) {
		t.Fatal("nothing is playing, so no app is")
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
