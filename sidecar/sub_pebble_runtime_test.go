package main

import "testing"

// fakeSubPebblePlatform is a no-op subPebblePlatform with a fixed slot target,
// used to exercise the shared easing without a real native window.
type fakeSubPebblePlatform struct{ tx, ty int }

func (f *fakeSubPebblePlatform) createOverlayWindow(*subPebbleEntry) error { return nil }
func (f *fakeSubPebblePlatform) pumpMessages()                             {}
func (f *fakeSubPebblePlatform) paint(*subPebbleEntry) error               { return nil }
func (f *fakeSubPebblePlatform) slotPosition(*subPebbleEntry) (int, int)   { return f.tx, f.ty }
func (f *fakeSubPebblePlatform) destroyOverlay(*subPebbleEntry)            {}

func TestSubPebbleEaseToSlotMovesTowardTarget(t *testing.T) {
	entry := &subPebbleEntry{} // curX/curY start at 0
	p := &fakeSubPebblePlatform{tx: 1000, ty: 500}

	subPebbleEaseToSlot(entry, p)
	// First frame eases by the canonical follow factor toward the target.
	if got, want := entry.curX.Load(), int32(1000*pebbleFollowFactor); got != want {
		t.Errorf("curX after one step = %d, want %d", got, want)
	}
	if got, want := entry.curY.Load(), int32(500*pebbleFollowFactor); got != want {
		t.Errorf("curY after one step = %d, want %d", got, want)
	}

	// Subsequent frames keep advancing toward the target (never away).
	beforeX, beforeY := entry.curX.Load(), entry.curY.Load()
	subPebbleEaseToSlot(entry, p)
	if entry.curX.Load() <= beforeX || entry.curY.Load() <= beforeY {
		t.Errorf("second step did not advance toward target: (%d,%d) -> (%d,%d)",
			beforeX, beforeY, entry.curX.Load(), entry.curY.Load())
	}
}

func TestSubPebbleEaseToSlotSnapsWhenAtTarget(t *testing.T) {
	entry := &subPebbleEntry{}
	entry.curX.Store(300)
	entry.curY.Store(400)
	p := &fakeSubPebblePlatform{tx: 300, ty: 400}
	subPebbleEaseToSlot(entry, p)
	if entry.curX.Load() != 300 || entry.curY.Load() != 400 {
		t.Errorf("already-at-target drifted to (%d,%d)", entry.curX.Load(), entry.curY.Load())
	}
}
