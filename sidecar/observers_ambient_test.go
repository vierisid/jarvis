package main

import (
	"sync"
	"testing"
	"time"
)

// Timing budgets are deliberately loose: these tests assert ordering around a
// deadline, not the precision of the sleep. tick is the unit a hold is
// expressed in, and settle is how long a test waits to be sure a deadline has
// passed. A loaded -race run can preempt a goroutine for tens of milliseconds,
// so anything tighter is flaky for no extra coverage.
const (
	ambientTestTick   = 300 * time.Millisecond
	ambientTestSettle = 900 * time.Millisecond
)

// resetAmbient puts the package-level suppression state back to "not
// suppressed" so each test starts clean (these are process globals).
func resetAmbient(t *testing.T) {
	t.Helper()
	clear := func() {
		ambientMu.Lock()
		ambientDepth = 0
		ambientHoldUntil = time.Time{}
		ambientHoldSeq = 0
		ambientMu.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

func TestAmbientHoldCounterNests(t *testing.T) {
	resetAmbient(t)

	if ambientSuppressedNow() {
		t.Fatal("expected not suppressed at rest")
	}
	ambientHold()
	ambientHold()
	if !ambientSuppressedNow() {
		t.Fatal("expected suppressed while two holds are outstanding")
	}
	ambientRelease()
	if !ambientSuppressedNow() {
		t.Fatal("expected still suppressed, one hold is still outstanding")
	}
	ambientRelease()
	if ambientSuppressedNow() {
		t.Fatal("expected released once every hold is released")
	}
}

// An unbalanced release must not drive the counter negative: a later, correctly
// paired hold/release would otherwise leave suppression stuck on forever.
func TestAmbientReleaseClampsAtZero(t *testing.T) {
	resetAmbient(t)

	ambientRelease()
	ambientRelease()
	ambientHold()
	if !ambientSuppressedNow() {
		t.Fatal("expected suppressed after a hold following unbalanced releases")
	}
	ambientRelease()
	if ambientSuppressedNow() {
		t.Fatal("expected released")
	}
}

func TestAmbientHoldForSuppressesUntilDeadline(t *testing.T) {
	resetAmbient(t)

	ambientHoldFor(ambientTestTick)
	if !ambientSuppressedNow() {
		t.Fatal("expected suppressed immediately after a deadline hold")
	}
	time.Sleep(ambientTestSettle)
	if ambientSuppressedNow() {
		t.Fatal("expected the deadline hold to expire on its own")
	}
}

// A short hold must never cut a longer one short: this is what keeps a
// per-clip refresh from shrinking the turn-length hold.
func TestAmbientHoldForOnlyMovesForward(t *testing.T) {
	resetAmbient(t)

	ambientHoldFor(10 * time.Second)
	long := ambientDeadlineForTest()
	ambientHoldFor(time.Millisecond)
	if got := ambientDeadlineForTest(); !got.Equal(long) {
		t.Fatalf("deadline moved backward: got %v, want %v", got, long)
	}
	ambientHoldFor(30 * time.Second)
	if !ambientDeadlineForTest().After(long) {
		t.Fatal("expected a longer hold to push the deadline forward")
	}
}

// ambientEndHoldAfter is the mirror image: it releases early but must never
// extend a hold that is already shorter than the tail.
func TestAmbientEndHoldAfterOnlyMovesBackward(t *testing.T) {
	resetAmbient(t)

	seq := ambientHoldFor(10 * time.Second)
	ambientEndHoldAfter(seq, ambientTestTick)
	if !ambientSuppressedNow() {
		t.Fatal("expected still suppressed during the tail")
	}
	time.Sleep(ambientTestSettle)
	if ambientSuppressedNow() {
		t.Fatal("expected the shortened hold to have expired")
	}

	// Already expired: a tail must not resurrect suppression.
	before := ambientDeadlineForTest()
	ambientEndHoldAfter(ambientHoldSeqForTest(), 10*time.Second)
	if got := ambientDeadlineForTest(); !got.Equal(before) {
		t.Fatalf("tail extended an expired hold: got %v, want %v", got, before)
	}
	if ambientSuppressedNow() {
		t.Fatal("expected still released")
	}
}

// The end event for a turn can land seconds late (the playback worker debounces
// its idle announcement). By then a new turn may have taken a hold, and the
// stale end must not cut it short. This is the mic-capture-underrun bug: the
// user dismisses mid-answer and immediately asks something else, and the late
// "stopped speaking" from the first answer un-suppresses the second turn's
// listening phase.
func TestAmbientStaleEndCannotShortenANewerHold(t *testing.T) {
	resetAmbient(t)

	stale := ambientHoldFor(time.Second) // turn 1: playback started
	ambientHoldFor(10 * time.Second)     // turn 2: a new summon took a hold
	fresh := ambientDeadlineForTest()

	ambientEndHoldAfter(stale, time.Millisecond) // turn 1's late "stopped speaking"

	if got := ambientDeadlineForTest(); !got.Equal(fresh) {
		t.Fatalf("a stale end shortened a newer hold: got %v, want %v", got, fresh)
	}
	if !ambientSuppressedNow() {
		t.Fatal("expected the newer turn to still be suppressed")
	}
}

// The unscoped end is for the daemon telling us the turn is over, which is
// authoritative and has no hold of its own to pair with.
func TestAmbientUnscopedEndAlwaysApplies(t *testing.T) {
	resetAmbient(t)

	ambientHoldFor(10 * time.Second)
	ambientHoldFor(10 * time.Second)
	ambientEndHoldAfter(ambientHoldUnscoped, ambientTestTick)
	time.Sleep(ambientTestSettle)
	if ambientSuppressedNow() {
		t.Fatal("expected the unscoped end to have released the hold")
	}
}

// The realtime session (counter) and the one-shot voice cycle (deadline) can
// overlap; neither may end the other's suppression.
func TestAmbientCounterAndDeadlineAreIndependent(t *testing.T) {
	resetAmbient(t)

	ambientHold() // realtime session
	seq := ambientHoldFor(ambientTestTick)
	ambientEndHoldAfter(seq, 0) // voice cycle finished
	time.Sleep(ambientTestSettle)
	if !ambientSuppressedNow() {
		t.Fatal("deadline expiry must not release the realtime session's hold")
	}
	ambientRelease()
	if ambientSuppressedNow() {
		t.Fatal("expected released once both holds are gone")
	}
}

func TestAmbientHoldIsRaceFree(t *testing.T) {
	resetAmbient(t)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				ambientHold()
				seq := ambientHoldFor(time.Millisecond)
				_ = ambientSuppressedNow()
				ambientEndHoldAfter(seq, time.Millisecond)
				ambientRelease()
			}
		}()
	}
	wg.Wait()

	ambientMu.Lock()
	depth := ambientDepth
	ambientMu.Unlock()
	if depth != 0 {
		t.Fatalf("depth = %d, want 0 after balanced concurrent holds", depth)
	}
}

func ambientDeadlineForTest() time.Time {
	ambientMu.Lock()
	defer ambientMu.Unlock()
	return ambientHoldUntil
}

func ambientHoldSeqForTest() uint64 {
	ambientMu.Lock()
	defer ambientMu.Unlock()
	return ambientHoldSeq
}
