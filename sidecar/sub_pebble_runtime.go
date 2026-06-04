package main

// Cross-platform sub-pebble runtime.
//
// One overlay per background task lives on its own OS-locked goroutine. The
// per-frame work that is platform-independent — eased fly-out toward the slot
// target, the frame ticker, and the spawn/close lifecycle — lives here. Each
// platform supplies only the thin drawing/window primitives via the
// subPebblePlatform contract (mirroring how panels_runtime.go drives the
// per-OS panel adapters). This keeps the rail's motion and lifecycle identical
// across platforms instead of being re-derived inside each native renderer.

import (
	"log"
	"runtime"
	"sync/atomic"
	"time"
)

// subPebbleEntry is the per-overlay state. It is pure Go (atomics + an opaque
// window handle) so it is shared across platforms; the platform adapter owns
// the actual native window referenced by hwnd.
type subPebbleEntry struct {
	id       string
	color    atomic.Value // SubPebbleColor — atomic so Failed can recolor on the fly
	state    atomic.Value // PebbleState
	label    atomic.Value // string  — agent name (always set at spawn; used as bubble header)
	task     atomic.Value // string  — current task line (set lazily by daemon on expand)
	result   atomic.Value // string  — result preview for completed/failed (set on expand)
	elapsedS atomic.Int64 // last-known elapsed seconds for the bubble counter
	expanded atomic.Bool  // bubble visibility
	lastHit  atomic.Int32 // last WM_NCHITTEST resolution (subHitDisc/Button/None)

	// Slot is the logical row on the rail. Mutable so close-induced reflow
	// (Phase C2) can shift the index; paint reads it each frame so the
	// target position updates automatically.
	slot atomic.Int32

	// Animated current position — eases toward the slot's target each frame
	// with pebbleFollowFactor (matches the main pebble's cursor follow).
	// Seeded from the cursor at spawn time so new sub-pebbles "fly out" from
	// where the user summoned them rather than popping in cold. Live render +
	// hit-test both read these atomics so clicks work mid-animation.
	curX atomic.Int32 // window top-left X (px)
	curY atomic.Int32 // window top-left Y (px)

	// Multi-monitor anchor (C3) — right edge of the monitor this sub-pebble
	// was spawned on. Stable for the entry's lifetime so a user dragging the
	// cursor to another monitor doesn't relocate existing sub-pebbles.
	monitorRight atomic.Int32

	hwnd      uintptr
	stopCh    chan struct{}
	doneCh    chan struct{}
	frameTick uint64
}

// subPebblePlatform is the per-OS adapter contract the shared runtime drives.
// Implementations do only native work — create/destroy a layered window, pump
// the platform's message queue, paint the current frame, and report where the
// disc should rest for the entry's slot. The eased motion + lifecycle stay in
// runSubPebbleOverlay.
type subPebblePlatform interface {
	// createOverlayWindow creates the native window for the entry, stores the
	// resulting handle on entry.hwnd, and registers it for input routing.
	createOverlayWindow(entry *subPebbleEntry) error
	// pumpMessages drains the calling thread's native message queue (no-op on
	// platforms whose main loop pumps elsewhere).
	pumpMessages()
	// paint renders the current frame, positioning the window at the entry's
	// already-eased curX/curY.
	paint(entry *subPebbleEntry) error
	// slotPosition returns the window top-left the disc should rest at for the
	// entry's current slot — the easing target.
	slotPosition(entry *subPebbleEntry) (int, int)
	// destroyOverlay unregisters and destroys the entry's native window.
	destroyOverlay(entry *subPebbleEntry)
}

// runSubPebbleOverlay owns one overlay for its lifetime. Locked to its own OS
// thread because native layered windows + drawing contexts are thread-affine.
func runSubPebbleOverlay(entry *subPebbleEntry, p subPebblePlatform) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(entry.doneCh)

	if err := p.createOverlayWindow(entry); err != nil {
		log.Printf("[sub-pebble] createWindow id=%s failed: %v", entry.id, err)
		return
	}
	defer p.destroyOverlay(entry)

	if err := p.paint(entry); err != nil {
		log.Printf("[sub-pebble] initial paint id=%s: %v", entry.id, err)
	}

	frame := time.NewTicker(16 * time.Millisecond)
	defer frame.Stop()

	for {
		select {
		case <-entry.stopCh:
			return
		case <-frame.C:
			p.pumpMessages()
			subPebbleEaseToSlot(entry, p)
			if err := p.paint(entry); err != nil {
				log.Printf("[sub-pebble] paint id=%s: %v", entry.id, err)
			}
		}
	}
}

// subPebbleEaseToSlot advances the overlay's animated position one frame toward
// its slot target, snapping once within half a pixel so it doesn't render
// fractional jitter forever. Shared so every platform's rail settles
// identically with the canonical pebbleFollowFactor.
func subPebbleEaseToSlot(entry *subPebbleEntry, p subPebblePlatform) {
	tx, ty := p.slotPosition(entry)
	cx := float64(entry.curX.Load())
	cy := float64(entry.curY.Load())
	cx += (float64(tx) - cx) * pebbleFollowFactor
	cy += (float64(ty) - cy) * pebbleFollowFactor
	if absDelta(cx-float64(tx)) < 0.5 && absDelta(cy-float64(ty)) < 0.5 {
		cx, cy = float64(tx), float64(ty)
	}
	entry.curX.Store(int32(cx))
	entry.curY.Store(int32(cy))
}

func absDelta(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
