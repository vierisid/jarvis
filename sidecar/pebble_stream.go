package main

// Low-latency streaming PCM playback for the pebble's realtime voice loop.
//
// Unlike AudioPlaybackService (which accepts complete MP3/WAV containers and
// decodes them), this feeds one persistent output device raw PCM s16/mono/24 kHz
// frames as they stream in from the daemon's realtime session. The device's
// render callback drains a playout buffer; underruns play silence and rebuild
// the cushion. Barge-in flushes instantly.
//
// Frames arrive via the readLoop's `pebble.play_pcm` fast-path (in receive
// order) and are appended with Write; the audio thread drains them in the
// render callback.
//
// Real-time safety: the playout buffer is a pcmRing (see pebble_playback.go),
// allocated once at Start. It used to be a plain slice that `append` grew up to
// a 2.88 MB backlog while holding the very mutex the render callback needs, so
// a single realloc could park the audio thread for the length of a multi-
// megabyte copy. It also trimmed that backlog by an arbitrary byte count, which
// could leave the read cursor on an odd offset and byte-shift every following
// sample into full-scale static. The ring fixes both: no growth, and every
// count is frame-aligned.

import (
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gen2brain/malgo"
)

const streamPlaybackSampleRate = 24000 // matches the realtime session output rate

// streamPeriodMs / streamPeriods size the device buffer. Larger than
// miniaudio's 10 ms low-latency default so a GC pause doesn't underrun the
// device, but smaller than the clip player's, because this path is barge-in
// sensitive: whatever is committed to the hardware still plays after a Flush.
//
// Per-OS for the same reason as playbackPeriodMs: miniaudio's WASAPI backend
// buffers Periods x period, its CoreAudio backend buffers one period and
// ignores the count. Both land at roughly 60-80 ms, comfortably under the
// 120 ms jitter cushion sitting above them.
const streamPeriods = 4

var streamPeriodMs uint32 = func() uint32 {
	if runtime.GOOS == "darwin" {
		return 60
	}
	return 20
}()

// streamBacklogSeconds bounds only a genuinely STALLED device (not draining).
// It must be far larger than any real answer: OpenAI bursts a long answer's
// audio faster than real-time, so the queue legitimately holds many seconds of
// not-yet-played PCM. An earlier 5 s cap dropped the middle of long answers,
// which made playback chunky.
const streamBacklogSeconds = 60

// The playout cushion: the render callback outputs silence until this much PCM
// is buffered, then drains. It absorbs delivery jitter so brief gaps don't drain
// the device to silence and stutter the voice.
//
// It is ADAPTIVE because the delivery path is not fixed. A brain running on the
// same machine delivers audio in bursts far ahead of real time and 120 ms is
// plenty; a hosted brain sends every frame across the internet, where 120 ms of
// jitter is ordinary. Too small a cushion there means a continuous cycle of
// underrun, re-prime, underrun, which is heard as choppy speech with a click at
// every seam. So: start at the base, widen by a step on every mid-response
// underrun, cap it, and start each session over at the base.
const (
	streamCushionBaseMs = 120
	streamCushionStepMs = 80
	streamCushionMaxMs  = 600

	jitterPrimeBytes  = streamPlaybackSampleRate * 2 * streamCushionBaseMs / 1000
	streamCushionStep = streamPlaybackSampleRate * 2 * streamCushionStepMs / 1000
	streamCushionMax  = streamPlaybackSampleRate * 2 * streamCushionMaxMs / 1000
)

// streamInputIdle is how long without a new frame means the response is over
// rather than merely late. It separates "hold for the cushion" from "this is
// the tail, play it out": without the distinction the last partial buffer of
// every answer is stranded in the ring and plays as a stale fragment in front
// of the NEXT answer.
//
// It sits just under the base cushion on purpose. With delivery paced near real
// time the ring drains about a cushion's worth after the last frame, so a
// longer window would classify the end of every response as a mid-response
// underrun and hold the tail back for the difference. Getting it wrong the
// other way is cheap now that the cushion only widens when audio resumes: a
// genuine gap this long just plays out what is buffered and re-primes.
const streamInputIdle = 100 * time.Millisecond

// echoHangover keeps the mic gated briefly after the output buffer drains, so
// the tail of the assistant's audio (and its acoustic echo) doesn't leak back in.
const echoHangover = 300 * time.Millisecond

// The realtime controller builds a FRESH AudioStreamPlayer for every session,
// so a per-player miniaudio context would leak one context (and its backend
// handles) per conversation. Tearing one down per session is the other obvious
// answer and is worse: ma_context_uninit calls CoUninitialize on WASAPI, and a
// goroutine is not pinned to the OS thread that initialized COM. So there is one
// context for the life of the process, created on first use and never freed.
var (
	streamCtxOnce sync.Once
	streamCtx     *malgo.AllocatedContext
	streamCtxErr  error
)

func streamPlaybackContext() (*malgo.AllocatedContext, error) {
	streamCtxOnce.Do(func() {
		streamCtx, streamCtxErr = malgo.InitContext(nil, malgo.ContextConfig{}, func(m string) {
			log.Printf("[stream] miniaudio: %s", m)
		})
	})
	return streamCtx, streamCtxErr
}

// AudioStreamPlayer owns a persistent malgo playback device plus the ring of
// pending PCM (s16 mono) that feeds it. Safe for concurrent Write / Flush /
// Stop / IsActive.
type AudioStreamPlayer struct {
	// lifecycleMu serializes Start and Stop. Held across device init/teardown,
	// which can take tens of milliseconds, so the audio threads must never
	// touch it.
	lifecycleMu sync.Mutex

	// mu guards the fields below. Every critical section under it is a handful
	// of instructions: IsActive runs on the CAPTURE audio thread (it is the
	// realtime mic gate), so parking there would underrun the microphone.
	mu          sync.Mutex
	device      *malgo.Device
	onSend      malgo.DataProc // built by Start, used when ensureDevice opens
	ring        *pcmRing
	started     bool
	writes      int64     // diagnostic: count of inbound PCM frames
	lastWrite   time.Time // when the most recent output frame arrived (echo gate)
	lastDropLog time.Time // rate-limits the backlog-full line
	carry       [1]byte   // half a sample held back from a previous frame
	carryLen    int

	// The fields below are read or written by the render callback, so they are
	// atomics: the callback runs on the audio thread and must not take mu.
	//
	// priming is the playout buffer state: while set, the callback outputs
	// silence and lets the cushion build. cushion is the current target depth in
	// bytes. lastWriteNanos is when the last frame arrived, which is how the
	// callback tells a late frame from the end of the response. underruns is a
	// diagnostic, reported from Write (never logged on the audio thread).
	priming        atomic.Bool
	cushion        atomic.Int64
	lastWriteNanos atomic.Int64
	underruns      atomic.Int64
	// deviceFailed latches a failed open so the read loop tries once per
	// session rather than once per frame. Cleared by Start and by a success.
	deviceFailed atomic.Bool
	// underrunPending records that the render callback ran short. The cushion
	// only widens when audio actually RESUMES afterwards (see Write): a
	// shortfall with nothing following it is the end of a response, not jitter,
	// and widening on those ratchets playout latency up over a conversation.
	underrunPending atomic.Bool
}

// IsActive reports whether the assistant is currently producing output audio:
// true while the buffer holds samples, or within the hangover after the last
// frame. The realtime controller uses this to gate the mic (half-duplex echo
// suppression when there's no native AEC, e.g. on speakers).
func (p *AudioStreamPlayer) IsActive() bool {
	p.mu.Lock()
	ring, last := p.ring, p.lastWrite
	p.mu.Unlock()

	if ring != nil && ring.pending() > 0 {
		return true
	}
	return !last.IsZero() && time.Since(last) < echoHangover
}

func NewAudioStreamPlayer() *AudioStreamPlayer { return &AudioStreamPlayer{} }

// Start opens the persistent output device. Idempotent.
func (p *AudioStreamPlayer) Start() error {
	p.lifecycleMu.Lock()
	defer p.lifecycleMu.Unlock()

	p.mu.Lock()
	started := p.started
	p.mu.Unlock()
	if started {
		return nil
	}

	// Fail fast if audio is unusable at all, but do NOT open the device here:
	// see ensureDevice.
	if _, err := streamPlaybackContext(); err != nil {
		return err
	}

	// One allocation for the whole session. The callback closes over this ring
	// directly rather than reading p.ring, so it never needs p.mu and Stop()
	// can tear the device down without deadlocking against an in-flight
	// callback waiting for a lock Stop holds.
	ring := newPCMRing(streamPlaybackSampleRate, 1, streamBacklogSeconds)
	p.priming.Store(true)
	p.cushion.Store(jitterPrimeBytes) // each session re-learns the network
	p.underruns.Store(0)
	p.lastWriteNanos.Store(0)
	p.deviceFailed.Store(false)
	p.underrunPending.Store(false)

	cfg := malgo.DefaultDeviceConfig(malgo.Playback)
	cfg.Playback.Format = malgo.FormatS16
	cfg.Playback.Channels = 1
	cfg.SampleRate = streamPlaybackSampleRate
	cfg.PeriodSizeInMilliseconds = streamPeriodMs
	cfg.Periods = streamPeriods
	cfg.Alsa.NoMMap = 1

	onSend := func(output, _ []byte, frameCount uint32) {
		need := int(frameCount) * 2 // s16 mono = 2 bytes/frame
		if need > len(output) {
			need = len(output)
		}
		p.render(output[:need], ring)
	}

	p.mu.Lock()
	p.ring = ring
	p.onSend = onSend
	p.started = true
	p.mu.Unlock()
	return nil
}

// ensureDevice opens the output device on the first frame that actually needs
// it, rather than when the session starts.
//
// Realtime sessions are opened and closed without ever producing a sample more
// often than you would think: a mis-fired global hotkey, or a session the daemon
// declines and closes immediately. A real log showed two such sessions inside
// three seconds, each cycling a WASAPI render stream on a Realtek endpoint for
// audio that never came. That churn is pointless at best, and on endpoints that
// pop when the render stream powers up and down it is audible.
//
// Uses TryLock so Write keeps its "never blocks the read loop" property: if a
// Start or Stop is in flight, the next frame (40 ms later) opens the device.
func (p *AudioStreamPlayer) ensureDevice() {
	p.mu.Lock()
	need := p.started && p.device == nil && p.onSend != nil
	p.mu.Unlock()
	if !need {
		return
	}
	if !p.lifecycleMu.TryLock() {
		return
	}
	defer p.lifecycleMu.Unlock()

	p.mu.Lock()
	need, onSend := p.started && p.device == nil && p.onSend != nil, p.onSend
	p.mu.Unlock()
	if !need {
		return
	}

	// One attempt per session. Without this a session with no usable output
	// endpoint retries InitDevice synchronously on the read loop for every
	// inbound frame, 25 times a second, each with a log line.
	if !p.deviceFailed.CompareAndSwap(false, true) {
		return
	}

	ctx, err := streamPlaybackContext()
	if err != nil {
		log.Printf("[stream] playback context unavailable: %v", err)
		return
	}

	cfg := malgo.DefaultDeviceConfig(malgo.Playback)
	cfg.Playback.Format = malgo.FormatS16
	cfg.Playback.Channels = 1
	cfg.SampleRate = streamPlaybackSampleRate
	cfg.PeriodSizeInMilliseconds = streamPeriodMs
	cfg.Periods = streamPeriods
	cfg.Alsa.NoMMap = 1

	device, err := malgo.InitDevice(ctx.Context, cfg, malgo.DeviceCallbacks{Data: onSend})
	if err != nil {
		log.Printf("[stream] playback device init failed: %v", err)
		return
	}
	if err := device.Start(); err != nil {
		device.Uninit()
		log.Printf("[stream] playback device start failed: %v", err)
		return
	}

	p.mu.Lock()
	p.device = device
	p.mu.Unlock()
	p.deviceFailed.Store(false) // opened; nothing to latch

	log.Printf("[stream] playback device open (PCM s16 mono %d Hz, %dx%dms buffer)",
		streamPlaybackSampleRate, streamPeriods, streamPeriodMs)
}

// render fills out with the next slice of the response. This is the audio-thread
// hot path: no allocation, a few atomics and two short ring critical sections
// (the depth check and the read).
//
// While priming, it outputs silence and lets the cushion build; once the
// cushion is there it drains. An underrun fills the rest with silence and
// re-primes, so the next burst rebuilds the cushion rather than stuttering
// through it. Split out of the device callback so the cushion, the underrun
// re-prime and Flush can be tested without an audio device.
func (p *AudioStreamPlayer) render(out []byte, ring *pcmRing) {
	pending := ring.pending()
	ended := p.inputIdle()

	if p.priming.Load() {
		if pending < int(p.cushion.Load()) && !ended {
			zeroPCM(out)
			return
		}
		p.priming.Store(false)
	}

	// The healthy path: a whole buffer, rendered with no seam.
	if pending >= len(out) {
		ring.read(out)
		return
	}

	if ended {
		// The tail of the response. Play out what is left, then silence.
		n := ring.read(out)
		zeroPCM(out[n:])
		p.priming.Store(true)
		return
	}

	// Mid-response underrun. Deliberately leave the remainder IN the ring rather
	// than emitting it followed by zeros: a partial buffer padded with silence
	// is a hard edge in the middle of a waveform, and a hard edge is a click,
	// which is what a listener describes as a sharp high-pitched glitch. Holding
	// it means the audio resumes contiguously once the cushion rebuilds.
	zeroPCM(out)
	p.priming.Store(true)
	// Recorded, not acted on: only Write knows whether this was jitter (audio
	// resumed) or simply the end of the response.
	p.underrunPending.Store(true)
}

// noteAudioResumed is called from Write when a frame arrives after the render
// callback ran short. That ordering is what makes it jitter rather than the end
// of a response, and only jitter justifies a wider cushion.
func (p *AudioStreamPlayer) noteAudioResumed() {
	if !p.underrunPending.CompareAndSwap(true, false) {
		return
	}
	p.underruns.Add(1)
	for {
		c := p.cushion.Load()
		if c >= streamCushionMax {
			return
		}
		next := c + streamCushionStep
		if next > streamCushionMax {
			next = streamCushionMax
		}
		if p.cushion.CompareAndSwap(c, next) {
			return
		}
	}
}

func zeroPCM(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// inputIdle reports whether the daemon has stopped sending, i.e. the response
// has ended rather than merely fallen behind.
func (p *AudioStreamPlayer) inputIdle() bool {
	last := p.lastWriteNanos.Load()
	if last == 0 {
		return false // nothing has ever arrived; there is no tail to drain
	}
	return time.Since(time.Unix(0, last)) > streamInputIdle
}

// Write appends a PCM frame to the play queue. Never blocks: this runs on the
// readLoop, and a stalled output device must cost old audio rather than stall
// the connection. Past ~60 s of backlog the oldest un-played audio is dropped.
func (p *AudioStreamPlayer) Write(pcm []byte) {
	if len(pcm) == 0 {
		return
	}
	now := time.Now()
	p.lastWriteNanos.Store(now.UnixNano())
	p.mu.Lock()
	ring := p.ring
	p.writes++
	w := p.writes
	p.lastWrite = now
	p.mu.Unlock()

	if ring == nil {
		return // stopped between the daemon's send and our write
	}
	pcm = p.alignToFrames(pcm)
	if len(pcm) == 0 {
		return
	}
	p.noteAudioResumed()
	p.ensureDevice()
	if _, dropped := ring.writeDropOldest(pcm); dropped > 0 {
		// Once a stalled device fills the backlog, EVERY inbound frame drops.
		// At 25 frames/s that is a log line every 40 ms for as long as the stall
		// lasts, so rate-limit it to one line per stall-ish window.
		p.mu.Lock()
		say := time.Since(p.lastDropLog) > time.Second
		if say {
			p.lastDropLog = time.Now()
		}
		p.mu.Unlock()
		if say {
			log.Printf("[stream] output backlog full (%d bytes); dropping the oldest audio",
				ring.capacity())
		}
	}
	if w == 1 || w%125 == 0 { // first inbound frame, then every ~5 s
		// Reported here rather than from the render callback: this runs on the
		// read loop, where logging is allowed. Underruns and a cushion above the
		// base are the signature of a delivery path slower or jitterier than the
		// playout buffer, which sounds like chopped speech with a click at every
		// seam.
		log.Printf("[stream] pcm frames received from daemon: %d (buffered %dms, cushion %dms, underruns %d)",
			w, msOfPCM(ring.pending()), msOfPCM(int(p.cushion.Load())), p.underruns.Load())
	}
}

// alignToFrames trims a trailing half-sample and carries it into the next
// frame. Frames from the daemon are whole samples, but nothing on the wire
// enforces it, and a dropped odd byte byte-shifts every sample after it into
// full-scale static: the exact failure this player was rewritten to make
// impossible. Runs on the read loop under p.mu, never on the audio thread.
func (p *AudioStreamPlayer) alignToFrames(pcm []byte) []byte {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.carryLen > 0 {
		joined := make([]byte, 0, p.carryLen+len(pcm))
		joined = append(joined, p.carry[:p.carryLen]...)
		pcm = append(joined, pcm...)
		p.carryLen = 0
	}
	if odd := len(pcm) % 2; odd != 0 {
		p.carry[0] = pcm[len(pcm)-1]
		p.carryLen = 1
		pcm = pcm[:len(pcm)-1]
	}
	return pcm
}

// msOfPCM converts a byte count at the stream format to milliseconds.
func msOfPCM(b int) int { return b * 1000 / (streamPlaybackSampleRate * 2) }

// Flush drops all queued audio immediately (barge-in / interruption) and
// re-arms priming so the next response rebuilds its playout cushion. Audio
// already committed to the device (up to one buffer) still plays out.
func (p *AudioStreamPlayer) Flush() {
	p.mu.Lock()
	ring := p.ring
	p.mu.Unlock()

	if ring != nil {
		ring.flush()
	}
	p.priming.Store(true)
}

// Stop closes the device and releases the queue. Idempotent.
//
// The device is stopped OUTSIDE p.mu on purpose. ma_device_stop waits for the
// audio thread to finish its current callback; holding the callback's lock
// across that wait is a deadlock. (The callback doesn't take p.mu today, but
// the ordering is the invariant worth keeping, not the current callback body.)
func (p *AudioStreamPlayer) Stop() {
	p.lifecycleMu.Lock()
	defer p.lifecycleMu.Unlock()

	p.mu.Lock()
	device, ring := p.device, p.ring
	p.device, p.ring, p.onSend = nil, nil, nil
	p.started = false
	p.mu.Unlock()

	if ring != nil {
		ring.flush()
	}
	if device != nil {
		_ = device.Stop()
		device.Uninit()
	}
	p.priming.Store(true)
}
