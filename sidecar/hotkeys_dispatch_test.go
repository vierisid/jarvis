package main

import (
	"sync"
	"testing"
	"time"
)

// The guarantee #587 asks for: after stop() returns, no callback invocation can
// begin.
//
// This is the pure half of the fix, so it runs on every platform with no
// display and no X server -- which matters, because the cgo halves it protects
// can only be exercised on their own OS.

func TestHotkeyDispatchFiresARegisteredCallback(t *testing.T) {
	var d hotkeyDispatch
	fired := make(chan struct{}, 1)
	id := d.register(func() { fired <- struct{}{} })

	d.dispatch(id)
	select {
	case <-fired:
	case <-time.After(5 * time.Second):
		t.Fatal("a registered hotkey never fired")
	}
}

// The defect itself: a dispatch that starts after invalidate must not call fn.
func TestHotkeyDispatchDoesNotFireAfterInvalidate(t *testing.T) {
	var d hotkeyDispatch
	var mu sync.Mutex
	calls := 0
	id := d.register(func() {
		mu.Lock()
		calls++
		mu.Unlock()
	})

	if inFlight := d.invalidate(id); inFlight != 0 {
		t.Errorf("invalidate reported %d dispatches in flight, want 0", inFlight)
	}

	// Every one of these is a press arriving after stop() returned, which is
	// precisely the window `go fn()` left open.
	for i := 0; i < 50; i++ {
		d.dispatch(id)
	}
	// The goroutines are asynchronous, so give them real time to misbehave
	// rather than declaring victory before they have run. A sleep is honest
	// here: there is nothing to synchronise on, because the correct behaviour
	// is that nothing happens.
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Errorf("the callback ran %d time(s) after invalidate; stop() promised the hotkey was gone", calls)
	}
}

// The race the mutex discipline exists for: claim() and invalidate() must not
// both succeed, whatever the interleaving. A bare atomic flag checked before
// calling fn would pass the test above and still lose this one.
func TestHotkeyDispatchClaimAndInvalidateAreMutuallyExclusive(t *testing.T) {
	for attempt := 0; attempt < 500; attempt++ {
		var d hotkeyDispatch
		id := d.register(func() {})

		var start sync.WaitGroup
		start.Add(1)
		var done sync.WaitGroup
		done.Add(2)

		var claimed bool
		var inFlight int

		go func() {
			defer done.Done()
			start.Wait()
			_, release, ok := d.claim(id)
			claimed = ok
			if ok {
				release()
			}
		}()
		go func() {
			defer done.Done()
			start.Wait()
			inFlight = d.invalidate(id)
		}()

		start.Done()
		done.Wait()

		// Either the claim won (and the invalidation may or may not have seen
		// it still in flight) or the invalidation won and the claim was
		// refused. What must never happen is a refused claim that the
		// invalidation nonetheless counted as in flight, or a successful claim
		// on an entry that was already gone from the map.
		if !claimed && inFlight != 0 {
			t.Fatalf("attempt %d: claim was refused but invalidate counted %d in flight", attempt, inFlight)
		}
	}
}

// invalidate has to report a callback that is genuinely mid-flight, because
// that is the one thing stop() cannot prevent and therefore the one thing it
// has to be able to say out loud.
func TestHotkeyDispatchReportsAnInFlightCallback(t *testing.T) {
	var d hotkeyDispatch
	entered := make(chan struct{})
	finish := make(chan struct{})
	id := d.register(func() {
		close(entered)
		<-finish
	})

	d.dispatch(id)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the callback never started")
	}

	// stop() must NOT block here. If invalidate waited for the in-flight
	// callback, this call would deadlock against `finish` -- which is the
	// deadlock the wait-based fix was rejected for.
	returned := make(chan int, 1)
	go func() { returned <- d.invalidate(id) }()
	select {
	case n := <-returned:
		if n != 1 {
			t.Errorf("invalidate reported %d in flight, want 1", n)
		}
	case <-time.After(5 * time.Second):
		close(finish)
		t.Fatal("invalidate blocked on an in-flight callback; stop() must not wait, or a callback that re-enters the hotkey API deadlocks")
	}
	close(finish)
}

// A callback that calls stop() on its own hotkey is the deadlock that ruled out
// waiting, so it gets a test rather than a promise in a comment.
func TestHotkeyDispatchCallbackMayStopItsOwnHotkey(t *testing.T) {
	var d hotkeyDispatch
	done := make(chan int, 1)
	var id uint64
	id = d.register(func() {
		// Re-entering the API from inside the callback. With a WaitGroup-based
		// stop() this is a guaranteed self-deadlock.
		done <- d.invalidate(id)
	})

	d.dispatch(id)
	select {
	case n := <-done:
		// It counts ITSELF, which is correct and is why the count is
		// diagnostics rather than something to wait on.
		if n != 1 {
			t.Errorf("a callback stopping its own hotkey saw %d in flight, want 1 (itself)", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a callback that stopped its own hotkey deadlocked")
	}
}

func TestHotkeyDispatchInvalidateIsIdempotentAndIdsAreNotReused(t *testing.T) {
	var d hotkeyDispatch
	first := d.register(func() {})
	if n := d.invalidate(first); n != 0 {
		t.Errorf("first invalidate reported %d, want 0", n)
	}
	if n := d.invalidate(first); n != 0 {
		t.Errorf("second invalidate reported %d, want 0 (it must be idempotent, since stop() is wrapped in sync.Once but nothing guarantees only one caller)", n)
	}

	second := d.register(func() {})
	if second == first {
		t.Fatalf("id %d was reused; a late C callback holding a stale id would fire a different hotkey's callback", second)
	}

	// A claim on an unknown id is refused rather than panicking on a nil entry:
	// the C side can fire an id whose Go registration is already gone.
	if _, _, ok := d.claim(first); ok {
		t.Error("claim succeeded for an invalidated id")
	}
	if _, _, ok := d.claim(999999); ok {
		t.Error("claim succeeded for an id that was never registered")
	}
	// And firing one must not panic.
	d.dispatch(first)
	d.dispatch(999999)
	time.Sleep(50 * time.Millisecond)
}

// release() must be safe to call once per claim and must not go negative if a
// backend ever double-releases, because an inFlight that drifts below zero
// would make the diagnostic lie in the other direction.
func TestHotkeyDispatchReleaseIsIdempotentPerClaim(t *testing.T) {
	var d hotkeyDispatch
	id := d.register(func() {})

	_, release, ok := d.claim(id)
	if !ok {
		t.Fatal("claim on a fresh registration was refused")
	}
	release()
	release() // a double release must be absorbed, not counted twice

	if n := d.invalidate(id); n != 0 {
		t.Errorf("invalidate reported %d in flight after the claim was released, want 0", n)
	}
}
