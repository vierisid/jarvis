package main

import (
	"sync"
	"testing"
	"time"
)

// A microphone that records nothing real, and says what was done with it.
type fakeTalkMic struct {
	mu      sync.Mutex
	opened  []string
	closed  int
	refuse  string
	muted   bool
	onChunk func([]byte)
	pcm     []byte
}

func (m *fakeTalkMic) mic() *notchTalkMic {
	return &notchTalkMic{
		SampleRate: 16000,
		Muted:      func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.muted },
		Open: func(id string, onChunk func([]byte)) string {
			m.mu.Lock()
			defer m.mu.Unlock()
			if m.refuse != "" {
				return m.refuse
			}
			m.opened = append(m.opened, id)
			m.onChunk = onChunk
			return ""
		},
		Close: func() ([]byte, time.Duration) {
			m.mu.Lock()
			defer m.mu.Unlock()
			m.closed++
			m.onChunk = nil
			return m.pcm, 1500 * time.Millisecond
		},
	}
}

// speak feeds ms milliseconds of loud sound to the open recording.
func (m *fakeTalkMic) speak(ms int) {
	m.mu.Lock()
	onChunk := m.onChunk
	m.mu.Unlock()
	if onChunk == nil {
		return
	}
	// 20 ms pieces of 16 kHz, 16-bit sound.
	for i := 0; i < ms/20; i++ {
		onChunk(pcmChunk(320, 4000))
	}
}

type talkSent struct {
	phase   string
	payload map[string]any
	audio   int
	hasPCM  bool
}

type talkHarness struct {
	t    *testing.T
	talk *notchTalker
	mic  *fakeTalkMic
	mu   sync.Mutex
	sent []talkSent
}

func newTalkHarness(t *testing.T) *talkHarness {
	h := &talkHarness{t: t, talk: newNotchTalker(), mic: &fakeTalkMic{pcm: make([]byte, 32000)}}
	h.talk.use(h.mic.mic(), h.send)
	t.Cleanup(h.talk.forget)
	return h
}

func (h *talkHarness) send(phase string, payload map[string]any, pcm []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sent = append(h.sent, talkSent{phase: phase, payload: payload, audio: len(pcm), hasPCM: pcm != nil})
}

// settle waits until the loop has carried out everything given to it so far.
func (h *talkHarness) settle() {
	done := make(chan struct{})
	h.talk.start()
	h.talk.cmds <- notchTalkCmd{kind: 0, done: done}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		h.t.Fatal("the talk loop did not settle")
	}
}

func (h *talkHarness) key(action notchKeyAction) {
	h.talk.key(action)
	h.settle()
}

func (h *talkHarness) phases() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, len(h.sent))
	for i, s := range h.sent {
		out[i] = s.phase
	}
	return out
}

func (h *talkHarness) last() talkSent {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.sent) == 0 {
		h.t.Fatal("nothing was sent")
	}
	return h.sent[len(h.sent)-1]
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestNotchTalkHoldSpeakLetGo(t *testing.T) {
	h := newTalkHarness(t)
	h.key(notchKeyTalkStart)
	if len(h.mic.opened) != 1 {
		t.Fatalf("the microphone was opened %d times, want 1", len(h.mic.opened))
	}
	id := h.mic.opened[0]
	if got := h.last(); got.phase != "start" || got.payload["talk_id"] != id {
		t.Fatalf("start was %+v, want the recording's id %q", got, id)
	}
	h.mic.speak(900)
	h.key(notchKeyTalkEnd)
	got := h.last()
	if got.phase != "end" || got.payload["talk_id"] != id || got.payload["reason"] != "released" {
		t.Fatalf("end was %+v", got)
	}
	if got.payload["voiced_ms"].(int64) != 900 {
		t.Fatalf("voiced_ms = %v, want 900", got.payload["voiced_ms"])
	}
	if got.audio != 32000 {
		t.Fatalf("%d bytes of audio were sent, want the recording's 32000", got.audio)
	}
	if h.mic.closed != 1 {
		t.Fatalf("the microphone was closed %d times, want 1", h.mic.closed)
	}
}

// Silence, or a tap too short to say anything: the brain is told how little
// was said, and the sound itself stays on this machine.
func TestNotchTalkTooLittleSendsNoAudio(t *testing.T) {
	for _, voiced := range []int{0, 200} {
		h := newTalkHarness(t)
		h.key(notchKeyTalkStart)
		h.mic.speak(voiced)
		h.key(notchKeyTalkEnd)
		got := h.last()
		if got.phase != "end" || got.hasPCM {
			t.Fatalf("with %d ms of voice: %+v, want an end with no audio", voiced, got)
		}
		if got.payload["voiced_ms"].(int64) != int64(voiced) {
			t.Fatalf("voiced_ms = %v, want %d", got.payload["voiced_ms"], voiced)
		}
	}
}

// Another key with the pair held is a slip or a shortcut, not the end of a
// sentence: the recording is thrown away here.
func TestNotchTalkCancelSendsNoAudio(t *testing.T) {
	h := newTalkHarness(t)
	h.key(notchKeyTalkStart)
	h.mic.speak(900)
	h.key(notchKeyTalkCancel)
	got := h.last()
	if got.phase != "cancelled" || got.hasPCM || got.payload["talk_id"] != h.mic.opened[0] {
		t.Fatalf("cancel sent %+v", got)
	}
	// A key-up that arrives after it ends nothing a second time.
	h.key(notchKeyTalkEnd)
	if want := []string{"start", "cancelled"}; !sameStrings(h.phases(), want) {
		t.Fatalf("phases = %v, want %v", h.phases(), want)
	}
	if h.mic.closed != 1 {
		t.Fatalf("the microphone was closed %d times, want 1", h.mic.closed)
	}
}

func TestNotchTalkThreeFastPressesAreThreeRecordings(t *testing.T) {
	h := newTalkHarness(t)
	for i := 0; i < 3; i++ {
		h.key(notchKeyTalkStart)
		h.mic.speak(100)
		h.key(notchKeyTalkEnd)
	}
	if len(h.mic.opened) != 3 || h.mic.closed != 3 {
		t.Fatalf("opened %d, closed %d, want 3 and 3", len(h.mic.opened), h.mic.closed)
	}
	if h.mic.opened[0] == h.mic.opened[1] || h.mic.opened[1] == h.mic.opened[2] {
		t.Fatalf("recordings shared an id: %v", h.mic.opened)
	}
	// Each was too short to be an instruction: none sent its sound.
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.sent {
		if s.hasPCM {
			t.Fatalf("%+v carried audio", s)
		}
	}
}

func TestNotchTalkMutedOrBusyIsRefusedAndSaysWhy(t *testing.T) {
	for _, why := range []string{"muted", "busy", "error"} {
		h := newTalkHarness(t)
		h.mic.refuse = why
		h.key(notchKeyTalkStart)
		got := h.last()
		if got.phase != "refused" || got.payload["reason"] != why {
			t.Fatalf("refusal was %+v, want reason %q", got, why)
		}
		// Letting go of a recording that never opened does nothing.
		h.key(notchKeyTalkEnd)
		if want := []string{"refused"}; !sameStrings(h.phases(), want) {
			t.Fatalf("phases = %v, want %v", h.phases(), want)
		}
	}
}

// Muted while the keys were held: what was recorded before does not leave.
func TestNotchTalkMutedMidwayNeverSendsAudio(t *testing.T) {
	h := newTalkHarness(t)
	h.key(notchKeyTalkStart)
	h.mic.speak(900)
	h.mic.mu.Lock()
	h.mic.muted = true
	h.mic.mu.Unlock()
	h.key(notchKeyTalkEnd)
	if got := h.last(); got.phase != "cancelled" || got.hasPCM {
		t.Fatalf("after a mute midway: %+v, want cancelled with no audio", got)
	}
}

// A key-up that never arrives must not leave the microphone open.
func TestNotchTalkClosesItselfAtTheCap(t *testing.T) {
	h := newTalkHarness(t)
	h.talk.cap = 40 * time.Millisecond
	h.key(notchKeyTalkStart)
	h.mic.speak(900)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h.settle()
		if p := h.phases(); len(p) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	got := h.last()
	if got.phase != "end" || got.payload["reason"] != "cap" || got.hasPCM {
		t.Fatalf("at the cap: %+v, want an end with reason cap and no audio", got)
	}
	if h.mic.closed != 1 {
		t.Fatalf("the microphone was closed %d times, want 1", h.mic.closed)
	}
	// The cap of a recording that is over does not end the next one.
	h.talk.cap = time.Hour
	h.key(notchKeyTalkStart)
	h.talk.cmds <- notchTalkCmd{kind: 2, reason: "cap", id: h.mic.opened[0]}
	h.settle()
	if len(h.phases()) != 3 {
		t.Fatalf("an old recording's cap ended a new one: %v", h.phases())
	}
}

// The connection ends in the middle of a sentence: the device is closed and
// nothing is sent, because there is nowhere to send it.
func TestNotchTalkForgetClosesAnOpenRecording(t *testing.T) {
	h := newTalkHarness(t)
	h.key(notchKeyTalkStart)
	h.talk.forget()
	if h.mic.closed != 1 {
		t.Fatalf("the microphone was closed %d times, want 1", h.mic.closed)
	}
	if want := []string{"start"}; !sameStrings(h.phases(), want) {
		t.Fatalf("phases = %v, want %v", h.phases(), want)
	}
	// With nothing to send on, the keys do nothing.
	h.key(notchKeyTalkStart)
	if len(h.mic.opened) != 1 {
		t.Fatal("the microphone was opened with no connection")
	}
}

// A desktop app with no microphone path says so, and does not go quiet.
func TestNotchTalkWithNoMicrophoneIsRefused(t *testing.T) {
	h := &talkHarness{t: t, talk: newNotchTalker(), mic: &fakeTalkMic{}}
	h.talk.use(nil, h.send)
	t.Cleanup(h.talk.forget)
	h.key(notchKeyTalkStart)
	if got := h.last(); got.phase != "refused" || got.payload["reason"] != "none" {
		t.Fatalf("with no microphone: %+v", got)
	}
}

// The wake listener keeps the microphone closed until the brain has said it
// may listen for its name, and for good when the brain has the notch on.
func TestNotchWakeListenerWaitsForTheBrainsWord(t *testing.T) {
	defer wakeHold.Store(wakeAllowed)
	if wakeHeld() {
		t.Fatal("with nothing said, listening is allowed: the zero value must not hold it")
	}
	wakeHold.Store(wakeUndecided)
	if !wakeHeld() {
		t.Fatal("a connection waiting for the brain's word must hold the microphone closed")
	}
	// An old brain's silence, or a brain with the notch off, lets it go.
	if !wakeHold.CompareAndSwap(wakeUndecided, wakeAllowed) || wakeHeld() {
		t.Fatal("the brain's yes did not release it")
	}
	// A brain with the notch on: held, and a late "no word came" does not undo it.
	wakeHold.Store(wakeForbidden)
	if wakeHold.CompareAndSwap(wakeUndecided, wakeAllowed) || !wakeHeld() {
		t.Fatal("the fallback released a listener the brain had forbidden")
	}
}
