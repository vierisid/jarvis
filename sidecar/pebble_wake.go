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
//
// Three independent reasons the mic can be off, deliberately kept apart:
//   - paused        — a consumer borrowed the device and will hand it back
//   - suppressDepth — the device stays open but chunks are dropped (TTS echo,
//                     region-select chord); a counter, since sources overlap
//   - micMuted()    — the USER turned the mic off, indefinitely, from the tray
//
// Only the user clears the last one. Pause/Resume must never lift it.

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
	MinSegmentDur     time.Duration // DEPRECATED: superseded by minWakeSpeechMs; no longer gates emission
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
	// suppressDepth is the lighter-weight gate used while the device stays
	// open but captured chunks must be dropped (TTS playback, region select)
	// so JARVIS's own voice / chord-press audio can't trigger a wake. It is a
	// COUNTER, not a bool, because the sources are independent and can overlap:
	// a bool let whichever source released first re-enable the mic while the
	// other still needed it suppressed. Suppressed iff depth > 0.
	running       atomic.Bool
	paused        atomic.Bool
	suppressDepth atomic.Int32

	stopCh chan struct{}
	doneCh chan struct{}

	// Segmentation state — written from the malgo callback goroutine,
	// read by the coordinator goroutine. Mutex-protected.
	mu              sync.Mutex
	segBuf          []byte
	segFullLogged   bool // one "segment full" line per segment, not per chunk
	speechSeen      bool
	speechChunks    int // count of speech-energy chunks this segment (diagnostic only)
	speechBytes     int // voiced PCM in this segment; what the emit gate measures
	speechStartedAt time.Time
	lastSpeechAt    time.Time
	segStartedAt    time.Time
}

// NewWakeListenerService wires up a wake listener that uses the given
// audio service for capture and the given sender to emit segments. The
// listener does NOT start automatically — call Start() once the websocket
// connection is up so the segments have somewhere to go.
func NewWakeListenerService(audioSvc *AudioCaptureService, sender EventSender, opts WakeListenerOpts) *WakeListenerService {
	w := &WakeListenerService{
		audioSvc: audioSvc,
		sender:   sender,
		opts:     opts,
	}
	// Reserve the segment buffer here, not on first use: the first use is on
	// the audio thread. See appendSegment.
	w.segBuf = make([]byte, 0, w.segmentCapBytes())
	return w
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

	// Muted: come up armed but with the device closed. A reconnect builds a
	// fresh listener, and opening the mic here would re-arm always-on listening
	// while the tray menu still says muted. The coordinator still runs so
	// unmuting (Resume) recovers without a restart.
	if micMuted() {
		w.paused.Store(true)
		log.Printf("[wake] listener started paused — microphone muted")
		go w.coordinate(ctx)
		return nil
	}

	// Hook the chunk listener BEFORE Start so we don't miss any audio.
	w.audioSvc.SetChunkListener(w.onChunk)
	if err := w.audioSvc.StartStreaming(fmt.Sprintf("wake-%d", time.Now().UnixMilli())); err != nil {
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
//
// Pause/Resume is the CONSUMER's momentary device handoff: "off while I use
// the mic, and I'll put it back". It is not the user's mute — mute is a gate
// the user owns indefinitely (micMuted), and Resume refuses to lift it. Those
// two intents used to share this single bit, so a session capture's deferred
// Resume re-armed a mic the user had muted mid-capture.
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

// Resume restarts capture after a Pause(). No-op if not paused, not running,
// or while the user has the microphone muted.
//
// The mute check comes BEFORE the paused CAS on purpose: a refused resume must
// leave paused set, so the listener stays consistently off and unmuting (which
// calls Resume once the gate is clear) is what brings it back.
func (w *WakeListenerService) Resume(ctx context.Context) {
	if !w.running.Load() {
		return
	}
	if micMuted() {
		log.Printf("[wake] resume refused — microphone muted")
		return
	}
	if !w.paused.CompareAndSwap(true, false) {
		return
	}
	w.resetSegment()
	w.audioSvc.SetChunkListener(w.onChunk)
	// The OS may not have released the capture device yet (the session capture
	// we paused for is still tearing down), so a single Start can fail
	// transiently. Retry briefly before giving up.
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if ctx.Err() != nil {
			w.paused.Store(true)
			return
		}
		if err = w.audioSvc.StartStreaming(fmt.Sprintf("wake-%d", time.Now().UnixMilli())); err == nil {
			log.Printf("[wake] resumed")
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Give up cleanly. Leaving running=true/paused=false with no device would
	// strand the listener "running" but deaf forever (the chunk listener is
	// installed yet never fires). Re-arm paused and drop the listener so the
	// state is consistent and a later session capture's deferred Resume — or an
	// explicit Pause/Resume — can recover. Surface loudly.
	w.audioSvc.SetChunkListener(nil)
	w.paused.Store(true)
	log.Printf("[wake] resume failed after retries; listener paused (deaf) until next resume: %v", err)
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

// Suppress raises (true) or lowers (false) the suppression counter. While the
// counter is > 0 every captured chunk is dropped; it returns to normal VAD
// processing only when ALL sources have released. Resets the in-flight segment
// on the 0->1 and 1->0 edges so neither entering nor leaving suppression ships
// a tail of speaker echo. Each Suppress(true) must be paired with exactly one
// Suppress(false); an unbalanced release is clamped at 0 and logged.
func (w *WakeListenerService) Suppress(yes bool) {
	if yes {
		if w.suppressDepth.Add(1) == 1 {
			w.resetSegment() // 0 -> 1 edge
		}
		return
	}
	for {
		cur := w.suppressDepth.Load()
		if cur == 0 {
			log.Printf("[wake] Suppress(false) with depth already 0 — ignoring (unbalanced caller)")
			return
		}
		if w.suppressDepth.CompareAndSwap(cur, cur-1) {
			if cur-1 == 0 {
				w.resetSegment() // 1 -> 0 edge
			}
			return
		}
	}
}

// onChunk runs on the malgo callback goroutine for every PCM buffer.
// Updates the segmentation state under the mutex. Cheap: RMS over one
// capture period (320 samples at the 20 ms the sidecar now requests) is a
// few hundred multiplies. Keep work here minimal so we don't stall the
// audio thread.
func (w *WakeListenerService) onChunk(buf []byte) {
	if w.paused.Load() || w.suppressDepth.Load() > 0 {
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
		w.speechChunks++
		w.speechBytes += len(buf)
		w.lastSpeechAt = now
		w.appendSegment(buf)
		return
	}
	// Silent chunk: append only if we're already mid-segment, so the
	// trailing silence becomes part of the emitted PCM (helps STT not
	// chop final phonemes).
	if w.speechSeen {
		w.appendSegment(buf)
	}
}

// appendSegment adds a chunk to the in-flight segment without ever growing the
// backing array. This runs on the miniaudio callback goroutine, i.e. the audio
// thread: a realloc-and-copy of a few hundred kilobytes there stalls the device
// past its period and underruns, which is audible as a glitch. resetSegment
// reserves the whole cap up front, and the coordinator's MaxSegmentDur is the
// real bound; this ceiling only catches the case where the coordinator's 25 ms
// poll hasn't come round yet. Caller holds w.mu.
func (w *WakeListenerService) appendSegment(buf []byte) {
	if cap(w.segBuf) == 0 {
		// Belt and braces: the constructor reserves this, so reaching here means
		// a listener built some other way. Pay the one allocation rather than
		// going deaf.
		w.segBuf = make([]byte, 0, w.segmentCapBytes())
	}
	if len(w.segBuf)+len(buf) > cap(w.segBuf) {
		if !w.segFullLogged {
			w.segFullLogged = true
			log.Printf("[wake] segment hit its %d byte ceiling; dropping the tail until it is emitted", cap(w.segBuf))
		}
		return // the coordinator's MaxSegmentDur will emit it shortly
	}
	w.segBuf = append(w.segBuf, buf...)
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
// minWakeSpeechMs is the floor on VOICED audio for a segment to be shipped for
// STT: enough to reject stray clicks and keystrokes while still catching a
// single short "Jarvis". (It replaced a first-to-last speech-timestamp span,
// which under-measured clipped words and silently dropped the core wake
// utterance.)
//
// Measured in milliseconds of audio, not in callback buffers. It used to be a
// count of 3 buffers, documented as "~90 ms at the ~30 ms capture buffer", but
// the buffer size is the device's choice, not ours: the host that reported the
// voice bugs ran 160 frames at 16 kHz, i.e. 10 ms, which made the real floor
// 30 ms. That shipped a segment for every noise blip, roughly one STT round
// trip every two seconds while the user was simply talking near the machine.
//
// The effective floor is quantized upward by the capture period: at the 20 ms
// the sidecar requests, four chunks are 80 ms and five are 100 ms, so 100 ms is
// what actually ships. Well under a spoken "Jarvis" (350-500 ms voiced).
const minWakeSpeechMs = 90

// wakeSpeechMs converts a count of captured s16 mono bytes to milliseconds at
// the wake listener's capture format.
func wakeSpeechMs(b int) int {
	bytesPerMs := pebbleAudioSampleRate * pebbleAudioChannels * 2 / 1000
	if bytesPerMs <= 0 {
		return 0
	}
	return b / bytesPerMs
}

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
	// Copy rather than hand the array over: segBuf is reserved once and reused
	// so the audio thread never allocates (see appendSegment). The copy runs
	// here, on the coordinator goroutine, not in the callback.
	pcm := append([]byte(nil), w.segBuf...)
	speechDur := w.lastSpeechAt.Sub(w.speechStartedAt)
	speechChunks := w.speechChunks
	speechMs := wakeSpeechMs(w.speechBytes)
	w.segBuf = w.segBuf[:0]
	w.segFullLogged = false
	w.speechSeen = false
	w.speechChunks = 0
	w.speechBytes = 0
	w.mu.Unlock()

	// Discard tiny blips: most likely background noise, not a real utterance.
	// Gate on the TOTAL voiced audio, not the first-to-last speech timestamp
	// span: a single clipped or quiet word ("Jarvis") whose energy only crosses
	// the threshold in a few non-contiguous chunks has a tiny span yet is
	// exactly what we must catch. Summing voiced audio is gap-tolerant in the
	// same way while staying independent of the device's buffer size. The
	// daemon's STT + "jarvis" regex is the real noise filter, so we err toward
	// keeping borderline segments.
	if speechMs < minWakeSpeechMs {
		log.Printf("[wake] discard short segment (%dms speech in %d chunks, %dms span)",
			speechMs, speechChunks, speechDur.Milliseconds())
		return
	}
	if len(pcm) == 0 {
		return
	}

	segmentID := fmt.Sprintf("wake-%d", now.UnixMilli())
	durMs := int64(speechDur / time.Millisecond)
	totalMs := int64(totalDur / time.Millisecond)
	log.Printf("[wake] emit segment %s (%d PCM bytes, %dms voiced, %dms span, %dms total)",
		segmentID, len(pcm), speechMs, durMs, totalMs)

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
	if w.segBuf == nil {
		w.segBuf = make([]byte, 0, w.segmentCapBytes())
	} else {
		w.segBuf = w.segBuf[:0]
	}
	w.segFullLogged = false
	w.speechSeen = false
	w.speechChunks = 0
	w.speechBytes = 0
}

// segmentCapBytes reserves one segment's worth of PCM: the hard cap on segment
// length plus a second of slack for the coordinator's poll interval, at the
// capture format (s16 mono, 16 kHz).
func (w *WakeListenerService) segmentCapBytes() int {
	d := w.opts.MaxSegmentDur
	if d <= 0 {
		d = 12 * time.Second
	}
	return int((d+time.Second)/time.Second) * pebbleAudioSampleRate * pebbleAudioChannels * 2
}
