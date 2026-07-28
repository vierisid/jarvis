package main

// Native realtime voice controller (gpt-realtime) for the cursor pebble.
//
// Activation: the summon hotkey toggles a perpetual speech-to-speech session
// when the daemon has reported realtime is enabled (pebble.configure_realtime).
// The sidecar is the audio DEVICE; the daemon runs the OpenAI realtime session.
//
//   start:  pause wake listener → open streaming playback → stream 24 kHz mic
//           PCM up as `pebble.audio_frame` events → emit `pebble.realtime_start`
//   live:   daemon streams output PCM down via `pebble.play_pcm` (readLoop
//           fast-path → AudioStreamPlayer.Write); barge-in via `pebble.stop_audio`
//   stop:   stop capture + playback, resume wake, emit `pebble.realtime_stop`
//
// All the hard protocol logic (semantic VAD, barge-in, tools, transcripts)
// lives daemon-side; this only owns the local audio + lifecycle.

import (
	"encoding/base64"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

const realtimeInputSampleRate = 24000 // OpenAI realtime rejects input below 24 kHz

// realtimeFrameMs is the mic batch size streamed per `pebble.audio_frame`.
const realtimeFrameMs = 40

type realtimeVoice struct {
	mu      sync.Mutex
	enabled atomic.Bool // daemon says realtime is configured + available
	active  atomic.Bool // a session is currently live

	capture *AudioCaptureService
	wake    *WakeListenerService
	player  *AudioStreamPlayer

	// Injected so the controller stays decoupled from sendFn/ctx/client types.
	emit       func(eventType string, payload map[string]any) // → sidecar event
	setStream  func(*AudioStreamPlayer)                       // install/clear the readLoop's playback target
	setState   func(PebbleState)                              // drive the pebble visual
	resumeWake func()                                         // re-arm the wake listener (ctx-bound, self-guarded)
	// openAudio dials the dedicated audio WebSocket; onBinary plays inbound PCM,
	// onFlush is barge-in. Returns (writePCM, close, ok=false on dial failure).
	openAudio func(onBinary func([]byte), onFlush func()) (func([]byte) error, func(), bool)

	frameCh    chan []byte
	stopSend   chan struct{}
	audioClose func() // closes the dedicated audio channel (nil when not used)
}

func newRealtimeVoice(
	capture *AudioCaptureService,
	wake *WakeListenerService,
	emit func(string, map[string]any),
	setStream func(*AudioStreamPlayer),
	setState func(PebbleState),
	resumeWake func(),
	openAudio func(onBinary func([]byte), onFlush func()) (func([]byte) error, func(), bool),
) *realtimeVoice {
	return &realtimeVoice{
		capture:    capture,
		wake:       wake,
		emit:       emit,
		setStream:  setStream,
		setState:   setState,
		resumeWake: resumeWake,
		openAudio:  openAudio,
	}
}

// Toggle starts the session if idle, stops it if live. Bound to the summon hotkey.
func (r *realtimeVoice) Toggle() {
	if r.active.Load() {
		log.Printf("[realtime] toggle → stop")
		r.Stop(true)
	} else {
		log.Printf("[realtime] toggle → start")
		r.Start()
	}
}

// Start opens the local audio path and asks the daemon to open the session.
func (r *realtimeVoice) Start() {
	log.Printf("[realtime] Start() invoked (enabled=%v active=%v)", r.enabled.Load(), r.active.Load())
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active.CompareAndSwap(false, true) {
		return
	}

	player := NewAudioStreamPlayer()
	if err := player.Start(); err != nil {
		log.Printf("[realtime] playback device failed: %v", err)
		r.active.Store(false)
		return
	}
	r.player = player
	r.setStream(player)

	if r.wake != nil {
		r.wake.Pause()
	}
	// Focus mode: pause the heavy ambient screen observer (2.4 MB capture + OCR
	// per tick) so it doesn't contend with the audio stream on the shared WS,
	// and so its reactor (set_eye flood, proactive narration, autonomous agent
	// actions) stays quiet during the conversation.
	ambientSuppressed.Store(true)

	// Open the dedicated audio channel (isolated from the bulk control
	// connection). Inbound binary plays through this session's stream player;
	// a text {flush} is barge-in. If the dial fails, audioWrite stays nil and
	// the sender below falls back to streaming over the main connection.
	pl := player
	var audioWrite func([]byte) error
	if r.openAudio != nil {
		if w, closeFn, ok := r.openAudio(
			func(b []byte) { pl.Write(b) },
			func() { pl.Flush() },
		); ok {
			audioWrite = w
			r.audioClose = closeFn
		}
	}

	// Decouple the audio capture thread from the network: the malgo callback
	// batches ~40 ms frames onto frameCh; a sender goroutine ships them — over
	// the dedicated audio channel when available (raw binary, isolated), else
	// over the main connection as a base64 event. A backed-up network drops
	// frames rather than stalling capture.
	r.frameCh = make(chan []byte, 64)
	r.stopSend = make(chan struct{})
	frameCh, stopSend := r.frameCh, r.stopSend
	go func() {
		sent := 0
		for {
			select {
			case out := <-frameCh:
				sent++
				if sent == 1 || sent%125 == 0 { // first frame, then every ~5 s
					log.Printf("[realtime] mic frames streamed up: %d (channel=%v)", sent, audioWrite != nil)
				}
				if audioWrite != nil {
					if err := audioWrite(out); err != nil {
						// Channel died mid-session — fall back for this frame.
						r.emit("pebble.audio_frame", map[string]any{"data": base64.StdEncoding.EncodeToString(out)})
					}
				} else {
					r.emit("pebble.audio_frame", map[string]any{"data": base64.StdEncoding.EncodeToString(out)})
				}
			case <-stopSend:
				return
			}
		}
	}()

	const frameBytes = realtimeInputSampleRate * 2 * realtimeFrameMs / 1000 // s16 mono
	var acc []byte
	gated := false
	r.capture.SetChunkListener(func(chunk []byte) {
		// Half-duplex echo guard: while the assistant is speaking through the
		// speakers, drop mic audio so its own voice doesn't reach OpenAI and
		// self-interrupt via server VAD. (The browser path uses getUserMedia
		// AEC instead; the native mic has none, so we gate. Headphone users
		// would prefer full-duplex barge-in — that needs real AEC, a follow-up.)
		active := player.IsActive()
		if active != gated {
			gated = active
			if active {
				log.Printf("[realtime] mic gated (assistant speaking)")
			} else {
				log.Printf("[realtime] mic open")
			}
		}
		if active {
			acc = acc[:0] // drop any partial so stale pre-gate audio isn't sent on resume
			return
		}
		acc = append(acc, chunk...)
		for len(acc) >= frameBytes {
			out := append([]byte(nil), acc[:frameBytes]...)
			acc = acc[frameBytes:]
			select {
			case frameCh <- out:
			default: // network backed up — drop, keep capture real-time
			}
		}
	})

	// Opening the mic right after pausing the wake listener can race that
	// device's teardown, so the first Start may fail. Retry briefly (the wake
	// Resume path does the same).
	var capErr error
	for attempt := 0; attempt < 4; attempt++ {
		if capErr = r.capture.Start(fmt.Sprintf("rt-%d", time.Now().UnixMilli())); capErr == nil {
			break
		}
		log.Printf("[realtime] mic capture attempt %d failed: %v", attempt+1, capErr)
		time.Sleep(150 * time.Millisecond)
	}
	if capErr != nil {
		log.Printf("[realtime] mic capture failed after retries: %v", capErr)
		r.capture.SetChunkListener(nil)
		close(stopSend)
		r.stopSend = nil
		r.frameCh = nil
		if r.audioClose != nil {
			r.audioClose()
			r.audioClose = nil
		}
		r.setStream(nil)
		player.Stop()
		r.player = nil
		ambientSuppressed.Store(false) // Stop() won't run (active already false) — resume screen awareness here
		r.resumeWake()
		r.active.Store(false)
		return
	}

	r.emit("pebble.realtime_start", map[string]any{})
	r.setState(PebbleListening)
	log.Printf("[realtime] session started (mic %d Hz streaming, %d ms frames)", realtimeInputSampleRate, realtimeFrameMs)
}

// Stop tears the session down. emit=true also tells the daemon to close it
// (hotkey / config-disable); emit=false is for daemon-initiated teardown
// (budget / timeout / error), where the daemon already closed its side.
func (r *realtimeVoice) Stop(emit bool) {
	log.Printf("[realtime] Stop(emit=%v) invoked (active=%v)", emit, r.active.Load())
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.active.CompareAndSwap(true, false) {
		return
	}

	// Clear the listener and stop capture FIRST so the malgo callback is joined
	// before we close frameCh (no send-on-closed-channel race).
	r.capture.SetChunkListener(nil)
	_, _, _ = r.capture.Stop()
	if r.stopSend != nil {
		close(r.stopSend)
		r.stopSend = nil
	}
	r.frameCh = nil

	// Close the dedicated audio channel (its read loop exits when the conn closes).
	if r.audioClose != nil {
		r.audioClose()
		r.audioClose = nil
	}

	r.setStream(nil)
	if r.player != nil {
		r.player.Stop()
		r.player = nil
	}
	ambientSuppressed.Store(false) // resume ambient screen awareness
	r.resumeWake()
	r.setState(PebbleIdle)

	if emit {
		r.emit("pebble.realtime_stop", map[string]any{})
	}
	log.Printf("[realtime] session stopped")
}
