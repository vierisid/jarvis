package main

import (
	"testing"
	"time"
)

// The sixth run on a real Mac (19 November 2026): the permissions took for the
// first time, and each needed Jarvis to be quit and started by hand before it
// did anything.

func TestPermsNothingToWatchWhenAllIsGivenAtTheStart(t *testing.T) {
	w := newNotchPermWatcher(notchPermState{Accessibility: true, Screen: true})
	if w.needed() {
		t.Fatal("a watch was wanted with everything given")
	}
	if !newNotchPermWatcher(notchPermState{Accessibility: true}).needed() || !newNotchPermWatcher(notchPermState{}).needed() {
		t.Fatal("no watch was wanted with something missing")
	}
}

func TestPermsNoRestartWhileNothingWasGiven(t *testing.T) {
	w := newNotchPermWatcher(notchPermState{})
	at := time.Unix(1000, 0)
	for i := 0; i < 600; i++ {
		if w.seen(notchPermState{}, at.Add(time.Duration(i)*2*time.Second)) {
			t.Fatalf("started again after %d looks with nothing given", i)
		}
	}
	// What it already had at the start is no news either.
	had := newNotchPermWatcher(notchPermState{Accessibility: true})
	if had.seen(notchPermState{Accessibility: true}, at.Add(time.Hour)) {
		t.Fatal("started again for a permission it had from the start")
	}
}

func TestPermsRestartAtOnceWhenBothAreGiven(t *testing.T) {
	w := newNotchPermWatcher(notchPermState{})
	at := time.Unix(1000, 0)
	if w.seen(notchPermState{Accessibility: true}, at) {
		t.Fatal("started again for the first of two, at once")
	}
	if !w.seen(notchPermState{Accessibility: true, Screen: true}, at.Add(6*time.Second)) {
		t.Fatal("did not start again when the second was given")
	}
	// The one that was missing at the start, given: the same.
	one := newNotchPermWatcher(notchPermState{Accessibility: true})
	if !one.seen(notchPermState{Accessibility: true, Screen: true}, at) {
		t.Fatal("did not start again when the only missing one was given")
	}
}

func TestPermsRestartForOneWhenTheOtherDoesNotFollow(t *testing.T) {
	w := newNotchPermWatcher(notchPermState{})
	at := time.Unix(1000, 0)
	w.seen(notchPermState{Accessibility: true}, at)
	if w.seen(notchPermState{Accessibility: true}, at.Add(notchPermSettle-time.Second)) {
		t.Fatal("did not wait for the second")
	}
	if !w.seen(notchPermState{Accessibility: true}, at.Add(notchPermSettle)) {
		t.Fatal("never started again for the one that was given")
	}
}

func TestPermsAReadingThatFailsIsNotAPermissionTakenBack(t *testing.T) {
	w := newNotchPermWatcher(notchPermState{})
	at := time.Unix(1000, 0)
	w.seen(notchPermState{Screen: true}, at)
	// The next look could not read the screen's answer.
	if w.seen(notchPermState{}, at.Add(2*time.Second)) {
		t.Fatal("started again at once")
	}
	if !w.seen(notchPermState{Accessibility: true}, at.Add(4*time.Second)) {
		t.Fatal("the one given before was forgotten: both are given now")
	}
}
