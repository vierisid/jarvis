package main

import "testing"

func TestDefaultPebbleBodyText(t *testing.T) {
	cases := map[PebbleState]string{
		PebbleListening: "listening — go ahead.",
		PebbleSpeaking:  "speaking…",
		PebbleIdle:      "",
		PebbleThinking:  "",
		PebbleWorking:   "",
	}
	for state, want := range cases {
		if got := defaultPebbleBodyText(state); got != want {
			t.Errorf("defaultPebbleBodyText(%q) = %q, want %q", state, got, want)
		}
	}
}

func TestPebbleEasingConstantsOrdered(t *testing.T) {
	// The point-follow ease must be snappier than the cursor-follow ease, or
	// the pebble would lag MORE while flying to a target than while trailing
	// the cursor — the opposite of the intended "snap to target" feel.
	if !(pebblePointFollowFactor > pebbleFollowFactor) {
		t.Errorf("point ease %v should exceed cursor ease %v", pebblePointFollowFactor, pebbleFollowFactor)
	}
	if pebbleFollowFactor <= 0 || pebbleFollowFactor >= 1 {
		t.Errorf("cursor ease %v should be in (0,1)", pebbleFollowFactor)
	}
}
