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
	buf       []byte // pending PCM, drained from the front by the render callback
	started   bool
	writes    int64     // diagnostic: count of inbound PCM frames
	lastWrite time.Time // when the most recent output frame arrived (echo gate)
}

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
	if len(p.buf) > 0 {
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

	// Render callback: drain the queue front into the device buffer; fill any
	// remainder with silence on underrun. Shift the leftover to the front so
	// the backing array is reused rather than growing.
	onSend := func(output, _ []byte, frameCount uint32) {
		need := int(frameCount) * 2 // s16 mono = 2 bytes/frame
		if need > len(output) {
			need = len(output)
		}
		p.mu.Lock()
		n := copy(output[:need], p.buf)
		if n > 0 {
			rest := len(p.buf) - n
			copy(p.buf, p.buf[n:])
			p.buf = p.buf[:rest]
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
// grow the queue without limit (drops the oldest audio past ~5 s of backlog).
func (p *AudioStreamPlayer) Write(pcm []byte) {
	if len(pcm) == 0 {
		return
	}
	p.mu.Lock()
	p.buf = append(p.buf, pcm...)
	const maxBacklog = streamPlaybackSampleRate * 2 * 5 // ~5 s
	if len(p.buf) > maxBacklog {
		p.buf = append(p.buf[:0], p.buf[len(p.buf)-maxBacklog:]...)
	}
	p.writes++
	p.lastWrite = time.Now()
	w := p.writes
	p.mu.Unlock()
	if w == 1 || w%125 == 0 { // first inbound frame, then every ~5 s
		log.Printf("[stream] pcm frames received from daemon: %d", w)
	}
}

// Flush drops all queued audio immediately (barge-in / interruption).
func (p *AudioStreamPlayer) Flush() {
	p.mu.Lock()
	p.buf = p.buf[:0]
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
	p.started = false
}
