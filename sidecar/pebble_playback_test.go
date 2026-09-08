package main

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

// newTestRing builds a ring with an exact frame capacity, bypassing the
// seconds-based sizing so tests can force wraps cheaply.
func newTestRing(frames, channels int) *pcmRing {
	frame := channels * 2
	return &pcmRing{buf: make([]byte, frames*frame), frame: frame}
}

func TestPCMRingSizingIsFrameAligned(t *testing.T) {
	for _, tc := range []struct{ rate, channels, seconds int }{
		{24000, 1, 4},
		{44100, 2, 4},
		{16000, 2, 1},
		{0, 0, 0}, // degenerate input must not produce a zero frame or zero buffer
	} {
		rb := newPCMRing(tc.rate, tc.channels, tc.seconds)
		if rb.frame <= 0 {
			t.Fatalf("%v: frame = %d, want > 0", tc, rb.frame)
		}
		if len(rb.buf) == 0 {
			t.Fatalf("%v: empty ring buffer", tc)
		}
		if len(rb.buf)%rb.frame != 0 {
			t.Fatalf("%v: capacity %d is not a multiple of frame %d", tc, len(rb.buf), rb.frame)
		}
	}
}

func TestPCMRingRoundTrip(t *testing.T) {
	rb := newTestRing(8, 2) // 32 bytes
	src := make([]byte, 16)
	for i := range src {
		src[i] = byte(i + 1)
	}

	if n := rb.write(src); n != len(src) {
		t.Fatalf("write = %d, want %d", n, len(src))
	}
	if got := rb.pending(); got != len(src) {
		t.Fatalf("pending = %d, want %d", got, len(src))
	}

	dst := make([]byte, 16)
	if n := rb.read(dst); n != len(src) {
		t.Fatalf("read = %d, want %d", n, len(src))
	}
	if !bytes.Equal(dst, src) {
		t.Fatalf("round trip mismatch: got %v, want %v", dst, src)
	}
	if got := rb.pending(); got != 0 {
		t.Fatalf("pending = %d after full read, want 0", got)
	}
	if n := rb.read(dst); n != 0 {
		t.Fatalf("read on empty ring = %d, want 0", n)
	}
}

// A write bigger than the free space must take what fits and report it, so the
// caller can retry with the remainder rather than silently losing audio.
func TestPCMRingWriteIsBoundedByFreeSpace(t *testing.T) {
	rb := newTestRing(4, 1) // 8 bytes
	src := make([]byte, 20)
	for i := range src {
		src[i] = byte(i + 1)
	}

	n := rb.write(src)
	if n != 8 {
		t.Fatalf("write = %d, want 8 (the whole capacity)", n)
	}
	if extra := rb.write(src[n:]); extra != 0 {
		t.Fatalf("write into a full ring = %d, want 0", extra)
	}

	dst := make([]byte, 8)
	rb.read(dst)
	if !bytes.Equal(dst, src[:8]) {
		t.Fatalf("got %v, want %v", dst, src[:8])
	}
}

// Reads and writes must never split a frame: a partial count would shift every
// following sample by a byte or two, which is exactly the loud, high-pitched
// static this whole fix is about.
func TestPCMRingNeverSplitsAFrame(t *testing.T) {
	rb := newTestRing(8, 2) // frame = 4 bytes
	src := make([]byte, 12)

	// A write that is not a whole number of frames moves only whole frames.
	rb.write(make([]byte, 10)) // 10 bytes offered, 8 accepted (2 frames), 2 refused
	if got := rb.pending(); got%rb.frame != 0 {
		t.Fatalf("pending = %d, not frame-aligned", got)
	}

	// A read into a buffer smaller than one frame must move nothing.
	if n := rb.read(make([]byte, 3)); n != 0 {
		t.Fatalf("sub-frame read = %d, want 0", n)
	}
	// A read into a non-frame-multiple buffer rounds down.
	if n := rb.read(make([]byte, 7)); n != 4 {
		t.Fatalf("7-byte read = %d, want 4", n)
	}

	rb.flush()
	if n := rb.write(src); n%rb.frame != 0 {
		t.Fatalf("write = %d, not frame-aligned", n)
	}
}

func TestPCMRingFlushDropsPending(t *testing.T) {
	rb := newTestRing(8, 1)
	rb.write(make([]byte, 8))
	rb.flush()
	if got := rb.pending(); got != 0 {
		t.Fatalf("pending = %d after flush, want 0", got)
	}
	// The ring stays usable after a flush.
	src := []byte{9, 8, 7, 6}
	if n := rb.write(src); n != len(src) {
		t.Fatalf("write after flush = %d, want %d", n, len(src))
	}
	dst := make([]byte, len(src))
	rb.read(dst)
	if !bytes.Equal(dst, src) {
		t.Fatalf("got %v, want %v", dst, src)
	}
}

// The real usage: one producer (the playback worker) and one consumer (the
// audio thread) at different rates, wrapping many times. Every byte must come
// out exactly once, in order.
func TestPCMRingStreamsInOrderAcrossWraps(t *testing.T) {
	const channels = 2
	rb := newTestRing(16, channels) // 64 bytes, so ~100 wraps below
	const total = 6400

	src := make([]byte, total)
	for i := range src {
		src[i] = byte(i % 251)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // producer
		defer wg.Done()
		for off := 0; off < len(src); {
			end := off + 37 // deliberately not a frame multiple
			if end > len(src) {
				end = len(src)
			}
			n := rb.write(src[off:end])
			if n == 0 {
				time.Sleep(time.Millisecond)
				continue
			}
			off += n
		}
	}()

	got := make([]byte, 0, total)
	dst := make([]byte, 23) // also not a frame multiple
	deadline := time.Now().Add(10 * time.Second)
	for len(got) < total {
		n := rb.read(dst)
		if n == 0 {
			if time.Now().After(deadline) {
				t.Fatalf("timed out after %d of %d bytes", len(got), total)
			}
			time.Sleep(time.Millisecond)
			continue
		}
		if n%rb.frame != 0 {
			t.Fatalf("read %d bytes, not a multiple of frame %d", n, rb.frame)
		}
		got = append(got, dst[:n]...)
	}
	wg.Wait()

	if !bytes.Equal(got, src) {
		for i := range got {
			if got[i] != src[i] {
				t.Fatalf("stream diverged at byte %d: got %d, want %d", i, got[i], src[i])
			}
		}
		t.Fatal("stream mismatch")
	}
}

// decodeAudio has to survive the WAV shapes the daemon's TTS providers emit,
// including the odd-sized-chunk padding rule.
func TestDecodeWAVRoundTrip(t *testing.T) {
	pcm := make([]byte, 320)
	for i := range pcm {
		pcm[i] = byte(i)
	}
	var buf bytes.Buffer
	if err := writeWAV(&buf, pcm, 24000, 1, 16); err != nil {
		t.Fatalf("writeWAV: %v", err)
	}

	got, rate, channels, err := decodeAudio(buf.Bytes(), "audio/wav")
	if err != nil {
		t.Fatalf("decodeAudio: %v", err)
	}
	if rate != 24000 || channels != 1 {
		t.Fatalf("got %d Hz / %d ch, want 24000 / 1", rate, channels)
	}
	if !bytes.Equal(got, pcm) {
		t.Fatal("decoded PCM does not match what was written")
	}
}

func TestDecodeAudioRejectsUnknownFormat(t *testing.T) {
	if _, _, _, err := decodeAudio([]byte{0x00, 0x01, 0x02, 0x03}, ""); err == nil {
		t.Fatal("expected an error for an unrecognized format")
	}
	if _, _, _, err := decodeAudio([]byte{0x00}, "audio/wav"); err == nil {
		t.Fatal("expected an error for a buffer too small to identify")
	}
}

// Enqueue must never block the RPC handler, and must reject a full queue rather
// than dropping the clip silently.
func TestPlaybackEnqueueIsNonBlocking(t *testing.T) {
	s := NewAudioPlaybackService()
	// Burn the once so Enqueue's `workerOnce.Do(go worker)` is a no-op: the
	// worker would open a real audio device, which CI has none of. Coupled to
	// Enqueue starting the worker through workerOnce; if that ever changes,
	// this and the test below need a different seam.
	s.workerOnce.Do(func() {})

	clip := []byte{0xFF, 0xFB, 0x00, 0x00}
	for i := 0; i < cap(s.queue); i++ {
		if err := s.Enqueue(clip, "audio/mp3"); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}
	if err := s.Enqueue(clip, "audio/mp3"); err == nil {
		t.Fatal("expected an error once the queue is full")
	}
	if err := s.Enqueue(nil, "audio/mp3"); err == nil {
		t.Fatal("expected an error for an empty buffer")
	}
}

// Stop must invalidate everything already queued, so a barge-in doesn't leave
// the worker with a backlog of stale sentences to speak.
func TestPlaybackStopInvalidatesQueuedClips(t *testing.T) {
	s := NewAudioPlaybackService()
	s.workerOnce.Do(func() {})

	clip := []byte{0xFF, 0xFB, 0x00, 0x00}
	for i := 0; i < 4; i++ {
		if err := s.Enqueue(clip, "audio/mp3"); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}
	before := s.generation.Load()
	s.Stop()

	if s.generation.Load() <= before {
		t.Fatal("expected Stop to bump the generation")
	}
	if got := len(s.queue); got != 0 {
		t.Fatalf("queue holds %d jobs after Stop, want 0", got)
	}
	// A clip queued after Stop carries the new generation and stays valid.
	if err := s.Enqueue(clip, "audio/mp3"); err != nil {
		t.Fatalf("enqueue after stop: %v", err)
	}
	job := <-s.queue
	if job.gen != s.generation.Load() {
		t.Fatalf("job gen = %d, want the current %d", job.gen, s.generation.Load())
	}
}

// writeDropOldest is the realtime path's producer: it cannot block the read
// loop, so an overflow has to cost the OLDEST audio. Every count must stay
// frame-aligned; an odd-sized drop byte-shifts every following sample, which is
// what turns speech into full-scale high-frequency static.
func TestPCMRingWriteDropOldestKeepsRoomWithoutDropping(t *testing.T) {
	rb := newTestRing(8, 2) // 32 bytes
	src := make([]byte, 16)
	for i := range src {
		src[i] = byte(i + 1)
	}

	written, dropped := rb.writeDropOldest(src)
	if written != len(src) || dropped != 0 {
		t.Fatalf("written = %d, dropped = %d; want %d, 0", written, dropped, len(src))
	}
	dst := make([]byte, 16)
	rb.read(dst)
	if !bytes.Equal(dst, src) {
		t.Fatalf("got %v, want %v", dst, src)
	}
}

func TestPCMRingWriteDropOldestEvictsOldestInOrder(t *testing.T) {
	rb := newTestRing(4, 2) // 16 bytes, frame = 4

	first := []byte{1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4}
	if n, d := rb.writeDropOldest(first); n != 16 || d != 0 {
		t.Fatalf("fill: written = %d, dropped = %d", n, d)
	}

	// Two more frames must evict the two oldest.
	next := []byte{5, 5, 5, 5, 6, 6, 6, 6}
	n, dropped := rb.writeDropOldest(next)
	if n != 8 {
		t.Fatalf("written = %d, want 8", n)
	}
	if dropped != 8 {
		t.Fatalf("dropped = %d, want 8", dropped)
	}
	assertRingFrameAligned(t, rb)

	dst := make([]byte, 16)
	got := rb.read(dst)
	want := []byte{3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6}
	if got != len(want) || !bytes.Equal(dst[:got], want) {
		t.Fatalf("got %v, want %v", dst[:got], want)
	}
}

// A write larger than the whole ring keeps the newest ring-full, still aligned.
func TestPCMRingWriteDropOldestHandlesOversizedWrite(t *testing.T) {
	rb := newTestRing(4, 2) // 16 bytes
	src := make([]byte, 40)
	for i := range src {
		src[i] = byte(i)
	}

	written, dropped := rb.writeDropOldest(src)
	if written != 16 {
		t.Fatalf("written = %d, want 16 (the whole capacity)", written)
	}
	if dropped != len(src)-16 {
		t.Fatalf("dropped = %d, want %d", dropped, len(src)-16)
	}
	assertRingFrameAligned(t, rb)

	dst := make([]byte, 16)
	rb.read(dst)
	if !bytes.Equal(dst, src[len(src)-16:]) {
		t.Fatalf("kept %v, want the newest %v", dst, src[len(src)-16:])
	}
}

// The realtime backlog cap used to be applied by advancing the read cursor by an
// arbitrary byte count. Hammer the eviction path with sizes that are not frame
// multiples and assert the cursors never leave a frame boundary.
func TestPCMRingEvictionNeverMisalignsFrames(t *testing.T) {
	rb := newTestRing(9, 2)  // 36 bytes, frame = 4
	chunk := make([]byte, 7) // deliberately not a frame multiple
	for i := range chunk {
		chunk[i] = byte(i)
	}
	scratch := make([]byte, 5) // nor is the read size

	for i := 0; i < 500; i++ {
		rb.writeDropOldest(chunk)
		assertRingFrameAligned(t, rb)
		if i%3 == 0 {
			if n := rb.read(scratch); n%rb.frame != 0 {
				t.Fatalf("read %d bytes, not a multiple of frame %d", n, rb.frame)
			}
			assertRingFrameAligned(t, rb)
		}
	}
}

func assertRingFrameAligned(t *testing.T, rb *pcmRing) {
	t.Helper()
	rb.mu.Lock()
	r, w, frame := rb.r, rb.w, rb.frame
	rb.mu.Unlock()
	if r%int64(frame) != 0 {
		t.Fatalf("read cursor %d is not frame-aligned (frame %d)", r, frame)
	}
	if w%int64(frame) != 0 {
		t.Fatalf("write cursor %d is not frame-aligned (frame %d)", w, frame)
	}
	if w < r {
		t.Fatalf("write cursor %d fell behind read cursor %d", w, r)
	}
}

// The realtime player's ring must be sized to the documented backlog, and its
// jitter cushion must fit inside it with room to spare.
func TestStreamRingSizing(t *testing.T) {
	rb := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	want := streamPlaybackSampleRate * 2 * streamBacklogSeconds
	if rb.capacity() != want {
		t.Fatalf("capacity = %d, want %d", rb.capacity(), want)
	}
	if jitterPrimeBytes >= rb.capacity() {
		t.Fatalf("jitter cushion %d does not fit in a %d byte ring", jitterPrimeBytes, rb.capacity())
	}
	if jitterPrimeBytes%rb.frame != 0 {
		t.Fatalf("jitter cushion %d is not a whole number of frames", jitterPrimeBytes)
	}
}

// An eviction that also wraps the end of the backing array is where an
// off-by-one in the two-segment copy would show up as scrambled audio.
func TestPCMRingWriteDropOldestWrapsCorrectly(t *testing.T) {
	rb := newTestRing(4, 1) // 8 bytes, frame = 2

	// Push the cursors most of the way round so the next write straddles the end.
	rb.write([]byte{9, 9, 9, 9, 9, 9})
	rb.read(make([]byte, 6))

	rb.writeDropOldest([]byte{1, 1, 2, 2, 3, 3, 4, 4}) // fills, wrapping
	written, dropped := rb.writeDropOldest([]byte{5, 5, 6, 6})
	if written != 4 || dropped != 4 {
		t.Fatalf("written = %d, dropped = %d; want 4, 4", written, dropped)
	}
	assertRingFrameAligned(t, rb)

	dst := make([]byte, 8)
	n := rb.read(dst)
	want := []byte{3, 3, 4, 4, 5, 5, 6, 6}
	if n != len(want) || !bytes.Equal(dst[:n], want) {
		t.Fatalf("got %v, want %v", dst[:n], want)
	}
}

// The realtime shape: a producer that never blocks (the read loop) against the
// audio thread. Whatever survives must be a contiguous, in-order run of what was
// produced. Evicting the oldest is allowed; scrambling or interleaving is not.
func TestPCMRingWriteDropOldestStaysContiguousUnderLoad(t *testing.T) {
	rb := newTestRing(32, 1) // 64 bytes
	const total = 4000

	src := make([]byte, total)
	for i := range src {
		src[i] = byte(i % 251)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for off := 0; off < len(src); off += 6 {
			end := off + 6
			if end > len(src) {
				end = len(src)
			}
			rb.writeDropOldest(src[off:end])
			// Pace the producer so the consumer actually interleaves. Without
			// this it finishes before the first read and the test proves
			// nothing.
			time.Sleep(50 * time.Microsecond)
		}
	}()

	dst := make([]byte, 10)
	read := 0
	readAt := 0 // how far into src the previous read reached
	producing := true
	deadline := time.Now().Add(30 * time.Second)
	for producing || rb.pending() > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after reading %d bytes", read)
		}
		select {
		case <-done:
			producing = false
		default:
		}
		n := rb.read(dst)
		if n == 0 {
			continue
		}
		// Each read must be a contiguous run of the source occurring at or
		// after where the previous read ended. Searched forward from readAt,
		// not from the start: the source repeats every 251 bytes, so a short
		// window matches in many places and only the ordering constraint makes
		// the check meaningful. Eviction may skip ahead; it may never go back.
		rel := bytes.Index(src[readAt:], dst[:n])
		if rel < 0 {
			t.Fatalf("read %v at/after offset %d is not a contiguous run of the source", dst[:n], readAt)
		}
		readAt += rel + n
		read += n
	}
	<-done
	assertRingFrameAligned(t, rb)
	// Without this the test passes vacuously if the consumer never won a read,
	// which is exactly what it did before this assertion was added.
	if read < rb.capacity() {
		t.Fatalf("only read %d bytes; the consumer never really ran", read)
	}
}

// drainWatch is what decides to release an output device that has died. It is
// pure state precisely so this can be pinned without an audio device.
func TestDrainWatchStallsOnlyWithoutProgress(t *testing.T) {
	var w drainWatch
	t0 := time.Now()
	const timeout = 1500 * time.Millisecond

	// A device that keeps consuming is never a stall, however long it runs.
	consumed := int64(0)
	for i := 0; i < 100; i++ {
		consumed += 960
		if w.observe(consumed, true, true, t0.Add(time.Duration(i)*time.Second), timeout) {
			t.Fatalf("healthy device reported stalled at step %d", i)
		}
	}

	// Progress stops. The clock runs from the LAST observed progress (t0+99s,
	// the final healthy sample), not from the first sample that noticed the
	// lack of it, so keep the steps realistic: the worker samples every 50 ms.
	frozen := consumed
	last := t0.Add(99 * time.Second)
	if w.observe(frozen, true, true, last.Add(50*time.Millisecond), timeout) {
		t.Fatal("stalled one tick after the last progress")
	}
	if w.observe(frozen, true, true, last.Add(timeout-time.Millisecond), timeout) {
		t.Fatal("stalled just before the timeout")
	}
	if !w.observe(frozen, true, true, last.Add(timeout), timeout) {
		t.Fatal("expected a stall once the timeout elapsed with no progress")
	}
}

// Nothing pending, or a device that has not been started, is not a stall: an
// empty ring is the normal idle state, and a device that has only just been
// opened has not had a chance to consume anything yet.
func TestDrainWatchIgnoresIdleAndUnstartedDevices(t *testing.T) {
	var w drainWatch
	t0 := time.Now()
	const timeout = time.Second

	for i := 0; i < 10; i++ {
		at := t0.Add(time.Duration(i) * time.Hour)
		if w.observe(0, false, true, at, timeout) {
			t.Fatal("an empty ring must never read as a stall")
		}
		if w.observe(0, true, false, at, timeout) {
			t.Fatal("an unstarted device must never read as a stall")
		}
	}
}

// A stall must not latch: once the device is replaced and starts consuming
// again, the watch has to go quiet.
func TestDrainWatchRecoversAfterReset(t *testing.T) {
	var w drainWatch
	t0 := time.Now()
	const timeout = time.Second

	w.observe(100, true, true, t0, timeout)
	if !w.observe(100, true, true, t0.Add(2*time.Second), timeout) {
		t.Fatal("expected a stall")
	}

	w.reset()
	if w.observe(100, true, true, t0.Add(3*time.Second), timeout) {
		t.Fatal("a reset watch must start its clock over, not re-report the stall")
	}
	if w.observe(200, true, true, t0.Add(4*time.Second), timeout) {
		t.Fatal("progress after a reset must clear the stall")
	}
}

// An idle gap (ring empties, then a new answer arrives) must not be mistaken
// for a stall just because `consumed` has not moved since the last sample.
func TestDrainWatchSurvivesAnIdleGap(t *testing.T) {
	var w drainWatch
	t0 := time.Now()
	const timeout = time.Second

	w.observe(5000, true, true, t0, timeout)
	// Ring drains; the worker keeps ticking through a long quiet stretch.
	for i := 0; i < 60; i++ {
		if w.observe(5000, false, true, t0.Add(time.Duration(i)*time.Second), timeout) {
			t.Fatal("an idle stretch must not report a stall")
		}
	}
	// New audio arrives; the device has not consumed any of it yet this tick.
	if w.observe(5000, true, true, t0.Add(60*time.Second), timeout) {
		t.Fatal("the first sample after an idle gap must only start the clock")
	}
}
