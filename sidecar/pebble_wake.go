package main

// Sidecar-native wake-word detection.
//
// Strategy: continuous mic capture + VAD-driven segmentation. Each speech
// segment (roughly one phrase the user said) is streamed to the daemon as
// an `audio.wake_segment` event. The daemon transcribes via the existing
// STT provider and word-searches the transcript for "jarvis". Catching
// the wake via STT (rather than openwakeword + ONNX runtime) means:
//   - No new native deps to bundle per platform
//   - Naturally handles "any phrase containing Jarvis" (the user's ask)
//   - Reuses 100% of the STT infrastructure
//
// Trade-off vs. native wake-word: latency = silence-cutoff (~1 s) + STT
// round-trip (~300–800 ms with Groq Whisper, more with OpenAI). Acceptable
// for an always-listening mode; can be replaced by ONNX-based detection
// later (T16b) if real-time hot-trigger feel becomes necessary.
//
// Suppression: WakeListener.Pause() releases the mic device entirely so
// the Ctrl+Space-triggered session capture can grab it without contention.
// Resume() restarts the continuous capture once the session ends. The
// daemon also gates wake_segment processing during TTS playback so JARVIS
// saying his own name doesn't re-trigger the loop.

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// WakeListenerOpts tunes the wake-word listener's segmentation. Defaults
// favor catching brief utterances ("Jarvis") over avoiding false segments,
// since the daemon's transcript word-search filters out non-wake speech
// for free.
type WakeListenerOpts struct {
	RMSThreshold      float64       // chunk RMS above this counts as speech (default 500)
	SilenceCutoff     time.Duration // silence after speech that ends a segment (default 900 ms)
	MinSegmentDur     time.Duration // discard segments shorter than this — likely background noise (default 300 ms)
	MaxSegmentDur     time.Duration // hard cap on segment length (default 12 s)
	PreSpeechIdleScan time.Duration // poll interval while waiting for speech (default 50 ms)
}

// DefaultWakeListenerOpts — tuned for typical desktop mics with
// responsiveness as the priority. Silence cutoff is aggressive (350 ms) so
// the wake match → listening transition feels instant; "Hey Jarvis" runs
// together as one phrase so mid-phrase pauses shorter than this are rare.
// If you find segments getting cut mid-word, raise this.
func DefaultWakeListenerOpts() WakeListenerOpts {
	return WakeListenerOpts{
		RMSThreshold:      500.0,
		SilenceCutoff:     350 * time.Millisecond,
		MinSegmentDur:     250 * time.Millisecond,
		MaxSegmentDur:     12 * time.Second,
		PreSpeechIdleScan: 25 * time.Millisecond,
	}
}

// WakeListenerService runs a continuous mic capture and emits one
// `audio.wake_segment` event per detected utterance (speech bracketed by
// silence). Single instance per sidecar; coexists with the Ctrl+Space-
// triggered session capture by releasing the audio device on Pause().
type WakeListenerService struct {
	audioSvc *AudioCaptureService
	sender   EventSender
	opts     WakeListenerOpts

	// running gates Start/Stop; paused gates the chunk-handling logic so
	// suppression (during summon) doesn't tear down the device.
	// suppressed is the lighter-weight gate used during TTS playback —
	// device stays open but captured chunks are dropped, so JARVIS's own
	// voice through speakers can't trigger a wake or false segment.
	running    atomic.Bool
	paused     atomic.Bool
	suppressed atomic.Bool

	stopCh chan struct{}
	doneCh chan struct{}

	// Segmentation state — written from the malgo callback goroutine,
	// read by the coordinator goroutine. Mutex-protected.
	mu              sync.Mutex
	segBuf          []byte
	speechSeen      bool
	speechStartedAt time.Time
	lastSpeechAt    time.Time
	segStartedAt    time.Time
}

// NewWakeListenerService wires up a wake listener that uses the given
// audio service for capture and the given sender to emit segments. The
// listener does NOT start automatically — call Start() once the websocket
// connection is up so the segments have somewhere to go.
func NewWakeListenerService(audioSvc *AudioCaptureService, sender EventSender, opts WakeListenerOpts) *WakeListenerService {
	return &WakeListenerService{
		audioSvc: audioSvc,
		sender:   sender,
		opts:     opts,
	}
}

// Start kicks off the continuous capture + segmentation loop. Idempotent.
// Returns an error if the audio device can't be opened.
func (w *WakeListenerService) Start(ctx context.Context) error {
	if !w.running.CompareAndSwap(false, true) {
		return nil
	}
	w.stopCh = make(chan struct{})
	w.doneCh = make(chan struct{})
	w.resetSegment()

	// Hook the chunk listener BEFORE Start so we don't miss any audio.
	w.audioSvc.SetChunkListener(w.onChunk)
	if err := w.audioSvc.Start(fmt.Sprintf("wake-%d", time.Now().UnixMilli())); err != nil {
		w.audioSvc.SetChunkListener(nil)
		w.running.Store(false)
		close(w.doneCh)
		return fmt.Errorf("wake listener start: %w", err)
	}
	log.Printf("[wake] continuous listener started (rms_threshold=%.0f, silence_cutoff=%dms)",
		w.opts.RMSThreshold, w.opts.SilenceCutoff.Milliseconds())

	go w.coordinate(ctx)
	return nil
}

// Pause releases the mic device so a session-capture or other consumer
// can take over. Safe to call when not running. Use Resume() to restart.
func (w *WakeListenerService) Pause() {
	if !w.running.Load() {
		return
	}
	if !w.paused.CompareAndSwap(false, true) {
		return
	}
	w.audioSvc.SetChunkListener(nil)
	_, _, _ = w.audioSvc.Stop()
	log.Printf("[wake] paused (mic released)")
}

// Resume restarts capture after a Pause(). No-op if not paused or not
// running.
func (w *WakeListenerService) Resume(ctx context.Context) {
	if !w.running.Load() {
		return
	}
	if !w.paused.CompareAndSwap(true, false) {
		return
	}
	w.resetSegment()
	w.audioSvc.SetChunkListener(w.onChunk)
	if err := w.audioSvc.Start(fmt.Sprintf("wake-%d", time.Now().UnixMilli())); err != nil {
		log.Printf("[wake] resume failed: %v", err)
		return
	}
	log.Printf("[wake] resumed")
}

// Stop fully tears down the wake listener.
func (w *WakeListenerService) Stop() {
	if !w.running.CompareAndSwap(true, false) {
		return
	}
	close(w.stopCh)
	w.audioSvc.SetChunkListener(nil)
	_, _, _ = w.audioSvc.Stop()
	<-w.doneCh
	log.Printf("[wake] listener stopped")
}

// Suppress flips the lightweight gate used during TTS playback. true
// drops every captured chunk on the floor; false resumes normal VAD
// processing. Resets the in-flight segment so the resume doesn't ship
// any tail end of speaker echo. Idempotent.
func (w *WakeListenerService) Suppress(yes bool) {
	if yes {
		if w.suppressed.CompareAndSwap(false, true) {
			w.resetSegment()
		}
		return
	}
	if w.suppressed.CompareAndSwap(true, false) {
		w.resetSegment()
	}
}

// onChunk runs on the malgo callback goroutine for every PCM buffer.
// Updates the segmentation state under the mutex. Cheap — RMS over a
// 30 ms buffer is ~480 multiplies. Keep work here minimal so we don't
// stall the audio thread.
func (w *WakeListenerService) onChunk(buf []byte) {
	if w.paused.Load() || w.suppressed.Load() {
		return
	}
	rms := pcmRMSint16(buf)
	now := time.Now()

	w.mu.Lock()
	defer w.mu.Unlock()

	// Always append while we're inside an active segment OR speech was
	// just detected. We don't buffer pure silence so segBuf doesn't grow
	// unboundedly between phrases.
	if rms > w.opts.RMSThreshold {
		if !w.speechSeen {
			w.speechSeen = true
			w.speechStartedAt = now
			w.segStartedAt = now
		}
		w.lastSpeechAt = now
		w.segBuf = append(w.segBuf, buf...)
		return
	}
	// Silent chunk — append only if we're already mid-segment, so the
	// trailing silence becomes part of the emitted PCM (helps STT not
	// chop final phonemes).
	if w.speechSeen {
		w.segBuf = append(w.segBuf, buf...)
	}
}

// coordinate runs the segment-emission timer. Polls the segmentation
// state every PreSpeechIdleScan; emits a segment when silence has lasted
// SilenceCutoff after speech, or when the segment has hit MaxSegmentDur.
func (w *WakeListenerService) coordinate(ctx context.Context) {
	defer close(w.doneCh)
	tick := time.NewTicker(w.opts.PreSpeechIdleScan)
	defer tick.Stop()

	for {
		select {
		case <-w.stopCh:
			return
		case <-ctx.Done():
			return
		case <-tick.C:
			if w.paused.Load() {
				continue
			}
			w.maybeEmitSegment(ctx)
		}
	}
}

// maybeEmitSegment checks whether the current segment is ready to emit
// (silence cutoff reached, or hard cap exceeded). When ready, snapshots
// the buffer, resets state, and ships the segment to the daemon.
func (w *WakeListenerService) maybeEmitSegment(ctx context.Context) {
	now := time.Now()
	w.mu.Lock()
	if !w.speechSeen {
		w.mu.Unlock()
		return
	}
	silence := now.Sub(w.lastSpeechAt)
	totalDur := now.Sub(w.segStartedAt)
	if silence < w.opts.SilenceCutoff && totalDur < w.opts.MaxSegmentDur {
		w.mu.Unlock()
		return
	}
	pcm := w.segBuf
	speechDur := w.lastSpeechAt.Sub(w.speechStartedAt)
	w.segBuf = nil
	w.speechSeen = false
	w.mu.Unlock()

	// Discard tiny blips — most likely background noise, definitely not
	// a meaningful utterance with "jarvis" in it.
	if speechDur < w.opts.MinSegmentDur {
		log.Printf("[wake] discard short segment (%dms speech)", speechDur.Milliseconds())
		return
	}
	if len(pcm) == 0 {
		return
	}

	segmentID := fmt.Sprintf("wake-%d", now.UnixMilli())
	durMs := int64(speechDur / time.Millisecond)
	totalMs := int64(totalDur / time.Millisecond)
	log.Printf("[wake] emit segment %s (%d PCM bytes, %dms speech, %dms total)",
		segmentID, len(pcm), durMs, totalMs)

	evt := SidecarEvent{
		Type:      "sidecar_event",
		EventType: "audio.wake_segment",
		Timestamp: now.UnixMilli(),
		Priority:  "low",
		Payload: map[string]any{
			"segment_id":  segmentID,
			"speech_ms":   durMs,
			"total_ms":    totalMs,
			"sample_rate": pebbleAudioSampleRate,
			"channels":    pebbleAudioChannels,
			"format":      "pcm_s16le",
		},
		// MimeType is a hint; the sender inlines small segments and routes
		// large ones through a separate binary frame.
		Binary: BinaryDataInline{
			Type:     "inline",
			MimeType: "audio/pcm",
		},
	}
	if err := w.sender(ctx, evt, pcm); err != nil {
		log.Printf("[wake] failed to emit segment: %v", err)
	}
}

func (w *WakeListenerService) resetSegment() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.segBuf = nil
	w.speechSeen = false
}
