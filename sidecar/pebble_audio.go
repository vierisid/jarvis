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
}

func NewAudioCaptureService() *AudioCaptureService {
	return &AudioCaptureService{}
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

	deviceConfig := malgo.DefaultDeviceConfig(malgo.Capture)
	deviceConfig.Capture.Format = malgo.FormatS16
	deviceConfig.Capture.Channels = pebbleAudioChannels
	deviceConfig.SampleRate = pebbleAudioSampleRate
	deviceConfig.Alsa.NoMMap = 1

	onRecv := func(_, input []byte, _ uint32) {
		session.mu.Lock()
		session.pcm.Write(input)
		session.mu.Unlock()
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
	log.Printf("[audio] capture session %q started (PCM s16 mono %d Hz)", sessionID, pebbleAudioSampleRate)
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
	pcm := s.session.pcm.Bytes()
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

// suppress unused-import warning when the WAV path isn't used elsewhere
var _ = filepath.Join
var _ = os.Create
