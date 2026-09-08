package main

import (
	"bytes"
	"testing"
	"time"
)

// The stream player's render body is split out of the malgo callback precisely
// so the jitter cushion can be tested without an audio device.

func silence(n int) []byte { return make([]byte, n) }

func loudPCM(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = 0x7F
	}
	return b
}

// While priming, the callback must output silence even though audio is
// available: that is the whole point of the playout cushion. It starts draining
// only once the cushion is built.
func TestStreamRenderHoldsSilenceUntilCushionIsBuilt(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.priming.Store(true)
	p.cushion.Store(jitterPrimeBytes)

	// Just under the cushion: still silence, still priming.
	ring.write(loudPCM(jitterPrimeBytes - 2))
	out := make([]byte, 480)
	p.render(out, ring)
	if !bytes.Equal(out, silence(len(out))) {
		t.Fatal("expected silence while the cushion is still building")
	}
	if !p.priming.Load() {
		t.Fatal("expected to still be priming below the cushion")
	}
	if ring.pending() != jitterPrimeBytes-2 {
		t.Fatal("priming must not consume the buffer it is accumulating")
	}

	// Over the cushion: drains.
	ring.write(loudPCM(480))
	p.render(out, ring)
	if bytes.Equal(out, silence(len(out))) {
		t.Fatal("expected audio once the cushion is built")
	}
	if p.priming.Load() {
		t.Fatal("expected priming to have cleared")
	}
}

// A mid-response underrun must NOT emit the partial audio it has. A partial
// buffer padded with zeros puts a hard edge in the middle of a waveform, and a
// hard edge is a click: the sharp high-pitched glitch users reported. The
// remainder stays in the ring so playback resumes contiguously once the cushion
// rebuilds, and the cushion widens so the next gap of that size is absorbed.
func TestStreamRenderHoldsAudioBackOnMidResponseUnderrun(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.priming.Store(false)
	p.cushion.Store(jitterPrimeBytes)
	p.lastWriteNanos.Store(time.Now().UnixNano()) // the daemon is still sending

	ring.write(loudPCM(100))
	out := make([]byte, 480)
	p.render(out, ring)

	if !bytes.Equal(out, silence(len(out))) {
		t.Fatal("expected a clean silent buffer, not a partial one with a seam")
	}
	if ring.pending() != 100 {
		t.Fatalf("pending = %d, want the 100 bytes held back for contiguous playback", ring.pending())
	}
	if !p.priming.Load() {
		t.Fatal("expected an underrun to re-arm priming")
	}
	// The widen is deferred: only audio ARRIVING after the shortfall proves it
	// was jitter rather than the end of the response.
	if got := p.cushion.Load(); got != jitterPrimeBytes {
		t.Fatalf("cushion = %d, want it unchanged until audio resumes", got)
	}
	p.noteAudioResumed()
	if p.underruns.Load() != 1 {
		t.Fatalf("underruns = %d, want 1", p.underruns.Load())
	}
	if got := p.cushion.Load(); got != jitterPrimeBytes+streamCushionStep {
		t.Fatalf("cushion = %d, want it widened to %d", got, jitterPrimeBytes+streamCushionStep)
	}
}

// The ratchet this guards against: with delivery paced near real time, the ring
// runs dry at the end of EVERY response. Widening on those would push playout
// latency to the cap over a conversation and add most of a second before the
// assistant starts speaking.
func TestStreamCushionDoesNotWidenAtTheEndOfAResponse(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.cushion.Store(jitterPrimeBytes)
	out := make([]byte, 480)

	for turn := 0; turn < 20; turn++ {
		// A response: audio arrives, plays, then the ring runs dry and nothing
		// follows before the next turn begins.
		p.priming.Store(false)
		p.lastWriteNanos.Store(time.Now().UnixNano())
		ring.write(loudPCM(100))
		p.render(out, ring) // short: holds back, marks pending
		ring.flush()
	}
	if got := p.cushion.Load(); got != jitterPrimeBytes {
		t.Fatalf("cushion = %d after 20 quiet turn endings, want the base %d", got, jitterPrimeBytes)
	}
	if got := p.underruns.Load(); got != 0 {
		t.Fatalf("underruns = %d, want 0: a response ending is not an underrun", got)
	}
}

// Write is where a resumed stream is noticed, so the wiring has to hold.
func TestStreamWriteWidensTheCushionAfterAShortfall(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.mu.Lock()
	p.ring = ring
	p.started = true
	p.mu.Unlock()
	p.cushion.Store(jitterPrimeBytes)
	p.priming.Store(false)
	p.lastWriteNanos.Store(time.Now().UnixNano())

	ring.write(loudPCM(100))
	p.render(make([]byte, 480), ring) // shortfall mid-response
	p.Write(loudPCM(960))             // ... and the stream resumes

	if got := p.cushion.Load(); got != jitterPrimeBytes+streamCushionStep {
		t.Fatalf("cushion = %d, want %d", got, jitterPrimeBytes+streamCushionStep)
	}
}

// Half a sample must never be dropped: the next frame would be byte-shifted,
// and byte-shifted s16 is full-scale static.
func TestStreamWriteCarriesAnOddTrailingByte(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.mu.Lock()
	p.ring = ring
	p.started = true
	p.mu.Unlock()

	p.Write([]byte{1, 2, 3})    // one whole sample, one orphaned byte
	p.Write([]byte{4, 5, 6, 7}) // the orphan pairs with the first byte here

	got := make([]byte, 8)
	n := ring.read(got)
	want := []byte{1, 2, 3, 4, 5, 6}
	if n != len(want) || !bytes.Equal(got[:n], want) {
		t.Fatalf("got %v, want %v (nothing dropped, nothing reordered)", got[:n], want)
	}
	if rem := ring.pending(); rem != 0 {
		t.Fatalf("pending = %d, want 0 with one byte still carried", rem)
	}
}

// The cushion must widen on repeated underruns but stop at the cap, or a bad
// network would push playout latency up without bound.
func TestStreamCushionWidensToACap(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.cushion.Store(jitterPrimeBytes)
	out := make([]byte, 480)

	for i := 0; i < 100; i++ {
		p.priming.Store(false)
		p.lastWriteNanos.Store(time.Now().UnixNano())
		p.render(out, ring)
		p.noteAudioResumed() // the stream keeps flowing: genuine jitter
	}
	if got := p.cushion.Load(); got != streamCushionMax {
		t.Fatalf("cushion = %d, want the cap %d", got, streamCushionMax)
	}
}

// The end of a response is not an underrun: once the daemon stops sending, the
// last partial buffer has to be played out. Otherwise it is stranded in the ring
// and surfaces as a stale fragment in front of the NEXT answer.
func TestStreamRenderDrainsTheTailWhenInputStops(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.priming.Store(false)
	p.cushion.Store(jitterPrimeBytes)
	// The daemon stopped sending a while ago: the response is over.
	p.lastWriteNanos.Store(time.Now().Add(-2 * streamInputIdle).UnixNano())

	ring.write(loudPCM(100))
	out := make([]byte, 480)
	p.render(out, ring)

	if !bytes.Equal(out[:100], loudPCM(100)) {
		t.Fatal("expected the tail to be played out")
	}
	if !bytes.Equal(out[100:], silence(len(out)-100)) {
		t.Fatal("expected silence after the tail")
	}
	if ring.pending() != 0 {
		t.Fatalf("pending = %d, want the tail consumed", ring.pending())
	}
	if p.underruns.Load() != 0 {
		t.Fatal("the end of a response must not count as an underrun")
	}
	if got := p.cushion.Load(); got != jitterPrimeBytes {
		t.Fatal("the end of a response must not widen the cushion")
	}
}

// A response that ends while still priming must still release its tail, or a
// very short answer (less than one cushion) would never play at all.
func TestStreamRenderReleasesAShortAnswerStuckBelowTheCushion(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.priming.Store(true)
	p.cushion.Store(jitterPrimeBytes)
	p.lastWriteNanos.Store(time.Now().Add(-2 * streamInputIdle).UnixNano())

	ring.write(loudPCM(480)) // well under the cushion
	out := make([]byte, 480)
	p.render(out, ring)

	if bytes.Equal(out, silence(len(out))) {
		t.Fatal("a finished short answer must play, not wait for a cushion that will never arrive")
	}
}

// A full buffer must render without touching priming: no cushion rebuild in the
// middle of a healthy response.
func TestStreamRenderLeavesPrimingAloneWhenFed(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.priming.Store(false)
	p.cushion.Store(jitterPrimeBytes)

	ring.write(loudPCM(4800))
	out := make([]byte, 480)
	for i := 0; i < 10; i++ {
		p.render(out, ring)
		if bytes.Equal(out, silence(len(out))) {
			t.Fatalf("render %d produced silence with a full buffer", i)
		}
		if p.priming.Load() {
			t.Fatalf("render %d re-primed with a full buffer", i)
		}
	}
}

// Flush is barge-in: the queue empties and the next response has to rebuild its
// cushion rather than playing the tail of the interrupted one.
func TestStreamFlushDropsQueuedAudioAndRePrimes(t *testing.T) {
	p := NewAudioStreamPlayer()
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.mu.Lock()
	p.ring = ring
	p.mu.Unlock()
	p.priming.Store(false)

	ring.write(loudPCM(jitterPrimeBytes * 2))
	p.Flush()

	if ring.pending() != 0 {
		t.Fatalf("pending = %d after Flush, want 0", ring.pending())
	}
	if !p.priming.Load() {
		t.Fatal("expected Flush to re-arm priming")
	}

	out := make([]byte, 480)
	p.render(out, ring)
	if !bytes.Equal(out, silence(len(out))) {
		t.Fatal("expected silence immediately after a flush")
	}
}

// IsActive is the realtime half-duplex mic gate. It must report true while
// audio is queued, and it must not panic or block when no device is open.
func TestStreamIsActiveTracksQueuedAudio(t *testing.T) {
	p := NewAudioStreamPlayer()
	if p.IsActive() {
		t.Fatal("expected inactive before anything is written")
	}

	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.mu.Lock()
	p.ring = ring
	p.mu.Unlock()

	ring.write(loudPCM(480))
	if !p.IsActive() {
		t.Fatal("expected active while audio is queued")
	}

	ring.read(make([]byte, 480))
	// Drained, but no frame has ever arrived, so the echo hangover has nothing
	// to hold open.
	if p.IsActive() {
		t.Fatal("expected inactive once drained with no recent write")
	}
}

// Write must be safe (and a no-op) when the player has been stopped, since a
// play_pcm frame can arrive between the daemon's send and our teardown.
func TestStreamWriteAfterStopIsHarmless(t *testing.T) {
	p := NewAudioStreamPlayer()
	p.Stop() // never started; must not panic
	p.Write(loudPCM(480))

	p.mu.Lock()
	writes := p.writes
	p.mu.Unlock()
	if writes != 1 {
		t.Fatalf("writes = %d, want 1 (the frame is still counted)", writes)
	}
}
