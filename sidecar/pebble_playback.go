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

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gen2brain/malgo"
	gomp3 "github.com/hajimehoshi/go-mp3"
)

// playbackJob is a single clip waiting in the queue. The generation number
// lets Stop() invalidate everything queued before the call without needing
// to drain the channel atomically.
type playbackJob struct {
	audio []byte
	mime  string
	gen   int64
}

// AudioPlaybackService owns one malgo playback context and a single
// background worker that drains a queue of clips and plays them
// back-to-back. Streaming TTS (T17e) enqueues one clip per sentence as
// the LLM streams; the queue model means clips play seamlessly without
// the daemon having to wait for each clip's playback to finish before
// dispatching the next.
type AudioPlaybackService struct {
	mu  sync.Mutex
	ctx *malgo.AllocatedContext

	queue      chan playbackJob
	workerOnce sync.Once
	generation atomic.Int64

	// playing is true whenever the worker is rendering a clip OR has
	// just finished and not yet idled out (100 ms grace). This is what
	// the wake-listener suppression hooks observe.
	playing atomic.Bool
	// stopReq, when set, makes the data callback feed silence + close
	// the done channel within ~10 ms. Reset at the start of each new
	// clip so back-to-back queued clips aren't accidentally aborted.
	stopReq atomic.Bool

	onPlayStateMu     sync.RWMutex
	onPlayStateChange func(playing bool)
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

// worker drains the playback queue, playing each clip via malgo. Idle
// timeout debounces the play-state notification so back-to-back clips
// don't toggle the wake listener's suppression flag for every clip
// boundary — only when the queue genuinely empties for >100 ms.
func (s *AudioPlaybackService) worker() {
	const idleTimeout = 100 * time.Millisecond
	announced := false
	for {
		select {
		case job, ok := <-s.queue:
			if !ok {
				if announced {
					s.notifyPlayState(false)
					announced = false
				}
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
			s.playing.Store(true)
			s.stopReq.Store(false)
			if err := s.playOne(job.audio, job.mime); err != nil {
				log.Printf("[playback] error: %v", err)
			}
			s.playing.Store(false)
		case <-time.After(idleTimeout):
			if announced {
				s.notifyPlayState(false)
				announced = false
			}
		}
	}
}

// playOne renders a single clip through malgo. Blocks until the clip
// finishes (or stopReq is asserted by Stop()).
func (s *AudioPlaybackService) playOne(audio []byte, mimeHint string) error {
	pcm, sampleRate, channels, err := decodeAudio(audio, mimeHint)
	if err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if len(pcm) == 0 {
		return nil
	}

	s.mu.Lock()
	if s.ctx == nil {
		ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, func(message string) {
			log.Printf("[playback] miniaudio: %s", message)
		})
		if err != nil {
			s.mu.Unlock()
			return fmt.Errorf("malgo.InitContext: %w", err)
		}
		s.ctx = ctx
	}
	ctx := s.ctx
	s.mu.Unlock()

	deviceConfig := malgo.DefaultDeviceConfig(malgo.Playback)
	deviceConfig.Playback.Format = malgo.FormatS16
	deviceConfig.Playback.Channels = uint32(channels)
	deviceConfig.SampleRate = uint32(sampleRate)
	deviceConfig.Alsa.NoMMap = 1

	done := make(chan struct{})
	var doneOnce sync.Once
	closeDone := func() { doneOnce.Do(func() { close(done) }) }

	cursor := 0
	onSend := func(output, _ []byte, frameCount uint32) {
		bytesPerFrame := int(channels) * 2
		need := int(frameCount) * bytesPerFrame
		if s.stopReq.Load() {
			for i := range output[:need] {
				output[i] = 0
			}
			closeDone()
			return
		}
		if cursor >= len(pcm) {
			for i := range output[:need] {
				output[i] = 0
			}
			closeDone()
			return
		}
		end := cursor + need
		if end > len(pcm) {
			end = len(pcm)
		}
		n := copy(output[:need], pcm[cursor:end])
		if n < need {
			for i := n; i < need; i++ {
				output[i] = 0
			}
		}
		cursor = end
	}

	device, err := malgo.InitDevice(ctx.Context, deviceConfig, malgo.DeviceCallbacks{
		Data: onSend,
	})
	if err != nil {
		return fmt.Errorf("malgo.InitDevice: %w", err)
	}
	defer device.Uninit()

	if err := device.Start(); err != nil {
		return fmt.Errorf("device.Start: %w", err)
	}
	// `done` is closed only from inside the malgo data callback (clip finished
	// or stopReq seen). If the device opens but then stalls / errors / stops
	// driving the callback (device disconnect, sample-rate rejected mid-stream),
	// the callback never reaches the end condition and a bare `<-done` would
	// hang the singleton worker forever, wedging all future playback. Bound the
	// wait by the clip's own duration plus a startup/drain grace.
	timeout := 3 * time.Second
	if bps := sampleRate * channels * 2; bps > 0 {
		timeout += time.Duration(float64(len(pcm)) / float64(bps) * float64(time.Second))
	}
	select {
	case <-done:
	case <-time.After(timeout):
		log.Printf("[playback] clip wait timed out after %v (device stalled?) — forcing stop", timeout)
	}
	device.Stop() //nolint:errcheck
	return nil
}

// Stop bumps the generation counter (so already-queued clips are skipped
// by the worker) and asserts stopReq (so the currently-playing clip
// aborts within ~10 ms). Idempotent.
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
	if s.playing.Load() {
		s.stopReq.Store(true)
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
