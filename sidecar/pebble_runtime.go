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
	"fmt"
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

	// Ethereal mode (live-set from settings via SetEthereal): when enabled the
	// pebble fades out after staying idle past etherealIdleMs and pops back in
	// when it next leaves idle. etherealAlpha is the animated window opacity
	// (0..1); it's loop-goroutine local (advanceFrame writes it, present reads
	// it — same goroutine), so it needs no atomic.
	etherealEnabled atomic.Bool
	etherealIdleMs  atomic.Int64 // idle timeout before fade-out
	idleSinceMs     atomic.Int64 // ms when the pebble last entered idle (0 = active)
	etherealAlpha   float64
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
	// The transition is serialized with PointAt under c.mu: previously an
	// expiry-flip here could interleave with an arm there, dropping a point
	// issued the same frame a prior point expired (or restoring stale state over
	// the fresh one). Only locks when actually pointing, so the common path is
	// untouched.
	if c.pointing.Load() {
		c.mu.Lock()
		if c.pointing.Load() { // re-check under lock
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
		c.mu.Unlock()
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

	c.advanceEthereal()
}

// Ethereal-mode animation tuning. The fade-out is slow and gentle; the pop-in
// is much faster so reappearing reads as a deliberate, "stronger" entrance.
const (
	pebbleEtherealFadeOut        = 0.06 // per-frame ease toward hidden (~0.7s)
	pebbleEtherealFadeIn         = 0.40 // per-frame ease toward visible (snappy)
	pebbleEtherealDefaultIdleSec = 5
)

// SetEthereal enables/disables ethereal mode and sets the idle timeout before
// fade-out. Safe before Spawn and from any goroutine (atomic stores).
func (c *pebbleCore) SetEthereal(enabled bool, idleSeconds int) {
	if idleSeconds <= 0 {
		idleSeconds = pebbleEtherealDefaultIdleSec
	}
	c.etherealIdleMs.Store(int64(idleSeconds) * 1000)
	c.etherealEnabled.Store(enabled)
}

// EtherealAlpha returns the current ethereal window opacity (0..1). Read by the
// renderers in present(); runs on the same goroutine as advanceFrame.
func (c *pebbleCore) EtherealAlpha() float64 { return c.etherealAlpha }

// advanceEthereal updates etherealAlpha for the current frame. When ethereal is
// enabled and the pebble has stayed idle past the configured timeout, it eases
// the opacity toward 0 (gentle fade-out); the moment it leaves idle it eases
// back toward 1 with a faster factor (the "stronger" pop-in). When ethereal is
// off, opacity is held at 1. Runs on the frame-loop goroutine.
func (c *pebbleCore) advanceEthereal() {
	st, _ := c.state.Load().(PebbleState)
	now := time.Now().UnixMilli()
	if st == PebbleIdle {
		if c.idleSinceMs.Load() == 0 {
			c.idleSinceMs.Store(now)
		}
	} else {
		c.idleSinceMs.Store(0)
	}

	hidden := false
	if c.etherealEnabled.Load() && st == PebbleIdle {
		if since := c.idleSinceMs.Load(); since != 0 && now-since >= c.etherealIdleMs.Load() {
			hidden = true
		}
	}

	target, ease := 1.0, pebbleEtherealFadeIn
	if hidden {
		target, ease = 0.0, pebbleEtherealFadeOut
	}
	c.etherealAlpha += (target - c.etherealAlpha) * ease
	// Snap the tails so we settle cleanly instead of crawling / ghosting.
	if c.etherealAlpha < 0.003 {
		c.etherealAlpha = 0
	} else if c.etherealAlpha > 0.997 {
		c.etherealAlpha = 1
	}
}

// ─── Shared state mutators ───────────────────────────────────────────────────
// These only touch pebbleCore, so they live here and are promoted to every
// platform service that embeds pebbleCore (Windows, and Linux/macOS once
// migrated). advanceFrame() + present() pick the new state up on the next frame.

// SetState transitions the visible state.
func (c *pebbleCore) SetState(state PebbleState) error {
	if !c.spawned.Load() {
		return fmt.Errorf("pebble not spawned")
	}
	c.state.Store(state)
	return nil
}

// SetText sets the bubble body line ("" falls back to the per-state placeholder).
func (c *pebbleCore) SetText(text string) error { c.bubbleText.Store(text); return nil }

// SetEye toggles the awareness/OCR eye glyph.
func (c *pebbleCore) SetEye(active bool) error { c.eyeActive.Store(active); return nil }

// SetBlinded marks awareness hard-paused (dim + struck-through eye).
func (c *pebbleCore) SetBlinded(blinded bool) error { c.blinded.Store(blinded); return nil }

// SetAnswerOverflow arms ("" disarms) the speaking bubble's "open full" button.
func (c *pebbleCore) SetAnswerOverflow(answerID string) error {
	c.answerOverflowID.Store(answerID)
	return nil
}

// PointAt flies the pebble to a fixed screen point for durationMs, showing
// label, then restores the prior state/text (handled by advanceFrame).
func (c *pebbleCore) PointAt(x, y int, label string, durationMs int) error {
	if !c.spawned.Load() {
		return fmt.Errorf("pebble not spawned")
	}
	if durationMs <= 0 {
		durationMs = 3000
	}
	// Snapshot the pre-point state ONLY on the first point of a run, so
	// re-entrant points (multiple LLM tags) restore the original, not an
	// intermediate "speaking + label" state. Held under c.mu so the whole
	// snapshot+arm is atomic against advanceFrame's expiry-restore.
	c.mu.Lock()
	if c.pointing.CompareAndSwap(false, true) {
		ps, _ := c.state.Load().(PebbleState)
		pt, _ := c.bubbleText.Load().(string)
		c.prevState.Store(ps)
		c.prevText.Store(pt)
	}
	c.pointX.Store(int32(x))
	c.pointY.Store(int32(y))
	c.pointUntilMs.Store(time.Now().Add(time.Duration(durationMs) * time.Millisecond).UnixMilli())
	c.state.Store(PebbleListening)
	c.bubbleText.Store(label)
	c.mu.Unlock()
	return nil
}

// pebbleStateToInt maps a PebbleState to the small int the native C/Obj-C
// renderers use (0=idle, 1=listening, 2=thinking, 3=speaking, 4=working).
func pebbleStateToInt(s PebbleState) int {
	switch s {
	case PebbleListening:
		return 1
	case PebbleThinking:
		return 2
	case PebbleSpeaking:
		return 3
	case PebbleWorking:
		return 4
	case PebbleAsking:
		return 5
	case PebbleDone:
		return 6
	case PebbleMuted:
		return 7
	default:
		return 0
	}
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

	// Start fully visible (etherealAlpha's zero value is 0 = invisible).
	core.etherealAlpha = 1.0

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
