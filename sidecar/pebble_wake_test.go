package main

import (
	"context"
	"encoding/binary"
	"testing"
	"time"
)

// pcmChunk builds a mono s16le buffer of n samples all at amplitude amp.
func pcmChunk(n int, amp int16) []byte {
	b := make([]byte, n*2)
	for i := 0; i < n; i++ {
		binary.LittleEndian.PutUint16(b[i*2:], uint16(amp))
	}
	return b
}

// TestWakeOnChunkCountsSpeech verifies onChunk counts speech-energy chunks and
// buffers audio, and that resetSegment clears the counter — the signal the
// emit gate now relies on instead of the fragile first-to-last speech span.
func TestWakeOnChunkCountsSpeech(t *testing.T) {
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())

	loud := pcmChunk(160, 8000) // RMS 8000 >> 500 threshold -> speech
	quiet := pcmChunk(160, 5)   // RMS ~5 << threshold -> silence

	w.onChunk(loud)
	w.onChunk(loud)
	w.onChunk(quiet) // trailing silence is buffered but not counted as speech
	if w.speechChunks != 2 {
		t.Fatalf("speechChunks = %d, want 2", w.speechChunks)
	}
	if !w.speechSeen {
		t.Fatalf("speechSeen = false, want true after speech")
	}
	if len(w.segBuf) == 0 {
		t.Fatalf("segBuf empty, want buffered audio")
	}

	w.resetSegment()
	if w.speechChunks != 0 || w.speechSeen || w.segBuf != nil {
		t.Fatalf("resetSegment left state: chunks=%d seen=%v buf=%d", w.speechChunks, w.speechSeen, len(w.segBuf))
	}
}

// TestWakeEmitGate verifies maybeEmitSegment discards a too-short segment but
// ships one with enough speech chunks — catching a clipped "Jarvis" that the
// old span-based gate would have dropped. State is set directly and lastSpeechAt
// is backdated so silence exceeds the cutoff without needing a clock.
func TestWakeEmitGate(t *testing.T) {
	emit := func(chunks int) bool {
		sent := false
		var sender EventSender = func(context.Context, SidecarEvent, []byte) error {
			sent = true
			return nil
		}
		w := NewWakeListenerService(nil, sender, DefaultWakeListenerOpts())
		past := time.Now().Add(-10 * time.Second) // silence >> SilenceCutoff
		w.speechSeen = true
		w.speechChunks = chunks
		w.speechStartedAt = past
		w.lastSpeechAt = past
		w.segStartedAt = past
		w.segBuf = pcmChunk(160*chunks, 8000)
		w.maybeEmitSegment(context.Background())
		return sent
	}

	if emit(minWakeSpeechChunks - 1) {
		t.Errorf("segment with %d chunks should be discarded", minWakeSpeechChunks-1)
	}
	if !emit(minWakeSpeechChunks) {
		t.Errorf("segment with %d chunks should be emitted (clipped wake word)", minWakeSpeechChunks)
	}
}

func TestWakeDoubleClapCooldown(t *testing.T) {
	detector, err := NewDoubleClapDetector(CalibratedDoubleClapOpts())
	if err != nil {
		t.Fatal(err)
	}
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	w.ConfigureDoubleClap(detector, func() {}, 2*time.Second)
	t0 := time.Unix(1, 0)
	clap := PCMTransientFeatures{RMS: 8000, PeakAbs: 32768}
	silence := PCMTransientFeatures{RMS: 1000, PeakAbs: 4000}

	w.observeDoubleClap(clap, t0)
	w.observeDoubleClap(silence, t0.Add(40*time.Millisecond))
	if detected, _ := w.observeDoubleClap(clap, t0.Add(350*time.Millisecond)); !detected {
		t.Fatal("calibrated pair must trigger")
	}
	w.observeDoubleClap(silence, t0.Add(390*time.Millisecond))
	w.observeDoubleClap(clap, t0.Add(time.Second))
	w.observeDoubleClap(silence, t0.Add(1040*time.Millisecond))
	if detected, _ := w.observeDoubleClap(clap, t0.Add(1350*time.Millisecond)); detected {
		t.Fatal("pair inside cooldown must not trigger")
	}
	w.observeDoubleClap(clap, t0.Add(3*time.Second))
	w.observeDoubleClap(silence, t0.Add(3040*time.Millisecond))
	if detected, _ := w.observeDoubleClap(clap, t0.Add(3350*time.Millisecond)); !detected {
		t.Fatal("pair after cooldown must trigger")
	}
}

func TestWakeDoubleClapSuppressionResetsPartialPair(t *testing.T) {
	detector, err := NewDoubleClapDetector(CalibratedDoubleClapOpts())
	if err != nil {
		t.Fatal(err)
	}
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	w.ConfigureDoubleClap(detector, func() {}, 2*time.Second)
	t0 := time.Unix(1, 0)
	clap := PCMTransientFeatures{RMS: 8000, PeakAbs: 32768}
	silence := PCMTransientFeatures{RMS: 1000, PeakAbs: 4000}

	w.observeDoubleClap(clap, t0)
	w.observeDoubleClap(silence, t0.Add(40*time.Millisecond))
	w.Suppress(true)
	w.Suppress(false)
	if detected, _ := w.observeDoubleClap(clap, t0.Add(350*time.Millisecond)); detected {
		t.Fatal("a clap before suppression must not pair with one after suppression")
	}
}

func TestWakeDoubleClapDoesNotObserveWhileMuted(t *testing.T) {
	original := getTrayStatus()
	muted := original
	muted.Muted = true
	setTrayStatus(muted)
	t.Cleanup(func() { setTrayStatus(original) })

	detector, err := NewDoubleClapDetector(CalibratedDoubleClapOpts())
	if err != nil {
		t.Fatal(err)
	}
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())
	w.ConfigureDoubleClap(detector, func() {}, 2*time.Second)
	w.onChunk(pcmChunk(160, 20000))

	w.clapMu.Lock()
	defer w.clapMu.Unlock()
	if !detector.firstPeak.IsZero() {
		t.Fatal("muted listener must not feed PCM into the clap detector")
	}
}
