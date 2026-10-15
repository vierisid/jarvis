package main

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jarvis/sidecar/internal/update"
)

// #760. #670 contained a panic in register_ack / register_rejected handling on
// the read loop, but the goroutines the updater starts FROM an ack --
// cleanupPrevious, the registry check, and the check's hourly retry -- had no
// recover, so a panic in any of them still ended the process. These call the
// goroutine bodies directly and catch what escapes, so before the fix they FAIL
// with "panic escaped" instead of aborting the test binary the way the
// production goroutine aborts the sidecar.

// escaped runs f and returns whatever panic got out of it.
func escaped(f func()) (r any) {
	defer func() { r = recover() }()
	f()
	return nil
}

// offerWithin is Offer() with a deadline: a recover that left u.mu held makes
// it block forever.
func offerWithin(t *testing.T, u *Updater) UpdateOffer {
	t.Helper()
	got := make(chan UpdateOffer, 1)
	go func() { got <- u.Offer() }()
	select {
	case o := <-got:
		return o
	case <-time.After(2 * time.Second):
		t.Fatal("u.mu is still held after a contained panic: Offer() never returned")
		return UpdateOffer{}
	}
}

// The state a contained panic in the registry lookup leaves: unavailable with
// an error the prompt shows, reported to the brain, and a retry armed -- so a
// later check runs on its own and finds the version once the fault is gone.
func TestUpdaterCheckPanicIsAFailedCheckThatRetries(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.published["0.10.0"] = true
	var panicking atomic.Bool
	panicking.Store(true)
	base := f.resolve
	f.resolve = func(r, v string) (*update.Release, error) {
		if panicking.Load() {
			var rel *update.Release
			_ = rel.Version // nil dereference, the shape of a real fault
		}
		return base(r, v)
	}
	f.checkGen, f.firstGen = 1, 1

	if r := escaped(func() { f.check(1, "0.10.0", false) }); r != nil {
		t.Fatalf("panic escaped check: %v", r)
	}
	o := offerWithin(t, f.Updater)
	want := UpdateState{Phase: updatePhaseUnavailable, Version: "0.10.0", Error: checkPanicError}
	if o.Version != "" || o.State != want {
		t.Fatalf("offer after a contained check panic = %+v, want no version and state %+v", o, want)
	}
	f.mu.Lock()
	emitted, retries := append([]UpdateState(nil), f.emitted...), append([]func(){}, f.retries...)
	f.mu.Unlock()
	if len(emitted) != 1 || emitted[0] != want {
		t.Errorf("brain told %+v, want exactly %+v", emitted, want)
	}
	if len(retries) != 1 {
		t.Fatalf("%d retries armed, want 1", len(retries))
	}

	// The retry is a check like any other: once the fault is gone it confirms
	// the version, so the panic did not leave the updater stuck.
	panicking.Store(false)
	if r := escaped(retries[0]); r != nil {
		t.Fatalf("panic escaped the retry: %v", r)
	}
	if o := offerWithin(t, f.Updater); o.Version != "0.10.0" || o.State.Phase != updatePhaseAvailable {
		t.Fatalf("offer after the retry = %+v, want 0.10.0 available", o)
	}
}

// Each hook announcing a recorded result is contained on its own: an emit that
// panics must not cost a blocked sidecar its prompt or the tray its refresh.
func TestUpdaterCheckHookPanicDoesNotSkipTheOtherHooks(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.published["0.10.0"] = true
	f.emit = func(UpdateState) { panic("emit") }
	var trayRefreshed atomic.Bool
	f.onChange = func(UpdateOffer) { trayRefreshed.Store(true) }
	f.checkGen, f.firstGen, f.blocked = 1, 1, true
	if r := escaped(func() { f.check(1, "0.10.0", false) }); r != nil {
		t.Fatalf("panic escaped check: %v", r)
	}
	if !trayRefreshed.Load() {
		t.Error("the tray was not refreshed after the emit panicked")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.offers) != 1 || !f.offers[0].Blocked || f.offers[0].Version != "0.10.0" {
		t.Fatalf("prompts shown = %+v, want one blocked offer of 0.10.0", f.offers)
	}
}

// A superseded check that panics changes nothing, even with no offer confirmed
// (which would otherwise also make it return early).
func TestUpdaterStaleCheckPanicChangesNothing(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.resolve = func(string, string) (*update.Release, error) { panic("registry") }
	f.checkGen, f.firstGen = 2, 1
	before := offerWithin(t, f.Updater)
	if r := escaped(func() { f.check(1, "0.10.0", false) }); r != nil {
		t.Fatalf("panic escaped check: %v", r)
	}
	if o := offerWithin(t, f.Updater); o != before {
		t.Errorf("offer = %+v, want it unchanged at %+v", o, before)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.emitted) != 0 || len(f.retries) != 0 {
		t.Errorf("a stale check emitted %+v and armed %d retries", f.emitted, len(f.retries))
	}
}

// The progress of an update that is installing is not overwritten by a check
// that panicked, the same rule as the registry-error path.
func TestUpdaterCheckPanicLeavesAnInstallsProgress(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.resolve = func(string, string) (*update.Release, error) { panic("registry") }
	f.checkGen, f.firstGen = 1, 1
	installing := UpdateState{Phase: updatePhaseDownloading, Version: "0.10.0"}
	f.state = installing
	f.applying.Store(true)
	if r := escaped(func() { f.check(1, "0.10.0", false) }); r != nil {
		t.Fatalf("panic escaped check: %v", r)
	}
	if o := offerWithin(t, f.Updater); o.State != installing {
		t.Errorf("state = %+v, want the install's %+v", o.State, installing)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.emitted) != 0 {
		t.Errorf("brain told %+v while an install was reporting its own progress", f.emitted)
	}
}

// A retry that panics stops the timer that fired it and arms exactly one more.
func TestUpdaterRetryPanicRearmsOnce(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.resolve = func(string, string) (*update.Release, error) { panic("registry") }
	f.checkGen, f.firstGen = 1, 1
	var stopped atomic.Int32
	f.cancelRetry = func() { stopped.Add(1) }
	if r := escaped(func() { f.check(1, "0.10.0", true) }); r != nil {
		t.Fatalf("panic escaped the retry: %v", r)
	}
	if n := stopped.Load(); n != 1 {
		t.Errorf("the firing timer was stopped %d times, want 1", n)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.retries) != 1 || f.cancelRetry == nil {
		t.Errorf("%d retries armed (cancel installed: %v), want exactly 1", len(f.retries), f.cancelRetry != nil)
	}
}

// A sidecar the brain refused gets its prompt from a panicked check, as it does
// from a failed one: it cannot work until it is updated.
func TestUpdaterCheckPanicStillPromptsABlockedSidecar(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.resolve = func(string, string) (*update.Release, error) { panic("registry") }
	f.checkGen, f.firstGen, f.blocked = 1, 1, true
	if r := escaped(func() { f.check(1, "0.10.0", false) }); r != nil {
		t.Fatalf("panic escaped check: %v", r)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.offers) != 1 || !f.offers[0].Blocked {
		t.Fatalf("prompts shown = %+v, want one blocked offer", f.offers)
	}
}

// A panic INSIDE check's locked region must not be recovered with u.mu held:
// the tray's Offer() and the next ack's advertise on the read loop would block
// forever. The retry timer panicking while it is armed is the injection.
func TestUpdaterCheckPanicUnderTheLockReleasesIt(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t)) // 0.10.0 not published: the error path arms a retry
	f.schedule = func(time.Duration, func()) func() { panic("timer") }
	f.checkGen, f.firstGen = 1, 1

	if r := escaped(func() { f.check(1, "0.10.0", false) }); r != nil {
		t.Fatalf("panic escaped check: %v", r)
	}
	o := offerWithin(t, f.Updater)
	if o.State.Phase != updatePhaseUnavailable || o.State.Error != checkPanicError {
		t.Fatalf("state = %+v, want unavailable with %q", o.State, checkPanicError)
	}
	// And the next advertisement still gets through, on what is the read loop
	// in production.
	f.schedule = func(time.Duration, func()) func() { return func() {} }
	done := make(chan struct{})
	go func() { f.advertise("0.10.0", false); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("advertise blocked after a contained panic in check")
	}
}

// A panic AFTER the result was recorded -- in a hook telling the UI -- leaves
// the state alone: it is already accurate, and replacing a confirmed offer with
// "check failed" would take away an update that is really there.
func TestUpdaterCheckPanicInAHookKeepsTheResult(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.published["0.10.0"] = true
	f.onChange = func(UpdateOffer) { panic("tray") }
	f.checkGen, f.firstGen = 1, 1

	if r := escaped(func() { f.check(1, "0.10.0", false) }); r != nil {
		t.Fatalf("panic escaped check: %v", r)
	}
	o := offerWithin(t, f.Updater)
	if o.Version != "0.10.0" || o.State != (UpdateState{Phase: updatePhaseAvailable, Version: "0.10.0"}) {
		t.Fatalf("offer = %+v, want the confirmed 0.10.0", o)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.retries) != 0 {
		t.Errorf("a decided check armed %d retries", len(f.retries))
	}
}

// The registry-error path's two exceptions hold for a panic too: an offer an
// earlier check confirmed is kept, and a superseded check changes nothing.
func TestUpdaterCheckPanicKeepsAConfirmedOfferAndIgnoresAStaleCheck(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.published["0.10.0"] = true
	f.checkGen, f.firstGen = 1, 1
	f.check(1, "0.10.0", false)
	before := offerWithin(t, f.Updater)
	if before.Version != "0.10.0" {
		t.Fatalf("setup: offer = %+v", before)
	}
	f.resolve = func(string, string) (*update.Release, error) { panic("registry") }
	for _, gen := range []int{1, 0} { // a reconnect's re-check, then a stale one
		if r := escaped(func() { f.check(gen, "0.10.0", false) }); r != nil {
			t.Fatalf("gen %d: panic escaped check: %v", gen, r)
		}
		if o := offerWithin(t, f.Updater); o != before {
			t.Errorf("gen %d: offer = %+v, want it unchanged at %+v", gen, o, before)
		}
	}
}

// cleanupPrevious falls back to not-cleaned, so the next accepted registration
// tries again to mark a fresh self-update proven. Recorded as done, a marker
// the panic left behind would get a good update rolled back after three starts.
func TestUpdaterCleanupPanicRetriesOnTheNextRegistration(t *testing.T) {
	f := newFakeUpdater(t, "0.10.0", nativeMode(t))
	var calls atomic.Int32
	f.clearPending = func() {
		if calls.Add(1) == 1 {
			panic(errors.New("marker"))
		}
	}
	if r := escaped(f.cleanupPrevious); r != nil {
		t.Fatalf("panic escaped cleanupPrevious: %v", r)
	}
	offerWithin(t, f.Updater) // the lock is free
	if r := escaped(f.cleanupPrevious); r != nil {
		t.Fatalf("panic escaped the second cleanupPrevious: %v", r)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("pending marker cleared %d times, want 2 (the panicking attempt, then the retry)", n)
	}
	// Once it succeeded it is done for this process.
	f.cleanupPrevious()
	if n := calls.Load(); n != 2 {
		t.Errorf("a completed cleanup ran again (%d calls)", n)
	}
}
