package main

import "time"

// When the desktop app starts itself again for a permission, on macOS.
//
// macOS gives a program the Accessibility and the Screen Recording
// permissions only in System Settings, and what was given takes effect when
// the program starts: the keyboard tap, the pointer's watch and the screen's
// picture are all set up once, at the start. So a person who gave both still
// had a Jarvis that could do none of it until they found out that it had to
// be quit and started by hand. The first Mac user's words, on the run where
// the permissions took for the first time (19 November 2026): "we need to do
// it in a way that Jarvis makes you do all of the different requests for
// accessibility and then restarts itself, for Mac at least."
//
// So the app asks for both when it starts without them, watches for the
// answer, and starts itself again when there is nothing left to wait for.
// This file is the deciding, with no platform in it; the asking and the
// watching are in notch_keys_darwin.go.

const (
	// How long one that was given stands alone before the app starts again
	// without the other. Long enough to go on to the second switch in System
	// Settings, short enough that a person who only gives one is not left
	// with a Jarvis that cannot use it.
	notchPermSettle = 40 * time.Second
	// How long the answer is watched for after a start. After that the person
	// has gone on to other things, and the next start looks again.
	notchPermWatchFor = 20 * time.Minute
)

// notchPermState is what macOS allows this program now.
type notchPermState struct {
	Accessibility bool
	Screen        bool
}

func (s notchPermState) all() bool { return s.Accessibility && s.Screen }

// notchPermWatcher follows what has been given since the app started.
type notchPermWatcher struct {
	// What was allowed when the app started: only what came since then is a
	// reason to start again.
	start notchPermState
	last  notchPermState
	// When something was last given. Zero while nothing has been.
	changedAt time.Time
}

func newNotchPermWatcher(start notchPermState) *notchPermWatcher {
	return &notchPermWatcher{start: start, last: start}
}

// needed says whether there is anything to watch for at all.
func (w *notchPermWatcher) needed() bool { return !w.start.all() }

// seen takes the newest answer and says whether to start again now.
//
// A permission never counts as taken back here: one that reads "no" after it
// read "yes" is a reading that failed, not a person who changed their mind in
// the last seconds, and starting again for it would be for nothing.
func (w *notchPermWatcher) seen(now notchPermState, at time.Time) (restart bool) {
	merged := notchPermState{
		Accessibility: w.last.Accessibility || now.Accessibility,
		Screen:        w.last.Screen || now.Screen,
	}
	if merged != w.last {
		w.last = merged
		w.changedAt = at
	}
	if w.changedAt.IsZero() {
		return false
	}
	// Everything is given: nothing more to wait for.
	if w.last.all() {
		return true
	}
	// One is given and the other has not followed.
	return at.Sub(w.changedAt) >= notchPermSettle
}
