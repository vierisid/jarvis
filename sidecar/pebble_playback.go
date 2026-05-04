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

	"github.com/gen2brain/malgo"
	gomp3 "github.com/hajimehoshi/go-mp3"
)

// AudioPlaybackService owns one malgo playback context shared across all
// playback sessions. Each Play() spins up a fresh device sized to the
// decoded clip's sample rate / channels — keeps the playback path stateless
// from the caller's POV (give it bytes + format, hear sound).
type AudioPlaybackService struct {
	mu      sync.Mutex
	ctx     *malgo.AllocatedContext
	playing atomic.Bool
}

func NewAudioPlaybackService() *AudioPlaybackService {
	return &AudioPlaybackService{}
}

// Play decodes the inline audio bytes (MP3 or WAV) and plays them through
// the default output device. Blocks until playback finishes. Concurrent
// Play() calls return an error — the caller (daemon) serializes responses
// per pebble anyway.
func (s *AudioPlaybackService) Play(audio []byte, mimeHint string) error {
	if len(audio) == 0 {
		return fmt.Errorf("empty audio buffer")
	}
	if !s.playing.CompareAndSwap(false, true) {
		return fmt.Errorf("playback already in progress")
	}
	defer s.playing.Store(false)

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

	// done is closed by the data callback when the source is exhausted —
	// we then Stop+Uninit the device on the calling goroutine so the
	// callback's own thread doesn't deadlock against malgo's internals.
	done := make(chan struct{})
	var doneOnce sync.Once
	closeDone := func() { doneOnce.Do(func() { close(done) }) }

	cursor := 0
	onSend := func(output, _ []byte, frameCount uint32) {
		bytesPerFrame := int(channels) * 2 // s16 mono/stereo
		need := int(frameCount) * bytesPerFrame
		if cursor >= len(pcm) {
			// Past EOF — feed silence and signal done.
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
		// Pad remainder with silence if we hit EOF mid-buffer.
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
	<-done
	device.Stop() //nolint:errcheck — best-effort; defer will Uninit anyway
	return nil
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
