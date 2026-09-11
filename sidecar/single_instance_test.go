package main

import (
	"errors"
	"testing"
	"time"
)

// fakeInstanceLock is held for the first heldFor claims and answers hand-offs
// from call handOffAt onwards (0 = never). Each hand-off costs handOffCost on
// the shared fake clock, like a SendMessageTimeout to a busy instance.
type fakeInstanceLock struct {
	heldFor     int
	handOffAt   int
	handOffCost time.Duration
	err         error
	clock       *time.Time

	acquires int
	handOffs int
	shows    int
}

func (f *fakeInstanceLock) tryAcquire() (bool, error) {
	f.acquires++
	if f.err != nil {
		return false, f.err
	}
	return f.acquires <= f.heldFor, nil
}

func (f *fakeInstanceLock) handOff(show bool) bool {
	f.handOffs++
	if show {
		f.shows++
	}
	*f.clock = f.clock.Add(f.handOffCost)
	return f.handOffAt != 0 && f.handOffs >= f.handOffAt
}

// claim runs claimSingleInstance with a 1s wait and 200ms poll on a fake clock,
// returning the total time it slept.
func claim(lock *fakeInstanceLock, mode instanceHandOff) (start bool, slept time.Duration, err error) {
	clock := time.Unix(0, 0)
	lock.clock = &clock
	start, err = claimSingleInstance(lock, mode, time.Second, 200*time.Millisecond,
		func() time.Time { return clock },
		func(d time.Duration) { slept += d; clock = clock.Add(d) })
	return start, slept, err
}

func TestClaimSingleInstanceStartsWhenFree(t *testing.T) {
	lock := &fakeInstanceLock{}
	start, slept, err := claim(lock, handOffShow)
	if !start || err != nil || slept != 0 {
		t.Fatalf("start=%v err=%v slept=%v, want an immediate start", start, err, slept)
	}
}

func TestClaimSingleInstanceHandsOffToRunningInstance(t *testing.T) {
	lock := &fakeInstanceLock{heldFor: 100, handOffAt: 1}
	start, slept, err := claim(lock, handOffShow)
	if start || err != nil || slept != 0 {
		t.Fatalf("start=%v err=%v slept=%v, want an immediate exit", start, err, slept)
	}
	if lock.shows != 1 {
		t.Fatalf("asked the running instance to show itself %d times, want 1", lock.shows)
	}
	if lock.acquires != 0 {
		t.Fatalf("claimed the lock %d times after a successful hand-off", lock.acquires)
	}
}

// The running instance holds the lock but has no tray window yet.
func TestClaimSingleInstanceHandsOffOnceRunningInstanceIsReady(t *testing.T) {
	lock := &fakeInstanceLock{heldFor: 100, handOffAt: 3}
	start, slept, _ := claim(lock, handOffShow)
	if start || slept != 400*time.Millisecond {
		t.Fatalf("start=%v slept=%v, want an exit after two polls", start, slept)
	}
}

// Quit and relaunch straight away: the old instance still holds the lock but
// refuses the hand-off, and this launch has to take its place.
func TestClaimSingleInstanceWaitsOutAnExitingInstance(t *testing.T) {
	lock := &fakeInstanceLock{heldFor: 3}
	start, slept, err := claim(lock, handOffShow)
	if !start || err != nil || slept != 600*time.Millisecond {
		t.Fatalf("start=%v err=%v slept=%v, want a start after three polls", start, err, slept)
	}
}

// --token: a running instance (including one from before the lock existed,
// which only answers the hand-off) stops the launch, but nothing is opened.
func TestClaimSingleInstanceDetectNeverShows(t *testing.T) {
	lock := &fakeInstanceLock{handOffAt: 1}
	start, _, _ := claim(lock, handOffDetect)
	if start {
		t.Fatal("started alongside an instance that answered")
	}
	if lock.shows != 0 {
		t.Fatalf("asked the running instance to show itself %d times, want 0", lock.shows)
	}
}

func TestClaimSingleInstanceRelaunchNeverHandsOff(t *testing.T) {
	lock := &fakeInstanceLock{heldFor: 2, handOffAt: 1}
	start, _, _ := claim(lock, handOffNever)
	if !start {
		t.Fatal("relaunch exited instead of waiting for the old instance to go")
	}
	if lock.handOffs != 0 {
		t.Fatalf("relaunch handed off %d times to the instance that is exiting", lock.handOffs)
	}
}

func TestClaimSingleInstanceGivesUpAfterWait(t *testing.T) {
	lock := &fakeInstanceLock{heldFor: 100}
	start, slept, err := claim(lock, handOffShow)
	if start || err != nil {
		t.Fatalf("start=%v err=%v, want an exit once the wait runs out", start, err)
	}
	if slept != time.Second {
		t.Fatalf("slept %v before giving up, want exactly the 1s wait", slept)
	}
}

// A hung instance makes every hand-off block until its timeout. The wait is
// wall-clock, so those blocked hand-offs count against it.
func TestClaimSingleInstanceWaitIncludesBlockedHandOffs(t *testing.T) {
	lock := &fakeInstanceLock{heldFor: 100, handOffCost: 2 * time.Second}
	start, slept, _ := claim(lock, handOffShow)
	if start || slept != 0 || lock.handOffs != 1 {
		t.Fatalf("start=%v slept=%v hand-offs=%d, want an exit after the one blocked hand-off",
			start, slept, lock.handOffs)
	}
}

func TestClaimSingleInstanceFailsOpen(t *testing.T) {
	boom := errors.New("boom")
	lock := &fakeInstanceLock{err: boom}
	start, _, err := claim(lock, handOffShow)
	if !start || !errors.Is(err, boom) {
		t.Fatalf("start=%v err=%v, want a start that reports the error", start, err)
	}
}
