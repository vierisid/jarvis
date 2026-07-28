package main

// Low-latency streaming PCM playback for the pebble's realtime voice loop.
//
// Unlike AudioPlaybackService (which opens a fresh malgo device per TTS clip and
// only accepts complete MP3/WAV containers), this opens ONE persistent output
// device and feeds it raw PCM s16/mono/24 kHz frames as they stream in from the
// daemon's realtime session. The device's render callback drains a small queue;
// underruns play silence. Barge-in flushes the queue instantly.
//
// Frames arrive via the readLoop's `pebble.play_pcm` fast-path (in receive
// order) and are appended with Write; the audio thread drains them in Render.

import (
	"log"
	"sync"
	"time"

	"github.com/gen2brain/malgo"
)

const streamPlaybackSampleRate = 24000 // matches the realtime session output rate

// AudioStreamPlayer owns a persistent malgo playback device + a byte queue of
// pending PCM (s16 mono). Safe for concurrent Write / Flush / Stop.
type AudioStreamPlayer struct {
	mu        sync.Mutex
	ctx       *malgo.AllocatedContext
	device    *malgo.Device
	buf       []byte // PCM queue; live (undrained) data is buf[readPos:]
	readPos   int    // bytes at the front already played (read cursor, not shifted per-callback)
	started   bool
	priming   bool      // playout (jitter) buffer: accumulating before (re)starting drain
	writes    int64     // diagnostic: count of inbound PCM frames
	lastWrite time.Time // when the most recent output frame arrived (echo gate)
}

// maxBacklogBytes bounds only a genuinely STALLED device (not draining). It must
// be far larger than any real answer: OpenAI bursts a long answer's audio faster
// than real-time, so the queue legitimately holds many seconds of not-yet-played
// PCM. The old 5 s cap dropped the middle of long answers → chunky playback. ~60 s.
const maxBacklogBytes = streamPlaybackSampleRate * 2 * 60

// jitterPrimeBytes is the playout cushion: the render callback outputs silence
// until this much PCM is buffered, then drains. Re-primed on underrun. Absorbs
// delivery jitter (OpenAI bursts, the WSL2 bridge, daemon hiccups) so brief gaps
// don't drain the device to silence and stutter the voice. ~120 ms.
const jitterPrimeBytes = streamPlaybackSampleRate * 2 * 120 / 1000

// echoHangover keeps the mic gated briefly after the output buffer drains, so
// the tail of the assistant's audio (and its acoustic echo) doesn't leak back in.
const echoHangover = 300 * time.Millisecond

// IsActive reports whether the assistant is currently producing output audio —
// true while the buffer holds samples, or within the hangover after the last
// frame. The realtime controller uses this to gate the mic (half-duplex echo
// suppression when there's no native AEC, e.g. on speakers).
func (p *AudioStreamPlayer) IsActive() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.buf)-p.readPos > 0 {
		return true
	}
	return !p.lastWrite.IsZero() && time.Since(p.lastWrite) < echoHangover
}

func NewAudioStreamPlayer() *AudioStreamPlayer { return &AudioStreamPlayer{} }

// Start opens the persistent output device. Idempotent.
func (p *AudioStreamPlayer) Start() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.started {
		return nil
	}
	if p.ctx == nil {
		ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, func(m string) {
			log.Printf("[stream] miniaudio: %s", m)
		})
		if err != nil {
			return err
		}
		p.ctx = ctx
	}

	cfg := malgo.DefaultDeviceConfig(malgo.Playback)
	cfg.Playback.Format = malgo.FormatS16
	cfg.Playback.Channels = 1
	cfg.SampleRate = streamPlaybackSampleRate
	cfg.Alsa.NoMMap = 1

	// Render callback: a playout (jitter) buffer read via a cursor. While priming,
	// output silence until the cushion (jitterPrimeBytes) is built up, then drain
	// by advancing readPos (NOT shifting the whole queue — that was O(n) every
	// callback and choppy for long, deeply-buffered answers). On full drain, reset
	// the slice and re-prime so the next response rebuilds its cushion.
	p.priming = true
	onSend := func(output, _ []byte, frameCount uint32) {
		need := int(frameCount) * 2 // s16 mono = 2 bytes/frame
		if need > len(output) {
			need = len(output)
		}
		p.mu.Lock()
		avail := len(p.buf) - p.readPos
		if p.priming {
			if avail >= jitterPrimeBytes {
				p.priming = false // cushion built — start draining
			} else {
				p.mu.Unlock()
				for i := 0; i < need; i++ {
					output[i] = 0
				}
				return
			}
		}
		n := copy(output[:need], p.buf[p.readPos:])
		p.readPos += n
		if p.readPos >= len(p.buf) {
			// Fully drained — reset to reuse the backing array, re-prime.
			p.buf = p.buf[:0]
			p.readPos = 0
			p.priming = true
		} else if p.readPos >= 1<<20 {
			// Reclaim consumed space occasionally (amortized O(1)), never per-callback.
			rem := len(p.buf) - p.readPos
			copy(p.buf, p.buf[p.readPos:])
			p.buf = p.buf[:rem]
			p.readPos = 0
		}
		p.mu.Unlock()
		for i := n; i < need; i++ {
			output[i] = 0
		}
	}

	device, err := malgo.InitDevice(p.ctx.Context, cfg, malgo.DeviceCallbacks{Data: onSend})
	if err != nil {
		return err
	}
	if err := device.Start(); err != nil {
		device.Uninit()
		return err
	}
	p.device = device
	p.started = true
	log.Printf("[stream] playback device open (PCM s16 mono %d Hz)", streamPlaybackSampleRate)
	return nil
}

// Write appends a PCM frame to the play queue. Bounded so a stalled device can't
// grow the queue without limit (drops the oldest audio past ~60 s of backlog).
func (p *AudioStreamPlayer) Write(pcm []byte) {
	if len(pcm) == 0 {
		return
	}
	p.mu.Lock()
	p.buf = append(p.buf, pcm...)
	// Only a stalled device (not draining) can exceed the cap; drop the oldest
	// un-played audio by advancing the cursor. Real answers never reach this.
	if avail := len(p.buf) - p.readPos; avail > maxBacklogBytes {
		p.readPos += avail - maxBacklogBytes
	}
	p.writes++
	p.lastWrite = time.Now()
	w := p.writes
	p.mu.Unlock()
	if w == 1 || w%125 == 0 { // first inbound frame, then every ~5 s
		log.Printf("[stream] pcm frames received from daemon: %d", w)
	}
}

// Flush drops all queued audio immediately (barge-in / interruption) and
// re-arms priming so the next response rebuilds its playout cushion.
func (p *AudioStreamPlayer) Flush() {
	p.mu.Lock()
	p.buf = p.buf[:0]
	p.readPos = 0
	p.priming = true
	p.mu.Unlock()
}

// Stop closes the device and releases the queue. Idempotent.
func (p *AudioStreamPlayer) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.device != nil {
		_ = p.device.Stop()
		p.device.Uninit()
		p.device = nil
	}
	p.buf = nil
	p.readPos = 0
	p.started = false
}
