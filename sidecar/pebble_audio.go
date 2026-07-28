package main

// Cross-platform mic capture for the pebble's voice loop.
//
// Uses miniaudio (via gen2brain/malgo) — single-header C library wrapped in
// Go that abstracts WASAPI on Windows, Core Audio on macOS and ALSA on
// Linux. One API for all three platforms; saves us writing per-OS native
// audio code.
//
// W2-T21 first milestone (this file): capture audio for a fixed duration
// when the pebble enters listening, save to a WAV in the OS temp dir, and
// log the path so we can verify the mic input is real before wiring STT
// (T23). Streams to daemon land in T22.
//
// Format: PCM signed 16-bit, 16 kHz, mono — the format every STT provider
// (Whisper / AssemblyAI / Apple Speech) accepts directly.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gen2brain/malgo"
)

const (
	pebbleAudioSampleRate = 16000
	pebbleAudioChannels   = 1
	pebbleAudioBitsPer    = 16
)

// AudioSession represents a single capture session. Spawned on pebble.summon,
// closed when the cycle ends (or after the fixed duration in this milestone).
type AudioSession struct {
	id        string
	startedAt time.Time
	pcm       *bytes.Buffer
	mu        sync.Mutex
}

// AudioCaptureService is the cross-platform mic capture API. The
// implementation is the same on Win/Mac/Linux thanks to miniaudio.
type AudioCaptureService struct {
	mu      sync.Mutex
	ctx     *malgo.AllocatedContext
	device  *malgo.Device
	session *AudioSession
	active  atomic.Bool
	// sampleRate is the capture rate (Hz). One-shot STT captures use 16 kHz
	// (what STT providers want); the realtime voice path uses 24 kHz (what the
	// OpenAI realtime API requires).
	sampleRate int
	// streamOnly skips the in-memory PCM accumulator — used by the perpetual
	// realtime stream, which forwards each chunk live and never calls Stop()
	// for the buffer (so accumulating minutes of audio would just leak).
	streamOnly bool
	// onChunk, when set, is invoked synchronously on every PCM chunk
	// delivered by the audio device. Used by VAD-driven capture to
	// monitor speech energy without exposing the malgo callback.
	onChunkMu sync.RWMutex
	onChunk   func([]byte)
}

func NewAudioCaptureService() *AudioCaptureService {
	return &AudioCaptureService{sampleRate: pebbleAudioSampleRate}
}

// NewStreamingCaptureService builds a capture service for the realtime voice
// loop: a custom sample rate (≥24 kHz for OpenAI realtime) and no PCM
// accumulation (chunks are forwarded live via the chunk listener).
func NewStreamingCaptureService(rate int) *AudioCaptureService {
	if rate <= 0 {
		rate = pebbleAudioSampleRate
	}
	return &AudioCaptureService{sampleRate: rate, streamOnly: true}
}

// Start begins a new capture session. Returns an error if a session is
// already in progress or if the audio device couldn't be opened.
func (s *AudioCaptureService) Start(sessionID string) error {
	if !s.active.CompareAndSwap(false, true) {
		return fmt.Errorf("audio capture already in progress")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Lazily init the malgo context — first Start spins it up; later
	// sessions reuse it. The context is closed in Stop() of the service
	// itself if/when we add a graceful shutdown path.
	if s.ctx == nil {
		ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, func(message string) {
			log.Printf("[audio] miniaudio: %s", message)
		})
		if err != nil {
			s.active.Store(false)
			return fmt.Errorf("malgo.InitContext: %w", err)
		}
		s.ctx = ctx
	}

	session := &AudioSession{
		id:        sessionID,
		startedAt: time.Now(),
		pcm:       &bytes.Buffer{},
	}
	s.session = session

	rate := s.sampleRate
	if rate <= 0 {
		rate = pebbleAudioSampleRate
	}
	deviceConfig := malgo.DefaultDeviceConfig(malgo.Capture)
	deviceConfig.Capture.Format = malgo.FormatS16
	deviceConfig.Capture.Channels = pebbleAudioChannels
	deviceConfig.SampleRate = uint32(rate)
	deviceConfig.Alsa.NoMMap = 1

	onRecv := func(_, input []byte, _ uint32) {
		if !s.streamOnly {
			session.mu.Lock()
			session.pcm.Write(input)
			session.mu.Unlock()
		}
		s.onChunkMu.RLock()
		cb := s.onChunk
		s.onChunkMu.RUnlock()
		if cb != nil {
			cb(input)
		}
	}
	deviceCallbacks := malgo.DeviceCallbacks{Data: onRecv}
	device, err := malgo.InitDevice(s.ctx.Context, deviceConfig, deviceCallbacks)
	if err != nil {
		s.active.Store(false)
		return fmt.Errorf("malgo.InitDevice: %w", err)
	}
	if err := device.Start(); err != nil {
		device.Uninit()
		s.active.Store(false)
		return fmt.Errorf("device.Start: %w", err)
	}
	s.device = device
	log.Printf("[audio] capture session %q started (PCM s16 mono %d Hz)", sessionID, rate)
	return nil
}

// Stop ends the active capture session and returns the accumulated PCM
// bytes (raw, no WAV header). Safe to call when no session is active.
func (s *AudioCaptureService) Stop() ([]byte, time.Duration, error) {
	if !s.active.CompareAndSwap(true, false) {
		return nil, 0, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.device != nil {
		_ = s.device.Stop()
		s.device.Uninit()
		s.device = nil
	}
	if s.session == nil {
		return nil, 0, nil
	}
	dur := time.Since(s.session.startedAt)
	// Snapshot the PCM under the session lock: device.Stop() above is not
	// guaranteed to have joined an in-flight onRecv callback on every malgo
	// backend, and bytes.Buffer is not safe for concurrent Write/Bytes. Copy so
	// the returned slice is independent of the buffer's backing array too.
	s.session.mu.Lock()
	pcm := append([]byte(nil), s.session.pcm.Bytes()...)
	s.session.mu.Unlock()
	id := s.session.id
	s.session = nil
	log.Printf("[audio] capture session %q stopped (%d PCM bytes, %.2fs)", id, len(pcm), dur.Seconds())
	return pcm, dur, nil
}

// SaveWAV writes the captured PCM as a 16-bit mono WAV to the given path.
// Useful for the T21 milestone — we save to /tmp and log the path so we
// can play it back to verify mic capture works before wiring STT.
func SaveWAV(path string, pcm []byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return writeWAV(f, pcm, pebbleAudioSampleRate, pebbleAudioChannels, pebbleAudioBitsPer)
}

// writeWAV emits a minimal RIFF/WAVE header followed by the raw PCM.
func writeWAV(w io.Writer, pcm []byte, sampleRate, channels, bitsPerSample int) error {
	dataLen := uint32(len(pcm))
	byteRate := uint32(sampleRate * channels * bitsPerSample / 8)
	blockAlign := uint16(channels * bitsPerSample / 8)
	chunkSize := 36 + dataLen

	if _, err := w.Write([]byte("RIFF")); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, chunkSize); err != nil {
		return err
	}
	if _, err := w.Write([]byte("WAVE")); err != nil {
		return err
	}
	// fmt subchunk
	if _, err := w.Write([]byte("fmt ")); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(16)); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint16(1)); err != nil {
		return err // PCM
	}
	if err := binary.Write(w, binary.LittleEndian, uint16(channels)); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(sampleRate)); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, byteRate); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, blockAlign); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint16(bitsPerSample)); err != nil {
		return err
	}
	// data subchunk
	if _, err := w.Write([]byte("data")); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, dataLen); err != nil {
		return err
	}
	if _, err := w.Write(pcm); err != nil {
		return err
	}
	return nil
}

// pebbleCaptureForDuration captures audio for a fixed window. T21 used this
// to save a verification WAV; T22+ uses it to drive streaming-to-daemon.
// Returns the raw PCM bytes (s16 mono 16 kHz), the actual duration, and
// any error. Caller decides what to do with the PCM (save WAV, stream to
// daemon, etc.).
func pebbleCaptureForDuration(svc *AudioCaptureService, sessionID string, dur time.Duration) ([]byte, time.Duration, error) {
	if err := svc.Start(sessionID); err != nil {
		return nil, 0, err
	}
	time.Sleep(dur)
	return svc.Stop()
}

// SetChunkListener registers a callback invoked synchronously for each
// PCM chunk the device delivers. Pass nil to clear. Used by VAD capture;
// not thread-safe with concurrent registrations but the audio service
// only ever has one consumer at a time.
func (s *AudioCaptureService) SetChunkListener(cb func([]byte)) {
	s.onChunkMu.Lock()
	s.onChunk = cb
	s.onChunkMu.Unlock()
}

// VADOpts tunes end-of-speech detection. All durations are wall-clock.
type VADOpts struct {
	HardCap       time.Duration // Max session length (e.g. 15s) — safety bound.
	PreSpeechCap  time.Duration // Abort if no speech detected by this point (e.g. 4s).
	SilenceCutoff time.Duration // End capture after this much silence post-speech (e.g. 1.1s).
	RMSThreshold  float64       // RMS energy above which a chunk counts as speech (e.g. 500).
}

// DefaultVADOpts returns sensible defaults tuned for typical desktop mics.
// Tweak via env vars or RPC params if a user's mic is unusually noisy.
func DefaultVADOpts() VADOpts {
	return VADOpts{
		HardCap:       15 * time.Second,
		PreSpeechCap:  4 * time.Second,
		SilenceCutoff: 1100 * time.Millisecond,
		RMSThreshold:  500.0,
	}
}

// pebbleCaptureWithVAD captures audio until the user stops speaking
// (silenceCutoff after the last detected speech), with safety bounds:
//   - HardCap caps total session length so a stuck mic can't run forever.
//   - PreSpeechCap aborts with empty PCM if no speech is detected at all,
//     letting the daemon short-circuit the LLM call.
//
// Energy-based VAD: per chunk, compute RMS over the s16 samples. RMS above
// the threshold flags speech. Coordinator polls the shared state every
// 50 ms and decides when to stop. Simple and works well for desktop mics
// where speech sits well above noise floor; can be swapped for WebRTC VAD
// or Silero later if accuracy matters.
func pebbleCaptureWithVAD(svc *AudioCaptureService, sessionID string, opts VADOpts) ([]byte, time.Duration, error) {
	type vadState struct {
		mu             sync.Mutex
		startedAt      time.Time
		speechSeen     bool
		lastSpeechAt   time.Time
		peakRMS        float64
		chunksAnalyzed int
	}
	st := &vadState{startedAt: time.Now()}

	svc.SetChunkListener(func(input []byte) {
		rms := pcmRMSint16(input)
		st.mu.Lock()
		defer st.mu.Unlock()
		st.chunksAnalyzed++
		if rms > st.peakRMS {
			st.peakRMS = rms
		}
		if rms > opts.RMSThreshold {
			if !st.speechSeen {
				st.speechSeen = true
				log.Printf("[audio] VAD: speech detected (rms=%.0f) after %dms",
					rms, time.Since(st.startedAt).Milliseconds())
			}
			st.lastSpeechAt = time.Now()
		}
	})
	defer svc.SetChunkListener(nil)

	if err := svc.Start(sessionID); err != nil {
		return nil, 0, err
	}

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	reason := "hard-cap"
	for range ticker.C {
		now := time.Now()
		st.mu.Lock()
		elapsed := now.Sub(st.startedAt)
		speechSeen := st.speechSeen
		var silence time.Duration
		if speechSeen {
			silence = now.Sub(st.lastSpeechAt)
		}
		st.mu.Unlock()

		if elapsed >= opts.HardCap {
			reason = fmt.Sprintf("hard-cap %.1fs", opts.HardCap.Seconds())
			break
		}
		if !speechSeen && elapsed >= opts.PreSpeechCap {
			reason = fmt.Sprintf("no speech in %.1fs", opts.PreSpeechCap.Seconds())
			break
		}
		if speechSeen && silence >= opts.SilenceCutoff {
			reason = fmt.Sprintf("silence %.0fms after speech", silence.Seconds()*1000)
			break
		}
	}

	st.mu.Lock()
	peak := st.peakRMS
	chunks := st.chunksAnalyzed
	st.mu.Unlock()
	log.Printf("[audio] VAD: stop (reason=%s, peak_rms=%.0f, chunks=%d)", reason, peak, chunks)

	return svc.Stop()
}

// pcmRMSint16 computes the root-mean-square energy of a chunk of
// little-endian s16 PCM samples. Returns 0 for empty/odd-length buffers.
// Used by VAD to flag chunks as speech vs silence.
func pcmRMSint16(buf []byte) float64 {
	if len(buf) < 2 {
		return 0
	}
	n := len(buf) / 2
	if n == 0 {
		return 0
	}
	var sumSq float64
	for i := 0; i < n; i++ {
		s := int16(binary.LittleEndian.Uint16(buf[i*2 : i*2+2]))
		v := float64(s)
		sumSq += v * v
	}
	return math.Sqrt(sumSq / float64(n))
}

// suppress unused-import warning when the WAV path isn't used elsewhere
var _ = filepath.Join
var _ = os.Create
