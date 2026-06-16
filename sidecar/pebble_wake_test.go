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

	loud := pcmChunk(160, 8000)  // RMS 8000 >> 500 threshold -> speech
	quiet := pcmChunk(160, 5)    // RMS ~5 << threshold -> silence

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
