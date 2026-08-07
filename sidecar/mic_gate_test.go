package main

import (
	"context"
	"testing"
)

// TestMicGateRemembersBlindedBeforeAttach — the daemon can push set_blinded
// before any wake listener exists (client construction happens before
// connectAndServe). The gate must remember the state so the listener attaches
// muted rather than opening the mic.
func TestMicGateRemembersBlindedBeforeAttach(t *testing.T) {
	g := NewMicGate()
	g.SetBlinded(true) // no listener attached yet — must not panic

	if !g.Blinded() {
		t.Fatalf("Blinded() = false, want true")
	}

	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	g.Attach(context.Background(), w)

	if !w.Muted() {
		t.Fatalf("listener attached while blinded but Muted() = false")
	}
}

// TestMicGateTogglesListener — the round trip the blind toggle actually drives.
func TestMicGateTogglesListener(t *testing.T) {
	g := NewMicGate()
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	g.Attach(context.Background(), w)

	if w.Muted() {
		t.Fatalf("listener muted before any blind toggle")
	}

	g.SetBlinded(true)
	if !w.Muted() {
		t.Fatalf("blinded=true did not mute the wake listener")
	}

	g.SetBlinded(false)
	if w.Muted() {
		t.Fatalf("blinded=false did not unmute the wake listener")
	}
}

// TestMicGateDetachKeepsState — a reconnect drops the listener but must not
// reset the privacy state; the next listener attaches muted.
func TestMicGateDetachKeepsState(t *testing.T) {
	g := NewMicGate()
	first := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	g.Attach(context.Background(), first)
	g.SetBlinded(true)
	g.Detach()

	g.SetBlinded(true) // a redundant push with nothing attached must be safe

	second := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	g.Attach(context.Background(), second)
	if !second.Muted() {
		t.Fatalf("listener from the second connection came up unmuted while blinded")
	}
}

// TestWakeMuteSurvivesSessionCapture — the regression that makes P0.3 real.
// A Ctrl+Space session capture does Pause() then a deferred Resume(). Resume
// must NOT reopen the mic while the privacy gate holds it closed, or every
// push-to-talk would silently un-blind the user.
func TestWakeMuteSurvivesSessionCapture(t *testing.T) {
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	w.SetMuted(context.Background(), true)

	// running is false here, so Pause/Resume short-circuit at the device
	// layer; assert the flag itself is untouched, which is what Resume reads.
	w.Pause()
	w.Resume(context.Background())

	if !w.Muted() {
		t.Fatalf("mute was cleared by a Pause/Resume cycle")
	}
}

// TestWakeMutedDropsChunks — belt-and-braces: even if a callback fires from an
// in-flight device teardown, a muted listener buffers nothing.
func TestWakeMutedDropsChunks(t *testing.T) {
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	w.SetMuted(context.Background(), true)

	loud := pcmChunk(160, 8000)
	w.onChunk(loud)
	w.onChunk(loud)
	w.onChunk(loud)

	if w.speechChunks != 0 || w.speechSeen || len(w.segBuf) != 0 {
		t.Fatalf("muted listener buffered audio: chunks=%d seen=%v buf=%d",
			w.speechChunks, w.speechSeen, len(w.segBuf))
	}
}

// TestWakeSetMutedIdempotent — repeated pushes of the same state are a no-op.
// The daemon re-pushes set_blinded on every sidecar connect.
func TestWakeSetMutedIdempotent(t *testing.T) {
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	ctx := context.Background()

	w.SetMuted(ctx, false)
	if w.Muted() {
		t.Fatalf("SetMuted(false) on a fresh listener set muted")
	}
	w.SetMuted(ctx, true)
	w.SetMuted(ctx, true)
	if !w.Muted() {
		t.Fatalf("repeated SetMuted(true) did not stay muted")
	}
	w.SetMuted(ctx, false)
	if w.Muted() {
		t.Fatalf("SetMuted(false) did not unmute")
	}
}
