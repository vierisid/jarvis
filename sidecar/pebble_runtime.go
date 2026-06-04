package main

// Cross-platform pebble runtime.
//
// Mirrors panels_runtime.go / sub_pebble_runtime.go: the platform-independent
// per-frame work — cursor-follow easing, the [POINT:..] override state machine,
// the disc-hover follow-freeze, frame ticking, and the spawn/close lifecycle —
// lives here on pebbleCore. Each platform embeds pebbleCore in its service and
// implements the thin pebblePlatform drawing/window primitives. This keeps the
// motion + pointing behaviour identical across renderers instead of being
// re-derived inside each native paint loop.
//
// Adoption status: the Windows renderer drives this runtime. The Linux (GTK)
// and macOS (Cocoa) renderers still run their own native loops and have NOT
// been migrated yet — they keep working as-is and should be ported onto
// pebbleCore + pebblePlatform next (their physics is currently embedded in C/
// Objective-C).

import (
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// pebbleCore is the platform-independent pebble state the shared runtime
// drives. A platform service embeds it (so existing field accesses promote)
// and adds its own native handles/callbacks.
type pebbleCore struct {
	mu         sync.Mutex
	state      atomic.Value // PebbleState
	bubbleText atomic.Value // string — body line; "" means use default per-state copy
	spec       PebbleSpec
	stopCh     chan struct{}
	doneCh     chan struct{}
	spawned    atomic.Bool

	// eyeActive: awareness/OCR is firing. answerOverflowID: non-empty when the
	// speaking bubble should show an "open full ↗" button. blinded: awareness
	// hard-paused (dim + struck-through eye).
	eyeActive        atomic.Bool
	answerOverflowID atomic.Value // string
	blinded          atomic.Bool

	// T8 element pointing — while pointing && now < pointUntilMs the eased
	// target is (pointX,pointY) instead of the cursor; prevState/prevText are
	// restored when the duration elapses.
	pointing     atomic.Bool
	pointX       atomic.Int32
	pointY       atomic.Int32
	pointUntilMs atomic.Int64
	prevState    atomic.Value // PebbleState
	prevText     atomic.Value // string

	// Eased rendered position (float, loop-goroutine local) chasing
	// target = cursor + offset each frame.
	curX float64
	curY float64

	// Window top-left, stored as atomics so the message/UI thread can read it
	// (hit-testing) without racing the frame loop. Written each frame.
	renderedX atomic.Int32
	renderedY atomic.Int32

	// Bottom of the speaking bubble in window-local coords, captured by the
	// renderer; the message thread uses it to place the "open full" button rect.
	lastBubbleY1 atomic.Int32

	// frameTick feeds time-based animations (breathing, waveform, dots).
	frameTick uint64

	// Disc click/hover tracking, shared with the message thread.
	clickDownMs    atomic.Int64
	cursorOnDisc   atomic.Bool // cursor is over the disc → freeze cursor-follow
	cursorOnAnswer atomic.Bool // cursor is over the "open full" button
}

// pebblePlatform is the per-OS adapter contract the shared runtime drives. The
// implementation owns the native window + drawing; the runtime owns motion +
// lifecycle.
type pebblePlatform interface {
	// createWindow creates the native overlay window and stores its handle on
	// the service. Position is seeded from the core's curX/curY.
	createWindow() error
	// pumpMessages drains the platform's message queue.
	pumpMessages()
	// present renders the current frame, positioning the window at the core's
	// already-eased renderedX/renderedY.
	present() error
	// destroyWindow tears the native window down.
	destroyWindow()
}

// advanceFrame steps the pebble one frame: resolves the follow target (cursor,
// or a [POINT:..] override), freezes follow while the cursor is on the disc,
// eases toward it, bumps the frame tick, and publishes the window top-left for
// the message thread. Runs on the frame-loop goroutine only.
func (c *pebbleCore) advanceFrame() {
	cx, cy, err := platformGetCursorPos()
	if err != nil {
		return
	}
	followFactor := pebbleFollowFactor
	tgtX := float64(cx + c.spec.CursorOffsetX)
	tgtY := float64(cy + c.spec.CursorOffsetY)

	// T8 — element-pointing override. Ease to a fixed point (snappier factor)
	// until the duration expires, then restore the prior state + bubble text.
	if c.pointing.Load() {
		if time.Now().UnixMilli() >= c.pointUntilMs.Load() {
			c.pointing.Store(false)
			if ps, ok := c.prevState.Load().(PebbleState); ok {
				c.state.Store(ps)
			}
			if pt, ok := c.prevText.Load().(string); ok {
				c.bubbleText.Store(pt)
			}
		} else {
			tgtX = float64(c.pointX.Load())
			tgtY = float64(c.pointY.Load())
			followFactor = pebblePointFollowFactor
		}
	}

	// Freeze cursor-follow while the cursor sits on the disc so the user can
	// click it without it running away. Re-checked live each frame (once the
	// cursor leaves the window the OS stops sending hit-tests).
	dxDisc := cx - int(c.curX)
	dyDisc := cy - int(c.curY)
	onDisc := dxDisc*dxDisc+dyDisc*dyDisc <= pebbleDiscHitRadius*pebbleDiscHitRadius
	c.cursorOnDisc.Store(onDisc)
	if onDisc {
		followFactor = 0
	}

	c.curX += (tgtX - c.curX) * followFactor
	c.curY += (tgtY - c.curY) * followFactor
	c.frameTick++

	// Window top-left so the disc anchor lands at the eased position.
	c.renderedX.Store(int32(c.curX) - pebbleAnchorX)
	c.renderedY.Store(int32(c.curY) - pebbleAnchorY)
}

// runPebbleLoop owns the overlay for its lifetime on a dedicated OS thread
// (native windows + drawing contexts are thread-affine).
func runPebbleLoop(core *pebbleCore, p pebblePlatform) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(core.doneCh)

	if err := p.createWindow(); err != nil {
		log.Printf("[pebble] createWindow failed: %v", err)
		return
	}
	defer p.destroyWindow()

	// Advance one frame before the first present so renderedX/renderedY hold a
	// real position — otherwise the initial present would place the window at
	// (0,0) for one frame (the old paint loop eased + rendered in one call).
	core.advanceFrame()
	if err := p.present(); err != nil {
		log.Printf("[pebble] initial present: %v", err)
	}

	frame := time.NewTicker(16 * time.Millisecond)
	defer frame.Stop()

	for {
		select {
		case <-core.stopCh:
			return
		case <-frame.C:
			p.pumpMessages()
			core.advanceFrame()
			if err := p.present(); err != nil {
				log.Printf("[pebble] present: %v", err)
			}
		}
	}
}
