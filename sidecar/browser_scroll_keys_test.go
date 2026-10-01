package main

// #603 - the keys that scroll retire the coordinate map, and the keys that do
// not must not. The set is duplicated by hand in
// src/actions/browser/session.ts, so it is spelled out here rather than derived
// from the function under test.

import "testing"

func TestScrollsThePageCoversTheKeysThatMoveTheViewport(t *testing.T) {
	for _, key := range []string{"PageDown", "PageUp", "Home", "End"} {
		if !scrollsThePage(key) {
			t.Fatalf("%s moves the viewport, so it must retire the ids", key)
		}
	}
	// NOT these. A model works through a list it has already snapshotted with
	// Enter and the arrows, so retiring the ids there would break "press
	// Enter, then click [5]" for the sake of a cosmetic pointer -- and Space
	// types a space whenever a field has focus.
	for _, key := range []string{"Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space", "a", "F5"} {
		if scrollsThePage(key) {
			t.Fatalf("%s must not retire the ids", key)
		}
	}
}

// TestRetiredIDsNoticeIsOneSentence: browser_scroll and browser_press_key both
// hand it to the model, and the daemon's half must word it identically (the
// parity integration test compares the scroll reply byte for byte).
func TestRetiredIDsNoticeIsOneSentence(t *testing.T) {
	const want = "Element ids from the previous snapshot no longer apply " +
		"-- take a browser_snapshot before acting on one."
	if retiredIDsNotice != want {
		t.Fatalf("the notice changed; update RETIRED_IDS_NOTICE in src/actions/browser/session.ts too:\n%q", retiredIDsNotice)
	}
}
