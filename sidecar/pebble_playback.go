package main

// Cross-platform audio playback for the pebble's voice loop.
//
// Mirrors pebble_audio.go (mic capture). The daemon synthesizes the LLM
// response via its existing TTS provider (edge-tts / ElevenLabs / Sarvam),
// pushes the encoded audio to the sidecar via the `pebble.play_audio` RPC,
// and the sidecar plays it through the system's default output device using
// miniaudio. With this in place the pebble speaks even when the dashboard
// isn't running — completing the sidecar-native voice loop (T21 capture,
// T22 stream-to-daemon, T23 STT+LLM, T24 playback).
//
// Format support:
//   - MP3 (edge-tts default, ElevenLabs default) — decoded via go-mp3
//   - WAV PCM s16 (Sarvam, raw daemon-side resampling) — header parsed inline
// The format is detected from the byte stream's magic header so the daemon
// can keep using whichever provider the user has configured.
//
// Device model: ONE long-lived output device fed from a fixed-size ring
// buffer, not a fresh device per clip. Streaming TTS enqueues one clip per
// sentence, and the old model opened/started/stopped/uninit'd a WASAPI or
// CoreAudio device every one to three seconds, audible as a click at every
// sentence boundary, and it ended each clip the moment the last bytes were
// *copied* into miniaudio rather than played, clipping the final phonemes.
//
// Real-time safety: the data callback is a Go function entered from the C
// audio thread through cgo. It cannot run during a GC stop-the-world, and this
// process allocates hard (screenshots, OCR, base64, MP3 decode). So:
//   - the render callback allocates nothing, takes one uncontended mutex and
//     does two memcpys: no decode, no growth, no syscalls;
//   - the ring is allocated once per device open, so the producer never
//     reallocates under the lock the audio thread needs;
//   - the device buffers ~120-160 ms (see playbackPeriodMs) instead of
//     miniaudio's 10 ms low-latency default, so a GC pause of that order is
//     absorbed instead of becoming an underrun. TTS playback has no use for
//     10 ms latency; the cost is that a barge-in leaves one buffer of already
//     handed-over audio to finish.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gen2brain/malgo"
	gomp3 "github.com/hajimehoshi/go-mp3"
)

// playbackPeriodMs is the device period, and the anti-underrun knob (see the
// real-time safety note above). It is per-OS because the two backends buffer
// differently: miniaudio's WASAPI backend gives you Periods x period of slack,
// but its CoreAudio backend sets the device buffer to ONE period and ignores
// the count. macOS therefore needs a much larger period to get comparable
// headroom, and TTS playback can afford it. CoreAudio clamps the request to the
// device's maximum buffer frame size (commonly 4096 frames), so 120 ms is a
// ceiling, not a promise: a 44.1 kHz clip lands nearer 93 ms.
var playbackPeriodMs uint32 = func() uint32 {
	if runtime.GOOS == "darwin" {
		return 120
	}
	return 40
}()

const (
	playbackPeriods = 4
	// playbackRingSeconds is how much decoded audio the ring holds. Big enough
	// that a whole sentence usually lands in one go (so the worker rarely waits
	// on the audio thread), small enough to stay under a megabyte at 44.1 kHz
	// stereo.
	playbackRingSeconds = 4
	// playbackTick paces the worker while there is audio in flight.
	playbackTick = 50 * time.Millisecond
	// playbackFeedPoll is how long the worker waits when the ring is full.
	// Shorter than one period so the ring is topped up promptly.
	playbackFeedPoll = 10 * time.Millisecond
	// playbackIdleAnnounce is the quiet time after the ring drains before we
	// tell the wake listener that JARVIS has stopped speaking. It has to
	// outlast both the device's own buffered audio and the gap
	// between two streamed sentences (synthesizing the next one takes
	// 300-800 ms), or the mic re-opens mid-answer and hears JARVIS.
	playbackIdleAnnounce = 1200 * time.Millisecond
	// playbackIdleClose releases the output device after a conversation goes
	// quiet, so the sidecar isn't holding the endpoint open forever. One
	// open/close per burst of speech instead of one per sentence.
	playbackIdleClose = 30 * time.Second
	// playbackStallTimeout is how long the ring may hold audio that the device
	// is not taking before we call the device dead. The callback fires once per
	// period, so any healthy device makes progress many times over within this.
	playbackStallTimeout = 1500 * time.Millisecond
	// playbackFeedChunk bounds how much the worker copies into the ring under
	// the ring's mutex in one go, so the audio thread never waits on a
	// multi-hundred-kilobyte memcpy.
	playbackFeedChunk = 32 * 1024
)

// pcmRing is a fixed-capacity byte ring holding interleaved PCM s16 frames.
// Reads happen on the audio thread, writes on the playback worker. Every count
// is aligned to a whole frame so an underrun can never leave the stream
// half-way through one.
type pcmRing struct {
	mu    sync.Mutex
	buf   []byte
	r, w  int64 // absolute byte positions; live = w-r, both always frame-aligned
	frame int   // bytes per frame (channels * 2)
}

// newPCMRing sizes a ring to hold `seconds` of audio in the given format. The
// capacity is a whole number of frames so wrapping preserves frame alignment.
func newPCMRing(sampleRate, channels, seconds int) *pcmRing {
	frame := channels * 2
	if frame < 2 {
		frame = 2 // never zero: read/write take `n % frame` and index `% len(buf)`
	}
	frames := sampleRate * seconds
	if frames < 1 {
		frames = 1
	}
	return &pcmRing{buf: make([]byte, frames*frame), frame: frame}
}

// read copies up to len(dst) bytes of pending audio into dst and returns the
// count, truncated to a whole number of frames. Audio-thread hot path: no
// allocation, no blocking, two memcpys.
func (rb *pcmRing) read(dst []byte) int {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	n := int(rb.w - rb.r)
	if n > len(dst) {
		n = len(dst)
	}
	n -= n % rb.frame
	if n <= 0 {
		return 0
	}
	off := int(rb.r % int64(len(rb.buf)))
	copied := copy(dst[:n], rb.buf[off:])
	if copied < n {
		copied += copy(dst[copied:n], rb.buf[:n-copied])
	}
	rb.r += int64(copied)
	return copied
}

// write copies as much of src as currently fits and returns the count,
// truncated to a whole number of frames. Never blocks; the caller retries.
func (rb *pcmRing) write(src []byte) int {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	free := len(rb.buf) - int(rb.w-rb.r)
	n := len(src)
	if n > free {
		n = free
	}
	n -= n % rb.frame
	if n <= 0 {
		return 0
	}
	off := int(rb.w % int64(len(rb.buf)))
	copied := copy(rb.buf[off:], src[:n])
	if copied < n {
		copied += copy(rb.buf, src[copied:n])
	}
	rb.w += int64(copied)
	return copied
}

// writeDropOldest copies src into the ring, dropping the oldest pending audio
// when there isn't room. Returns how many bytes went in and how many older
// bytes were dropped to make space. Used by a producer that cannot block (the
// realtime read loop): a stalled device must cost old audio, not a stalled
// WebSocket.
//
// Both counts are whole frames. An odd-sized drop would byte-shift every
// following sample, which is precisely the misalignment that turns speech into
// full-scale high-frequency static.
func (rb *pcmRing) writeDropOldest(src []byte) (written, dropped int) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	n := len(src) - len(src)%rb.frame
	// More than the ring can ever hold: keep the newest ring-full of it.
	if n > len(rb.buf) {
		skip := n - len(rb.buf)
		src = src[skip:]
		n = len(rb.buf)
		dropped += skip
	}
	if n <= 0 {
		return 0, dropped
	}

	// Capacity and the live span are both frame-aligned, so the shortfall is
	// too; the rounding below is belt and braces.
	if free := len(rb.buf) - int(rb.w-rb.r); n > free {
		need := n - free
		if rem := need % rb.frame; rem != 0 {
			need += rb.frame - rem
		}
		if live := int(rb.w - rb.r); need > live {
			need = live
		}
		rb.r += int64(need)
		dropped += need
	}

	off := int(rb.w % int64(len(rb.buf)))
	copied := copy(rb.buf[off:], src[:n])
	if copied < n {
		copied += copy(rb.buf, src[copied:n])
	}
	rb.w += int64(copied)
	return copied, dropped
}

// capacity is the ring's fixed size in bytes. Set at construction and never
// changed, so this needs no lock.
func (rb *pcmRing) capacity() int { return len(rb.buf) }

// progress samples, under ONE lock acquisition, how many bytes the reader has
// taken and whether any are still waiting. Taken together they tell "the device
// is draining" from "the device has stopped draining", which is the only way to
// notice a backend-initiated stop: malgo surfaces one only through a Stop
// callback, and a dead device otherwise looks exactly like a busy one.
func (rb *pcmRing) progress() (consumed int64, pending bool) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return rb.r, rb.w > rb.r
}

// pending reports how many bytes are still waiting to be rendered.
func (rb *pcmRing) pending() int {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return int(rb.w - rb.r)
}

// flush drops everything not yet rendered (barge-in).
func (rb *pcmRing) flush() {
	rb.mu.Lock()
	rb.r = rb.w
	rb.mu.Unlock()
}

// drainWatch decides whether the output device has stopped consuming the ring.
// Pure state with no clock and no locks of its own, so the decision that
// releases a device can be tested without one.
//
// It exists because a device can die silently: the endpoint goes away (Bluetooth
// headphones disconnecting mid-answer is the common one) or the backend stops it
// under us, and malgo reports neither. A dead device looks exactly like a busy
// one, and left alone it pins the worker's idle timer, so notifyPlayState(false)
// never fires and the wake listener stays suppressed: JARVIS goes deaf.
type drainWatch struct {
	lastConsumed int64
	lastProgress time.Time
	armed        bool
}

// observe folds in one sample and reports whether the device should be
// considered dead. Nothing pending, or a device that has not been started yet,
// is not a stall: both disarm the watch.
func (w *drainWatch) observe(consumed int64, pending, started bool, now time.Time, timeout time.Duration) bool {
	if !pending || !started {
		w.armed = false
		return false
	}
	if !w.armed || consumed != w.lastConsumed {
		w.armed = true
		w.lastConsumed = consumed
		w.lastProgress = now
		return false
	}
	return now.Sub(w.lastProgress) >= timeout
}

func (w *drainWatch) reset() { w.armed = false }

// playbackJob is a single clip waiting in the queue. The generation number
// lets Stop() invalidate everything queued before the call without needing
// to drain the channel atomically.
type playbackJob struct {
	audio []byte
	mime  string
	gen   int64
}

// AudioPlaybackService owns one malgo playback context, one long-lived output
// device and a single background worker that drains a queue of clips into that
// device's ring. Streaming TTS (T17e) enqueues one clip per sentence as the LLM
// streams; the queue model means clips play seamlessly without the daemon
// having to wait for each clip's playback to finish before dispatching the
// next, and the shared device means there is no gap or click between them.
type AudioPlaybackService struct {
	ctxMu sync.Mutex
	ctx   *malgo.AllocatedContext

	queue      chan playbackJob
	workerOnce sync.Once
	generation atomic.Int64

	// devMu guards the device and the ring it feeds. The audio callback closes
	// over the ring directly and never takes devMu, so closing the device (which
	// waits for the audio thread) can't deadlock against a callback waiting for
	// the lock.
	devMu       sync.Mutex
	dev         *malgo.Device
	ring        *pcmRing
	devRate     int
	devChannels int
	devStarted  bool

	onPlayStateMu     sync.RWMutex
	onPlayStateChange func(playing bool)

	// onClip fires once per clip actually rendered. onPlayStateChange only
	// edges (once at the start of a burst, once when it ends), which is the
	// right shape for a paired suppress/release but useless for a deadline: an
	// answer longer than the deadline would expire mid-sentence. Anything
	// time-bounded hangs off this instead.
	onClipMu sync.RWMutex
	onClip   func()
}

func NewAudioPlaybackService() *AudioPlaybackService {
	return &AudioPlaybackService{
		queue: make(chan playbackJob, 32),
	}
}

// Enqueue adds a clip to the playback queue. The queue worker drains
// clips back-to-back so streaming-TTS sentence chunks play seamlessly.
// Idempotent and fast — does NOT block on actual playback.
func (s *AudioPlaybackService) Enqueue(audio []byte, mimeHint string) error {
	if len(audio) == 0 {
		return fmt.Errorf("empty audio buffer")
	}
	s.workerOnce.Do(func() { go s.worker() })
	job := playbackJob{audio: audio, mime: mimeHint, gen: s.generation.Load()}
	select {
	case s.queue <- job:
		return nil
	default:
		return fmt.Errorf("playback queue full")
	}
}

// Play is a thin alias for Enqueue kept for backwards-compat with the
// existing pebble.play_audio RPC handler. Returns immediately once the
// clip is queued.
func (s *AudioPlaybackService) Play(audio []byte, mimeHint string) error {
	return s.Enqueue(audio, mimeHint)
}

// worker drains the playback queue into the output device's ring. It also owns
// the device's lifecycle: opened on the first clip that needs it, released once
// the conversation has been quiet for a while.
func (s *AudioPlaybackService) worker() {
	announced := false
	lastAudio := time.Now()
	// Catches the stall shape render cannot: a partly-full ring it has already
	// returned from, i.e. the endpoint dying during the LAST sentence of an
	// answer. render watches the other shape (a ring too full to accept more).
	var watch drainWatch

	for {
		// Nothing playing and no device to release: there is nothing to poll
		// for, so wait on the queue instead of spinning.
		tick := playbackTick
		if !announced && !s.deviceOpen() {
			tick = time.Hour
		}

		select {
		case job, ok := <-s.queue:
			if !ok {
				if announced {
					s.notifyPlayState(false)
				}
				s.closeDevice("queue closed")
				return
			}
			// Skip jobs from a generation older than the current one
			// (Stop() invalidated everything queued before the call).
			if job.gen != s.generation.Load() {
				continue
			}
			if !announced {
				s.notifyPlayState(true)
				announced = true
			}
			s.notifyClip()
			if err := s.render(job); err != nil {
				log.Printf("[playback] error: %v", err)
			}
			lastAudio = time.Now()

		case <-time.After(tick):
			consumed, pending, started := s.drainProgress()
			now := time.Now()
			if watch.observe(consumed, pending, started, now, playbackStallTimeout) {
				log.Printf("[playback] device stopped draining with %d bytes pending, releasing it", s.pending())
				s.closeDevice("stalled")
				watch.reset()
				continue
			}
			if pending {
				lastAudio = now
				continue
			}
			idle := time.Since(lastAudio)
			if announced && idle >= playbackIdleAnnounce {
				s.notifyPlayState(false)
				announced = false
			}
			if !announced && idle >= playbackIdleClose {
				s.closeDevice("idle")
			}
		}
	}
}

// render decodes one clip and feeds it to the output device, waiting on the
// audio thread whenever the ring is full. Returns as soon as the last byte is
// in the ring; the worker's idle accounting, not this function, decides when
// playback has actually finished.
func (s *AudioPlaybackService) render(job playbackJob) error {
	pcm, sampleRate, channels, err := decodeAudio(job.audio, job.mime)
	if err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if len(pcm) == 0 {
		return nil
	}
	if sampleRate <= 0 || channels <= 0 {
		return fmt.Errorf("decode: nonsensical format (%d Hz, %d channels)", sampleRate, channels)
	}

	ring, err := s.deviceFor(sampleRate, channels)
	if err != nil {
		return err
	}

	// Same stall watch the worker runs, on the other shape: here the ring is too
	// full to accept more. Watching consumption rather than wall-clock keeps the
	// two paths to the same 1.5 s verdict; the old byte-based deadline was the
	// clip's own duration plus three seconds, so a dead device swallowed several
	// sentences before anyone noticed.
	var watch drainWatch

	for off := 0; off < len(pcm); {
		if job.gen != s.generation.Load() {
			return nil // barge-in: abandon the rest of this clip
		}
		end := off + playbackFeedChunk
		if end > len(pcm) {
			end = len(pcm)
		}
		n := ring.write(pcm[off:end])
		if n > 0 {
			off += n
			// A barge-in can land between the check above and this write, which
			// would commit a whole chunk of stale audio just after Stop()
			// flushed the ring. Re-check and undo it: a chunk is a third of a
			// second of speech, which is very audible after "stop".
			if job.gen != s.generation.Load() {
				ring.flush()
				return nil
			}
			// Start on the first bytes in, not at open: the device would
			// otherwise render its first buffer from an empty ring and put that
			// much silence in front of every answer.
			if err := s.startDevice(); err != nil {
				return err
			}
			watch.reset()
			continue
		}
		// Ring full. Either the device is draining and we simply have to wait,
		// or it has died and we must let it go rather than hand the same dead
		// device to every later clip.
		consumed, pending, started := s.drainProgress()
		if watch.observe(consumed, pending, started, time.Now(), playbackStallTimeout) {
			log.Printf("[playback] device stopped draining, dropping %d of %d bytes and releasing it",
				len(pcm)-off, len(pcm))
			s.closeDevice("stalled")
			return nil
		}
		time.Sleep(playbackFeedPoll)
	}
	return nil
}

// playbackDeviceLatency is roughly how much audio the open device holds beyond
// the ring. WASAPI buffers Periods x period; CoreAudio buffers one period.
func playbackDeviceLatency() time.Duration {
	periods := playbackPeriods
	if runtime.GOOS == "darwin" {
		periods = 1
	}
	return time.Duration(playbackPeriodMs) * time.Duration(periods) * time.Millisecond
}

// deviceFor returns the ring feeding an output device in the given format,
// opening one (or replacing a differently-formatted one) as needed. Only the
// worker calls this.
func (s *AudioPlaybackService) deviceFor(sampleRate, channels int) (*pcmRing, error) {
	s.devMu.Lock()
	if s.dev != nil && s.devRate == sampleRate && s.devChannels == channels {
		ring := s.ring
		s.devMu.Unlock()
		return ring, nil
	}
	reopen := s.dev != nil
	s.devMu.Unlock()

	// A format change mid-conversation (the user switched TTS provider) has to
	// let the current clip finish before we pull the device out from under it.
	if reopen {
		s.waitDrained(playbackRingSeconds*time.Second + 2*time.Second)
		// waitDrained only empties the ring; the device still holds a buffer's
		// worth. miniaudio's WASAPI backend drains that on stop, but its
		// CoreAudio backend does not, so without this the tail of the last
		// sentence in the old format is clipped on macOS.
		time.Sleep(playbackDeviceLatency())
		s.closeDevice("format change")
	}
	return s.openDevice(sampleRate, channels)
}

func (s *AudioPlaybackService) openDevice(sampleRate, channels int) (*pcmRing, error) {
	s.ctxMu.Lock()
	if s.ctx == nil {
		ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, func(message string) {
			log.Printf("[playback] miniaudio: %s", message)
		})
		if err != nil {
			s.ctxMu.Unlock()
			return nil, fmt.Errorf("malgo.InitContext: %w", err)
		}
		s.ctx = ctx
	}
	ctx := s.ctx
	s.ctxMu.Unlock()

	ring := newPCMRing(sampleRate, channels, playbackRingSeconds)
	frameBytes := channels * 2

	deviceConfig := malgo.DefaultDeviceConfig(malgo.Playback)
	deviceConfig.Playback.Format = malgo.FormatS16
	deviceConfig.Playback.Channels = uint32(channels)
	deviceConfig.SampleRate = uint32(sampleRate)
	deviceConfig.PeriodSizeInMilliseconds = playbackPeriodMs
	deviceConfig.Periods = playbackPeriods
	deviceConfig.Alsa.NoMMap = 1

	onSend := func(output, _ []byte, frameCount uint32) {
		need := int(frameCount) * frameBytes
		if need > len(output) {
			need = len(output)
		}
		n := ring.read(output[:need])
		for i := n; i < need; i++ {
			output[i] = 0
		}
	}

	device, err := malgo.InitDevice(ctx.Context, deviceConfig, malgo.DeviceCallbacks{Data: onSend})
	if err != nil {
		return nil, fmt.Errorf("malgo.InitDevice: %w", err)
	}

	s.devMu.Lock()
	s.dev = device
	s.ring = ring
	s.devRate = sampleRate
	s.devChannels = channels
	s.devStarted = false
	s.devMu.Unlock()

	log.Printf("[playback] output device open (PCM s16 %dch %d Hz, %dx%dms buffer)",
		channels, sampleRate, playbackPeriods, playbackPeriodMs)
	return ring, nil
}

// startDevice starts the open device if it isn't running yet. Idempotent and
// cheap after the first call.
func (s *AudioPlaybackService) startDevice() error {
	s.devMu.Lock()
	if s.dev == nil || s.devStarted {
		s.devMu.Unlock()
		return nil
	}
	dev := s.dev
	s.devMu.Unlock()

	// Started outside devMu: ma_device_start blocks until the backend is
	// actually running and pulls the first callback, and barge-in (Stop) takes
	// devMu. Safe without the lock because the device's whole lifecycle
	// (open, start, close) runs on the single worker goroutine; nothing can
	// swap or free it underneath us here.
	err := dev.Start()
	if err == nil {
		s.devMu.Lock()
		s.devStarted = true
		s.devMu.Unlock()
		return nil
	}

	// Drop the device rather than leave an open-but-silent one behind: the next
	// clip would feed a ring nothing is draining, stall out and be discarded.
	// Releasing it here means the next clip gets a fresh device.
	s.closeDevice("failed to start")
	return fmt.Errorf("device.Start: %w", err)
}

// closeDevice stops and releases the output device. Safe to call when none is
// open. Never called from the audio thread, and the callback does not take
// devMu, so the stop can't deadlock against it.
func (s *AudioPlaybackService) closeDevice(reason string) {
	s.devMu.Lock()
	dev, ring := s.dev, s.ring
	s.dev, s.ring = nil, nil
	s.devStarted = false
	s.devRate, s.devChannels = 0, 0
	s.devMu.Unlock()

	if ring != nil {
		ring.flush()
	}
	if dev != nil {
		_ = dev.Stop()
		dev.Uninit()
		log.Printf("[playback] output device released (%s)", reason)
	}
}

// deviceOpen reports whether an output device is currently held.
func (s *AudioPlaybackService) deviceOpen() bool {
	s.devMu.Lock()
	defer s.devMu.Unlock()
	return s.dev != nil
}

// pending is how many bytes are still waiting to be rendered.
func (s *AudioPlaybackService) pending() int {
	s.devMu.Lock()
	ring := s.ring
	s.devMu.Unlock()
	if ring == nil {
		return 0
	}
	return ring.pending()
}

// drainProgress samples the device's consumption: how many bytes it has taken so
// far, whether any are still waiting, and whether it has actually been started
// (a device that hasn't been started yet isn't stalled, it just hasn't begun).
// The ring pair comes from a single lock acquisition so the two halves agree;
// `started` and the ring itself come from one devMu acquisition, for the same
// reason.
func (s *AudioPlaybackService) drainProgress() (consumed int64, pending, started bool) {
	s.devMu.Lock()
	ring, started := s.ring, s.devStarted
	s.devMu.Unlock()
	if ring == nil {
		return 0, false, started
	}
	consumed, pending = ring.progress()
	return consumed, pending, started
}

// waitDrained blocks until the ring is empty (or the timeout elapses), so a
// device swap doesn't cut the clip that is still playing.
func (s *AudioPlaybackService) waitDrained(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	var watch drainWatch
	for {
		consumed, pending, started := s.drainProgress()
		if !pending {
			return
		}
		now := time.Now()
		// Don't sit out the full timeout for a device that has died: there is
		// nothing left to drain.
		if watch.observe(consumed, pending, started, now, playbackStallTimeout) {
			return
		}
		if now.After(deadline) {
			return
		}
		time.Sleep(playbackFeedPoll)
	}
}

// Stop bumps the generation counter (so already-queued clips are skipped by the
// worker and an in-flight one abandons the rest of its feed) and drops
// everything already handed to the device. The device's own buffer still has up
// to one buffer-length of audio committed to the hardware, so a barge-in fades
// out over ~160 ms rather than instantly. Idempotent.
func (s *AudioPlaybackService) Stop() {
	s.generation.Add(1)
	// Drain queue eagerly so the worker doesn't churn through stale
	// jobs even just to skip them.
drain:
	for {
		select {
		case <-s.queue:
		default:
			break drain
		}
	}
	s.devMu.Lock()
	ring := s.ring
	s.devMu.Unlock()
	if ring != nil {
		ring.flush()
	}
}

// SetPlayStateListener registers a callback that fires with true when
// playback starts and false when it ends. Used by the wake listener to
// gate captures during TTS so JARVIS's voice through the speakers doesn't
// trigger a self-wake. Pass nil to clear.
func (s *AudioPlaybackService) SetPlayStateListener(cb func(playing bool)) {
	s.onPlayStateMu.Lock()
	s.onPlayStateChange = cb
	s.onPlayStateMu.Unlock()
}

// SetClipListener registers a callback that fires once per clip rendered.
// Pass nil to clear.
func (s *AudioPlaybackService) SetClipListener(cb func()) {
	s.onClipMu.Lock()
	s.onClip = cb
	s.onClipMu.Unlock()
}

func (s *AudioPlaybackService) notifyClip() {
	s.onClipMu.RLock()
	cb := s.onClip
	s.onClipMu.RUnlock()
	if cb != nil {
		cb()
	}
}

func (s *AudioPlaybackService) notifyPlayState(playing bool) {
	s.onPlayStateMu.RLock()
	cb := s.onPlayStateChange
	s.onPlayStateMu.RUnlock()
	if cb != nil {
		cb(playing)
	}
}

// decodeAudio dispatches to the right decoder based on the byte stream's
// magic header (or, as a hint, the mime type). Returns interleaved PCM s16
// little-endian + sample rate + channel count.
func decodeAudio(buf []byte, mimeHint string) ([]byte, int, int, error) {
	if len(buf) < 4 {
		return nil, 0, 0, errors.New("buffer too small to identify format")
	}
	// "RIFF" → WAV
	if buf[0] == 'R' && buf[1] == 'I' && buf[2] == 'F' && buf[3] == 'F' {
		return decodeWAV(buf)
	}
	// "ID3" or MP3 sync word (0xFFE / 0xFFF) → MP3
	if (buf[0] == 'I' && buf[1] == 'D' && buf[2] == '3') ||
		(buf[0] == 0xFF && (buf[1]&0xE0) == 0xE0) {
		return decodeMP3(buf)
	}
	// Fall back to mime hint.
	switch mimeHint {
	case "audio/mp3", "audio/mpeg":
		return decodeMP3(buf)
	case "audio/wav", "audio/wave", "audio/x-wav":
		return decodeWAV(buf)
	}
	return nil, 0, 0, fmt.Errorf("unrecognized audio format (mime=%q)", mimeHint)
}

// decodeMP3 reads an MP3 stream and returns interleaved PCM s16 LE plus
// the stream's sample rate. go-mp3 always emits stereo s16 LE, so the
// channel count is fixed at 2.
func decodeMP3(buf []byte) ([]byte, int, int, error) {
	dec, err := gomp3.NewDecoder(bytes.NewReader(buf))
	if err != nil {
		return nil, 0, 0, err
	}
	pcm, err := io.ReadAll(dec)
	if err != nil {
		return nil, 0, 0, err
	}
	return pcm, dec.SampleRate(), 2, nil
}

// decodeWAV parses a minimal RIFF/WAVE PCM s16 file. Returns the raw
// data chunk + sample rate + channel count. Only supports the common
// case (PCM, 16-bit) since that's what every TTS provider we care about
// emits when not using MP3.
func decodeWAV(buf []byte) ([]byte, int, int, error) {
	if len(buf) < 44 {
		return nil, 0, 0, errors.New("wav: too small")
	}
	if string(buf[0:4]) != "RIFF" || string(buf[8:12]) != "WAVE" {
		return nil, 0, 0, errors.New("wav: bad RIFF header")
	}
	// Walk subchunks until we find "fmt " and "data".
	var sampleRate uint32
	var channels uint16
	var bitsPerSample uint16
	var data []byte
	pos := 12
	for pos+8 <= len(buf) {
		id := string(buf[pos : pos+4])
		size := binary.LittleEndian.Uint32(buf[pos+4 : pos+8])
		pos += 8
		if pos+int(size) > len(buf) {
			return nil, 0, 0, errors.New("wav: truncated chunk")
		}
		body := buf[pos : pos+int(size)]
		pos += int(size)
		// RIFF chunks are word-aligned: an odd-sized chunk is followed by a
		// 1-byte pad NOT counted in `size`. Skip it, or a LIST/INFO/fact chunk
		// of odd length before `data` desyncs every later chunk header.
		if size%2 == 1 {
			pos++
		}
		switch id {
		case "fmt ":
			if len(body) < 16 {
				return nil, 0, 0, errors.New("wav: bad fmt chunk")
			}
			channels = binary.LittleEndian.Uint16(body[2:4])
			sampleRate = binary.LittleEndian.Uint32(body[4:8])
			bitsPerSample = binary.LittleEndian.Uint16(body[14:16])
		case "data":
			data = body
		}
	}
	if sampleRate == 0 || channels == 0 || data == nil {
		return nil, 0, 0, errors.New("wav: missing fmt/data chunks")
	}
	if bitsPerSample != 16 {
		return nil, 0, 0, fmt.Errorf("wav: only 16-bit PCM supported (got %d)", bitsPerSample)
	}
	return data, int(sampleRate), int(channels), nil
}
