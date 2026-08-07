package main

// MicGate — the single authority over whether the always-on wake listener's
// microphone capture may run.
//
// Why this exists: before P0.3 the pebble "blind" toggle stopped SCREEN
// awareness only. The wake listener kept capturing the mic and shipping every
// VAD-detected speech segment to the daemon for STT, so a user who blinded
// JARVIS was still being transcribed. Blinding now means deaf as well as
// blind.
//
// The gate is needed because of a lifetime mismatch: the RPC handler registry
// (which owns `pebble.set_blinded`) is built once when the client is
// constructed, while the WakeListenerService is built fresh inside every
// connectAndServe. The gate is a stable object both sides can hold. It also
// remembers the blinded state across reconnects, so a listener that attaches
// while blinded comes up muted rather than opening the mic for the gap
// between attach and the daemon's next set_blinded push.
//
// Not covered by the gate, deliberately: Ctrl+Space push-to-talk and the
// realtime voice session. Both are explicit, user-initiated captures — the
// user pressing a key IS the consent. Only the passive, always-on stream is
// gated here.

import (
	"context"
	"log"
	"sync"
)

type MicGate struct {
	mu       sync.Mutex
	blinded  bool
	listener *WakeListenerService
	// ctx is the connection context the attached listener was started with;
	// used to reopen the device on unmute.
	ctx context.Context
}

func NewMicGate() *MicGate {
	return &MicGate{ctx: context.Background()}
}

// Attach binds a freshly started wake listener to the gate and immediately
// applies the remembered blinded state. Call once per connection, right after
// WakeListenerService.Start succeeds.
func (g *MicGate) Attach(ctx context.Context, listener *WakeListenerService) {
	g.mu.Lock()
	g.listener = listener
	g.ctx = ctx
	blinded := g.blinded
	g.mu.Unlock()

	if listener != nil {
		listener.SetMuted(ctx, blinded)
		if blinded {
			log.Printf("[mic-gate] wake listener attached while blinded — mic stays closed")
		}
	}
}

// Detach unbinds the listener (connection teardown). The blinded flag is kept
// so the next connection's listener attaches in the same state.
func (g *MicGate) Detach() {
	g.mu.Lock()
	g.listener = nil
	g.mu.Unlock()
}

// SetBlinded records the blinded state and pushes it to the attached listener.
// Blinded == true means the passive mic stream is off.
func (g *MicGate) SetBlinded(blinded bool) {
	g.mu.Lock()
	g.blinded = blinded
	listener := g.listener
	ctx := g.ctx
	g.mu.Unlock()

	if listener == nil {
		log.Printf("[mic-gate] blinded=%v recorded (no wake listener attached yet)", blinded)
		return
	}
	listener.SetMuted(ctx, blinded)
	log.Printf("[mic-gate] blinded=%v applied to wake listener (mic %s)", blinded,
		map[bool]string{true: "closed", false: "open"}[blinded])
}

// Blinded reports the current state. Exposed for the set_blinded RPC result so
// the daemon can confirm what the sidecar actually applied.
func (g *MicGate) Blinded() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.blinded
}
