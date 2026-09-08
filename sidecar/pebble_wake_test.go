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
// buffers audio, and that resetSegment clears it. Voiced BYTES are what the
// emit gate measures; the chunk count is kept only for the log line.
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
	// Two 160-sample chunks of voiced audio, and only those: the silent one is
	// buffered for STT but must not count toward the gate.
	if want := 2 * 160 * 2; w.speechBytes != want {
		t.Fatalf("speechBytes = %d, want %d", w.speechBytes, want)
	}
	if !w.speechSeen {
		t.Fatalf("speechSeen = false, want true after speech")
	}
	if len(w.segBuf) == 0 {
		t.Fatalf("segBuf empty, want buffered audio")
	}

	// resetSegment empties the buffer but keeps its reservation: the array is
	// reused so the audio thread never has to allocate (see appendSegment).
	w.resetSegment()
	if w.speechChunks != 0 || w.speechBytes != 0 || w.speechSeen || len(w.segBuf) != 0 {
		t.Fatalf("resetSegment left state: chunks=%d bytes=%d seen=%v buf=%d",
			w.speechChunks, w.speechBytes, w.speechSeen, len(w.segBuf))
	}
	if cap(w.segBuf) == 0 {
		t.Fatal("resetSegment dropped the segment buffer's reservation")
	}
}

// TestWakeEmitGate verifies maybeEmitSegment discards a too-short segment but
// ships one with enough voiced audio: a clipped "Jarvis" that the old
// span-based gate would have dropped. State is set directly and lastSpeechAt is
// backdated so silence exceeds the cutoff without needing a clock.
func TestWakeEmitGate(t *testing.T) {
	emitMs := func(ms int) bool {
		sent := false
		var sender EventSender = func(context.Context, SidecarEvent, []byte) error {
			sent = true
			return nil
		}
		w := NewWakeListenerService(nil, sender, DefaultWakeListenerOpts())
		past := time.Now().Add(-10 * time.Second) // silence >> SilenceCutoff
		samples := pebbleAudioSampleRate * ms / 1000
		w.speechSeen = true
		w.speechChunks = 3
		w.speechBytes = samples * 2
		w.speechStartedAt = past
		w.lastSpeechAt = past
		w.segStartedAt = past
		w.segBuf = pcmChunk(samples, 8000)
		w.maybeEmitSegment(context.Background())
		return sent
	}

	if emitMs(minWakeSpeechMs - 10) {
		t.Errorf("segment with %dms of voiced audio should be discarded", minWakeSpeechMs-10)
	}
	if !emitMs(minWakeSpeechMs) {
		t.Errorf("segment with %dms of voiced audio should be emitted (clipped wake word)", minWakeSpeechMs)
	}
}

// The gate must measure AUDIO, not callback buffers. The host that reported the
// voice bugs delivered 10 ms buffers, where the old count-of-3 gate let 30 ms
// noise blips through. The same three buffers must now be rejected, while the
// same 90 ms of speech is accepted however the device chooses to chop it up.
func TestWakeEmitGateIsIndependentOfDeviceBufferSize(t *testing.T) {
	segmentFrom := func(chunkSamples, chunks int) bool {
		sent := false
		var sender EventSender = func(context.Context, SidecarEvent, []byte) error {
			sent = true
			return nil
		}
		w := NewWakeListenerService(nil, sender, DefaultWakeListenerOpts())
		loud := pcmChunk(chunkSamples, 8000)
		for i := 0; i < chunks; i++ {
			w.onChunk(loud)
		}
		past := time.Now().Add(-10 * time.Second)
		w.mu.Lock()
		w.speechStartedAt, w.lastSpeechAt, w.segStartedAt = past, past, past
		w.mu.Unlock()
		w.maybeEmitSegment(context.Background())
		return sent
	}

	// 10 ms buffers (160 samples at 16 kHz), the shape from the bug report.
	if segmentFrom(160, 3) {
		t.Error("three 10ms buffers (30ms of speech) should be discarded")
	}
	if !segmentFrom(160, 9) {
		t.Error("nine 10ms buffers (90ms of speech) should be emitted")
	}
	// 30 ms buffers: the same 90 ms of speech, three callbacks instead of nine.
	if !segmentFrom(480, 3) {
		t.Error("three 30ms buffers (90ms of speech) should be emitted")
	}
	// 20 ms buffers, the period the sidecar actually requests. The floor is
	// quantized up to 100 ms here; pin both sides of that so a future change to
	// the capture period has to look at this gate.
	twentyMs := pebbleAudioSampleRate * int(pebbleCapturePeriodMs) / 1000
	if segmentFrom(twentyMs, 4) {
		t.Error("four 20ms buffers (80ms of speech) should be discarded")
	}
	if !segmentFrom(twentyMs, 5) {
		t.Error("five 20ms buffers (100ms of speech) should be emitted")
	}
}

// The segment buffer is reserved once and reused so the audio thread never
// allocates. That only holds if appendSegment refuses to grow past the
// reservation, and if it says so once per segment rather than once per chunk.
func TestWakeAppendSegmentRespectsItsCeiling(t *testing.T) {
	w := NewWakeListenerService(nil, nil, DefaultWakeListenerOpts())

	reserved := cap(w.segBuf)
	if want := w.segmentCapBytes(); reserved != want {
		t.Fatalf("reserved %d bytes, want %d", reserved, want)
	}
	// The ceiling has to sit above the coordinator's own hard cap, or it would
	// start truncating normal segments instead of only pathological ones.
	maxNormal := int(w.opts.MaxSegmentDur/time.Second) * pebbleAudioSampleRate * pebbleAudioChannels * 2
	if reserved <= maxNormal {
		t.Fatalf("reservation %d does not clear MaxSegmentDur's %d bytes", reserved, maxNormal)
	}

	loud := pcmChunk(1600, 8000) // 100 ms
	w.mu.Lock()
	for i := 0; i < (reserved/len(loud))+10; i++ {
		w.appendSegment(loud)
	}
	held, ceilingHit := len(w.segBuf), w.segFullLogged
	grown := cap(w.segBuf)
	w.mu.Unlock()

	if grown != reserved {
		t.Fatalf("segment buffer grew from %d to %d: the audio thread allocated", reserved, grown)
	}
	if held > reserved {
		t.Fatalf("held %d bytes in a %d byte reservation", held, reserved)
	}
	if !ceilingHit {
		t.Fatal("expected the ceiling to be noted once")
	}
}
