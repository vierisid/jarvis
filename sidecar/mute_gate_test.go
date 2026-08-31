package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

// setMutedForTest flips the process-global mic gate and restores it after the
// test, so an ordering change in the file can't leak a muted mic into the next
// test's expectations.
func setMutedForTest(t *testing.T, muted bool) {
	t.Helper()
	prev := getTrayStatus()
	s := prev
	s.Muted = muted
	setTrayStatus(s)
	t.Cleanup(func() { setTrayStatus(prev) })
}

// chunkListenerSet reports whether the capture service currently has a chunk
// listener installed — the observable proof that Resume() reached the device
// work rather than short-circuiting on the mute gate.
func chunkListenerSet(s *AudioCaptureService) bool {
	s.onChunkMu.RLock()
	defer s.onChunkMu.RUnlock()
	return s.onChunk != nil
}

// TestWakeResumeRefusedWhileMuted is the regression for the mute/summon
// divergence: displayed state and device state must not drift apart.
//
// mute → summon → capture completes used to leave the always-on wake listener
// running (the capture's deferred Resume cleared the pause the mute handler had
// set, since both wrote the same bit) while TrayStatus.Muted stayed true — so
// the menu said muted with a live mic, until you toggled mute twice.
func TestWakeResumeRefusedWhileMuted(t *testing.T) {
	svc := NewAudioCaptureService() // never Start()ed: no real device is touched
	w := NewWakeListenerService(svc, nil, DefaultWakeListenerOpts())
	w.running.Store(true) // as if Start() had opened the device

	w.Pause() // a session capture borrows the mic
	if !w.paused.Load() {
		t.Fatalf("paused = false after Pause(), want true")
	}

	setMutedForTest(t, true) // user mutes from the tray mid-capture

	w.Resume(context.Background()) // the capture's deferred Resume on the way out

	if !w.paused.Load() {
		t.Errorf("wake listener resumed while muted — mic is live behind a muted menu")
	}
	if chunkListenerSet(svc) {
		t.Errorf("Resume() reinstalled the chunk listener while muted")
	}
	if !micMuted() {
		t.Errorf("TrayStatus.Muted = false, want true — the displayed state must survive a capture")
	}
}

// TestWakeResumeRestoresWhenNotMuted guards the other half: with no mute in
// place, a consumer's Resume must still get past the gate and go do device
// work. The context is pre-cancelled so the retry loop bails before opening a
// real device — the installed chunk listener is the marker that it got there.
func TestWakeResumeRestoresWhenNotMuted(t *testing.T) {
	setMutedForTest(t, false)
	svc := NewAudioCaptureService()
	w := NewWakeListenerService(svc, nil, DefaultWakeListenerOpts())
	w.running.Store(true)
	w.Pause()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w.Resume(ctx)

	if !chunkListenerSet(svc) {
		t.Errorf("Resume() short-circuited with no mute in place")
	}
}

// TestWakeStartsPausedWhileMuted covers the reconnect path: connectAndServe
// builds a fresh listener per connection, and coming up live would re-arm
// always-on listening while the tray still says muted.
func TestWakeStartsPausedWhileMuted(t *testing.T) {
	setMutedForTest(t, true)
	svc := NewAudioCaptureService()
	w := NewWakeListenerService(svc, nil, DefaultWakeListenerOpts())

	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("Start() while muted: %v", err)
	}
	defer w.Stop()

	if !w.running.Load() {
		t.Errorf("running = false, want true — the listener must stay armed so unmuting recovers it")
	}
	if !w.paused.Load() {
		t.Errorf("paused = false — a muted sidecar reopened the mic on reconnect")
	}
	if chunkListenerSet(svc) {
		t.Errorf("Start() installed the chunk listener while muted")
	}
}

// TestRealtimeStartRefusedWhileMuted covers the second door into the mic: with
// realtime voice enabled the summon hotkey routes here instead of the one-shot
// capture, so it needs the same gate — and must say why rather than no-op.
func TestRealtimeStartRefusedWhileMuted(t *testing.T) {
	setMutedForTest(t, true)

	refusals := 0
	var states []PebbleState
	r := newRealtimeVoice(
		nil, nil,
		func(string, map[string]any) {},
		func(*AudioStreamPlayer) {},
		func(s PebbleState) { states = append(states, s) },
		func() {},
		nil,
		func() { refusals++ },
	)

	r.Start()

	if r.active.Load() {
		t.Errorf("realtime session went active while muted")
	}
	if refusals != 1 {
		t.Errorf("micRefused called %d times, want 1 — a silent refusal reads as a broken hotkey", refusals)
	}
	// Re-asserting PebbleMuted would paint nothing (the tray toggle already put
	// the pebble there), which is why the refusal goes through micRefused.
	if len(states) != 0 {
		t.Errorf("pebble states = %v, want none — the refusal is micRefused's job", states)
	}
}

// nudgePebbleStub records bubble-text writes; everything else is a no-op.
type nudgePebbleStub struct {
	mu    sync.Mutex
	texts []string
}

func (p *nudgePebbleStub) SetText(text string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.texts = append(p.texts, text)
	return nil
}

func (p *nudgePebbleStub) lastText() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.texts) == 0 {
		return ""
	}
	return p.texts[len(p.texts)-1]
}

func (p *nudgePebbleStub) Spawn(PebbleSpec) error              { return nil }
func (p *nudgePebbleStub) SetState(PebbleState) error          { return nil }
func (p *nudgePebbleStub) PointAt(int, int, string, int) error { return nil }
func (p *nudgePebbleStub) SetEye(bool) error                   { return nil }
func (p *nudgePebbleStub) SetAnswerOverflow(string) error      { return nil }
func (p *nudgePebbleStub) SetBlinded(bool) error               { return nil }
func (p *nudgePebbleStub) SetEthereal(bool, int)               {}
func (p *nudgePebbleStub) Close() error                        { return nil }
func (p *nudgePebbleStub) OnSummon(func())                     {}
func (p *nudgePebbleStub) OnPalette(func())                    {}
func (p *nudgePebbleStub) OnBlindToggle(func())                {}
func (p *nudgePebbleStub) OnAnswerOpen(func(string))           {}

// TestMutedNudgeExpiryClearsOwnText covers the nudge's normal life: it puts the
// reason in the bubble and takes it back out again.
func TestMutedNudgeExpiryClearsOwnText(t *testing.T) {
	shortenNudge(t)
	p := &nudgePebbleStub{}

	flashMutedPebble(p)
	if p.lastText() == "" {
		t.Fatalf("nudge wrote no bubble text")
	}
	time.Sleep(10 * mutedNudgeDur)

	if p.lastText() != "" {
		t.Errorf("bubble text = %q after expiry, want cleared", p.lastText())
	}
}

// TestMutedNudgeExpirySparesOtherText is the one that matters: a nudge armed
// moments before the brain streams an answer into the bubble must not blank it
// when the timer fires. pebble.set_state claims the text via
// invalidateMutedNudge; this asserts the claim holds.
func TestMutedNudgeExpirySparesOtherText(t *testing.T) {
	shortenNudge(t)
	p := &nudgePebbleStub{}

	flashMutedPebble(p)
	handler := makePebbleSetStateHandler(p)
	if _, err := handler(map[string]any{"state": "speaking", "text": "here's the answer"}); err != nil {
		t.Fatalf("set_state: %v", err)
	}
	time.Sleep(10 * mutedNudgeDur)

	if p.lastText() != "here's the answer" {
		t.Errorf("bubble text = %q, want the brain's text — a stale nudge blanked it", p.lastText())
	}
}

func shortenNudge(t *testing.T) {
	t.Helper()
	prev := mutedNudgeDur
	mutedNudgeDur = 5 * time.Millisecond
	t.Cleanup(func() { mutedNudgeDur = prev })
}

// TestTrayStatusIgnoresRemoteMuted pins the decision that mute is sidecar-owned:
// the brain's tray.status heartbeat can no longer flip it. Honoring it would
// make micMuted() — now the authoritative gate on every mic-opening path —
// remotely settable, in both directions.
func TestTrayStatusIgnoresRemoteMuted(t *testing.T) {
	setMutedForTest(t, true)

	s := trayStatusFromParams(map[string]any{"muted": false, "waiting": float64(3)})

	if !s.Muted {
		t.Errorf("tray.status payload un-muted the microphone remotely")
	}
	if s.Waiting != 3 {
		t.Errorf("Waiting = %d, want 3 — the rest of the payload must still merge", s.Waiting)
	}
}
