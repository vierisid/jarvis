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
	for _, voiced := range []int{0, 100} {
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

// ── How much voice is in a recording ────────────────────────────────────────

// talkPieces builds a recording from levels, one 20 ms piece each.
func talkPieces(levels ...float32) []notchTalkPiece {
	out := make([]notchTalkPiece, len(levels))
	for i, level := range levels {
		out[i] = notchTalkPiece{rms: level, bytes: 640}
	}
	return out
}

func repeatLevels(n int, levels ...float32) []float32 {
	out := make([]float32, 0, n*len(levels))
	for i := 0; i < n; i++ {
		out = append(out, levels...)
	}
	return out
}

// A webcam microphone across a desk: speech that hardly reaches the fixed
// level the first build used. This is the recording that was thrown away on
// the first real microphone, every time.
func quietMicSpeech() []notchTalkPiece {
	levels := repeatLevels(5, 35)
	levels = append(levels, repeatLevels(9, 300, 380, 520, 350, 80, 60)...)
	levels = append(levels, repeatLevels(3, 35)...)
	return talkPieces(levels...)
}

func TestNotchTalkMeasureHearsAQuietMicrophone(t *testing.T) {
	pieces := quietMicSpeech()
	// What the fixed level of 500 made of it: 9 pieces, 180 ms, "too little".
	var old int64
	for _, piece := range pieces {
		if piece.rms >= 500 {
			old += 20
		}
	}
	// The floor was 250 ms then.
	if old >= 250 {
		t.Fatalf("the example is not the failure it stands for: the fixed level heard %d ms", old)
	}
	heard := notchTalkMeasure(pieces, 16000)
	if heard.VoicedMs < 600 {
		t.Fatalf("heard %d ms of voice at level %.0f, want the speech (720 ms): %+v", heard.VoicedMs, heard.Level, heard)
	}
	if heard.Level != notchTalkVoiceFloorRMS {
		t.Fatalf("level = %.0f, want the floor %.0f for a quiet room", heard.Level, notchTalkVoiceFloorRMS)
	}
}

// Hold the keys and say nothing: a steady room, quiet or not, is not voice.
func TestNotchTalkMeasureSteadyRoomIsNotVoice(t *testing.T) {
	for name, levels := range map[string][]float32{
		"a quiet room": repeatLevels(25, 30, 38, 45, 33),
		"a fan":        repeatLevels(25, 180, 220, 260, 200),
		"no sound":     repeatLevels(100, 0),
	} {
		heard := notchTalkMeasure(talkPieces(levels...), 16000)
		if heard.VoicedMs >= notchTalkMinVoicedMs {
			t.Errorf("%s: heard %d ms of voice at level %.0f: %+v", name, heard.VoicedMs, heard.Level, heard)
		}
	}
}

// A click, a cough, a key: loud, and far too short to be an instruction.
func TestNotchTalkMeasureAClickIsTooLittle(t *testing.T) {
	levels := repeatLevels(40, 30)
	levels = append(levels, 2400, 1900)
	levels = append(levels, repeatLevels(40, 30)...)
	heard := notchTalkMeasure(talkPieces(levels...), 16000)
	if heard.VoicedMs != 40 {
		t.Fatalf("heard %d ms, want the click's 40", heard.VoicedMs)
	}
}

// A loud microphone and a loud room are heard as before: the level never
// goes above what the fixed one was.
func TestNotchTalkMeasureNeverAsksForMoreThanTheOldLevel(t *testing.T) {
	headset := append(repeatLevels(5, 20), repeatLevels(10, 3000, 5200, 4100, 900, 200)...)
	if heard := notchTalkMeasure(talkPieces(headset...), 16000); heard.VoicedMs < 600 {
		t.Fatalf("a headset: heard %d ms at level %.0f", heard.VoicedMs, heard.Level)
	}
	// Speech with no pause in it at all, loud: every piece is voice.
	flat := notchTalkMeasure(talkPieces(repeatLevels(50, 4000)...), 16000)
	if flat.Level != notchTalkVoiceCapRMS || flat.VoicedMs != 1000 {
		t.Fatalf("flat loud speech: %d ms at level %.0f, want 1000 ms at the cap", flat.VoicedMs, flat.Level)
	}
}

func TestNotchTalkMeasureOfNothing(t *testing.T) {
	if heard := notchTalkMeasure(nil, 16000); heard.VoicedMs != 0 || heard.Pieces != 0 {
		t.Fatalf("an empty recording: %+v", heard)
	}
}

// The whole path with the quiet microphone: it is sent, with its sound.
func TestNotchTalkSendsAQuietMicrophonesSpeech(t *testing.T) {
	h := newTalkHarness(t)
	h.key(notchKeyTalkStart)
	h.mic.mu.Lock()
	onChunk := h.mic.onChunk
	h.mic.mu.Unlock()
	for _, piece := range quietMicSpeech() {
		onChunk(pcmChunk(320, int16(piece.rms)))
	}
	h.key(notchKeyTalkEnd)
	got := h.last()
	if got.phase != "end" || !got.hasPCM {
		t.Fatalf("a quiet microphone's speech was not sent: %+v", got)
	}
	if got.payload["voiced_ms"].(int64) < 600 {
		t.Fatalf("voiced_ms = %v", got.payload["voiced_ms"])
	}
}

// One short word is an instruction too, and a fan under a quiet microphone
// does not drown the speech.
func TestNotchTalkMeasureHearsAShortWordAndSpeechOverAFan(t *testing.T) {
	word := append(repeatLevels(10, 35), repeatLevels(10, 420)...) // 200 ms of voice
	word = append(word, repeatLevels(10, 35)...)
	if heard := notchTalkMeasure(talkPieces(word...), 16000); heard.VoicedMs < notchTalkMinVoicedMs {
		t.Fatalf("a short word: heard %d ms at level %.0f, under the floor of %d", heard.VoicedMs, heard.Level, notchTalkMinVoicedMs)
	}
	fan := repeatLevels(8, 200, 190, 210)
	fan = append(fan, repeatLevels(9, 430, 480, 560, 450, 230, 210)...)
	if heard := notchTalkMeasure(talkPieces(fan...), 16000); heard.VoicedMs < 400 {
		t.Fatalf("speech over a fan: heard %d ms at level %.0f: %+v", heard.VoicedMs, heard.Level, heard)
	}
}
