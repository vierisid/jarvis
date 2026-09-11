package main

import (
	"context"
	"log"
	"runtime/debug"
	"sync"
	"time"
)

// goSafeObserver runs an observer in a goroutine guarded by recover(), so a
// panic in one observer (e.g. unexpected subprocess output on some host) is
// logged with its stack and contained — it can no longer take the whole sidecar
// process down. The panic line names the observer so we can see the culprit.
func goSafeObserver(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[observer panic] %s: %v\n%s", name, r, debug.Stack())
			}
		}()
		fn()
	}()
}

// Ambient suppression pauses the heavy screen observer while the pebble is in
// the middle of a voice turn. A tick allocates a full-resolution screenshot
// (5 MB on a real host), diffs it against the previous one, writes a PNG and
// shells out to OCR (~1.6 s observed). Two reasons to hold it off:
//
//   - The audio device callback is a Go function entered from the C audio
//     thread through cgo, and it cannot run during a GC stop-the-world. A
//     missed render deadline is a buffer underrun, audible as a harsh,
//     high-pitched glitch in the middle of TTS.
//   - The capture event makes the brain turn around and pull the image with a
//     fetch_capture RPC, and that multi-megabyte reply shares the sidecar's
//     control WebSocket with the TTS clips (pebble.play_audio), so the audio
//     for the next sentence queues behind it.
//
// Two kinds of hold, because the two callers know different things:
//
//   - ambientHold / ambientRelease: a balanced counter, for a consumer that
//     owns a well-defined span (the realtime session).
//   - ambientHoldFor / ambientEndHoldAfter: a deadline, for the one-shot voice
//     cycle, where the sidecar starts the turn but the daemon owns the middle
//     of it (STT, then the LLM, then TTS) and may never come back. A deadline
//     self-heals: a dropped response un-suppresses on its own instead of
//     stranding screen awareness off forever.
//
// Known limit of the deadline: a turn whose silent middle runs longer than
// voiceTurnAmbientHold (a slow tool call, a very slow first token) expires and
// lets one tick through before the answer arrives. That is the deliberate
// price of self-healing, and it is bounded to a single tick because the first
// TTS clip re-extends the hold.
//
// Suppressed iff the counter is up OR the deadline is still in the future.
// Both live under one mutex rather than in atomics: it keeps the deadline and
// its sequence number consistent with each other, and it lets the deadline be
// a time.Time, which carries a monotonic reading. Wall-clock millis would let
// an NTP correction or a laptop resume, on exactly the two platforms this bug
// was reported on, either extend a hold indefinitely or end it early.
var (
	ambientMu        sync.Mutex
	ambientDepth     int
	ambientHoldUntil time.Time
	ambientHoldSeq   uint64
)

const (
	// voiceTurnAmbientHold is the ceiling on one deadline-held voice turn. It
	// only has to outlast the local capture plus the RPC that follows it: the
	// daemon re-extends on every pebble state change, and playback re-extends
	// for as long as JARVIS is actually speaking. So this is really "how long
	// we stay quiet after the daemon goes silent on us", not the length of a
	// turn. Short enough that a dropped response costs about one screen tick
	// (the observer's default interval is 15 s).
	voiceTurnAmbientHold = 20 * time.Second
	// voiceTurnAmbientTail keeps the observer out of the gap between two
	// streamed TTS sentences (synthesizing the next one takes 300-800 ms)
	// without extending the hold past the end of the answer.
	voiceTurnAmbientTail = 1500 * time.Millisecond
	// pebbleStateAmbientTail is the release once the daemon puts the pebble
	// back to idle: the turn is over, just past the render buffer's tail.
	pebbleStateAmbientTail = 500 * time.Millisecond
)

// ambientHoldUnscoped is the sequence number a caller passes to
// ambientEndHoldAfter when it has no hold of its own to pair with and is
// simply reporting that the turn is over (the daemon putting the pebble back
// to idle). Real sequence numbers start at 1.
const ambientHoldUnscoped uint64 = 0

// ambientSuppressedNow reports whether the ambient screen observer should skip
// this tick.
func ambientSuppressedNow() bool {
	ambientMu.Lock()
	defer ambientMu.Unlock()
	return ambientDepth > 0 || time.Now().Before(ambientHoldUntil)
}

// ambientHold raises the suppression counter. Every call must be paired with
// exactly one ambientRelease.
func ambientHold() {
	ambientMu.Lock()
	ambientDepth++
	ambientMu.Unlock()
}

// ambientRelease lowers the suppression counter, clamped at zero so an
// unbalanced caller can't drive it negative and wedge suppression on.
func ambientRelease() {
	ambientMu.Lock()
	if ambientDepth <= 0 {
		ambientMu.Unlock()
		log.Printf("[observer] ambientRelease with depth already 0, ignoring (unbalanced caller)")
		return
	}
	ambientDepth--
	ambientMu.Unlock()
}

// ambientHoldFor pushes the suppression deadline out to now+d and returns a
// sequence number identifying this hold. The deadline only ever moves forward,
// so a short hold can't cut a longer one short.
func ambientHoldFor(d time.Duration) uint64 {
	ambientMu.Lock()
	defer ambientMu.Unlock()
	ambientHoldSeq++
	if until := time.Now().Add(d); until.After(ambientHoldUntil) {
		ambientHoldUntil = until
	}
	return ambientHoldSeq
}

// ambientEndHoldAfter pulls the suppression deadline in to now+d, releasing a
// hold early because the turn finished. It only ever moves the deadline
// backward, and only when `seq` is still the newest hold: an end event can be
// seconds late (the playback worker debounces its idle announcement), and by
// then a NEW turn may have taken a hold that this stale event must not cut
// short. Pass ambientHoldUnscoped to end whichever hold is current.
func ambientEndHoldAfter(seq uint64, d time.Duration) {
	ambientMu.Lock()
	defer ambientMu.Unlock()
	if seq != ambientHoldUnscoped && seq != ambientHoldSeq {
		return // a newer hold owns the deadline now
	}
	if until := time.Now().Add(d); until.Before(ambientHoldUntil) {
		ambientHoldUntil = until
	}
}

// EventSender sends sidecar events to the brain.
// If binaryData is provided and exceeds the ref threshold, the transport
// will use the binary ref protocol (JSON text frame + binary WS frame)
// instead of base64-inlining the data.
type EventSender func(ctx context.Context, event SidecarEvent, binaryData []byte) error

// ClipboardObserver polls the clipboard and emits events on change.
type ClipboardObserver struct {
	pollInterval time.Duration
	lastContent  string
	mu           sync.Mutex
}

func NewClipboardObserver(pollMs int) *ClipboardObserver {
	if pollMs <= 0 {
		pollMs = 2000
	}
	return &ClipboardObserver{
		pollInterval: time.Duration(pollMs) * time.Millisecond,
	}
}

// Run polls the clipboard until ctx is cancelled, calling send on changes.
func (o *ClipboardObserver) Run(ctx context.Context, send EventSender) {
	// Read initial content
	initial, err := readClipboardContent()
	if err != nil {
		log.Printf("[clipboard] Failed to read initial clipboard: %v", err)
	} else {
		o.mu.Lock()
		o.lastContent = initial
		o.mu.Unlock()
		log.Printf("[clipboard] Initial content: %q", truncate(initial, 50))
	}

	log.Printf("[clipboard] Monitoring clipboard (every %s)", o.pollInterval)

	ticker := time.NewTicker(o.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			content, err := readClipboardContent()
			if err != nil {
				continue
			}

			o.mu.Lock()
			changed := content != o.lastContent
			if changed {
				o.lastContent = content
			}
			o.mu.Unlock()

			if err == nil && !changed {
				// silent poll - no change
			}
			if changed && content != "" {
				log.Printf("[clipboard] Change detected (%d bytes)", len(content))
				event := SidecarEvent{
					Type:      "sidecar_event",
					EventType: "clipboard_change",
					Timestamp: time.Now().UnixMilli(),
					Priority:  "low",
					Payload: map[string]any{
						"content": content,
						"length":  len(content),
					},
				}
				if err := send(ctx, event, nil); err != nil {
					log.Printf("[clipboard] Failed to send event: %v", err)
				}
			}
		}
	}
}

// readClipboardContent reads the system clipboard using platform commands.
func readClipboardContent() (string, error) {
	return platformClipboardRead()
}

// ── Screen Observer ──────────────────────────────────────────────────

// ScreenObserver polls capture_screen at intervals and emits events on change.
// The sidecar saves each capture locally, runs OCR (if available), and emits
// a JSON-only event with the resulting metadata. The image bytes themselves
// are never sent to the brain in the hot path — the brain fetches them on
// demand via the fetch_capture RPC when cloud vision escalation fires.
type ScreenObserver struct {
	intervalMs         int
	minChangeThreshold float64
	previousBuffer     []byte
	mu                 sync.Mutex
	captureCount       int
	ocrEnabled         bool
	captureDir         string
	// captureTTL is the local retention floor for saved screenshots; <= 0
	// disables the sidecar-side sweep (the brain may still clean).
	captureTTL time.Duration
}

func NewScreenObserver(cfg *SidecarConfig, ocrAvailable bool) *ScreenObserver {
	return &ScreenObserver{
		intervalMs:         cfg.Awareness.ScreenIntervalMs,
		minChangeThreshold: cfg.Awareness.MinChangeThreshold,
		ocrEnabled:         cfg.Awareness.OCREnabled && ocrAvailable,
		captureDir:         cfg.Awareness.CaptureDir,
		captureTTL:         captureTTL(cfg),
	}
}

func (o *ScreenObserver) Run(ctx context.Context, send EventSender) {
	log.Printf("[screen] Monitoring screen (every %dms, threshold %.2f)", o.intervalMs, o.minChangeThreshold)

	ticker := time.NewTicker(time.Duration(o.intervalMs) * time.Millisecond)
	defer ticker.Stop()

	// Retention sweep: once at start, then hourly. main.go runs the same
	// sweep for the life of the process; this one exists so a TTL changed
	// through update_config (which restarts the observers) applies at once.
	o.pruneCaptures()
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			o.capture(ctx, send)
		case <-prune.C:
			o.pruneCaptures()
		}
	}
}

func (o *ScreenObserver) pruneCaptures() {
	if o.captureTTL <= 0 || o.captureDir == "" {
		return
	}
	files, dirs, err := pruneCapturesOlderThan(o.captureDir, o.captureTTL)
	if err != nil {
		log.Printf("[screen] Capture retention sweep failed: %v", err)
		return
	}
	if files > 0 || dirs > 0 {
		log.Printf("[screen] Capture retention: removed %d file(s), %d empty dir(s) older than %s", files, dirs, o.captureTTL)
	}
}

func (o *ScreenObserver) capture(ctx context.Context, send EventSender) {
	// Paused for the duration of a voice turn (realtime session, or a one-shot
	// summon, STT, LLM, then TTS cycle): skip the heavy capture+OCR+send so it
	// can't stall the audio callback or queue in front of the TTS clips.
	// Re-checked at each expensive stage below, not just here: a tick that has
	// already started is 6-9 seconds of work on Windows (the OCR helper is a
	// PowerShell subprocess), so a voice turn beginning one tick later would
	// otherwise land right on top of a screenshot, a pixel diff and an OCR
	// subprocess. Aborting mid-capture costs one skipped observation.
	if ambientSuppressedNow() {
		return
	}
	imageData, err := captureScreenBytes()
	if err != nil {
		log.Printf("[screen] Capture failed: %v", err)
		return
	}
	if len(imageData) == 0 {
		return
	}
	if ambientSuppressedNow() {
		return // a voice turn started while we were grabbing the screen
	}

	changePct := o.computePixelDiff(imageData)

	o.mu.Lock()
	hasPrevious := o.previousBuffer != nil
	o.mu.Unlock()

	if changePct < o.minChangeThreshold && hasPrevious {
		return
	}

	o.mu.Lock()
	o.previousBuffer = imageData
	o.captureCount++
	captureId := o.captureCount
	o.mu.Unlock()

	now := time.Now()
	imagePath, err := saveCaptureToFile(o.captureDir, imageData, now)
	if err != nil {
		log.Printf("[screen] Failed to save capture: %v", err)
		return
	}

	var ocrText string
	var ocrDurationMs int64
	if o.ocrEnabled && !ambientSuppressedNow() {
		ocr, err := platformOCR(imagePath)
		if err != nil {
			log.Printf("[screen] OCR failed: %v", err)
		} else {
			ocrText = ocr.Text
			ocrDurationMs = ocr.DurationMs
		}
	}

	appName, windowTitle := platformGetActiveWindow()

	log.Printf("[screen] Change detected (%.1f%%), capture #%d (%d bytes, ocr %dms, %d chars)",
		changePct*100, captureId, len(imageData), ocrDurationMs, len(ocrText))

	event := SidecarEvent{
		Type:      "sidecar_event",
		EventType: "screen_capture",
		Timestamp: now.UnixMilli(),
		Priority:  "normal",
		Payload: map[string]any{
			"pixel_change_pct": changePct,
			"capture_id":       captureId,
			"image_path":       imagePath,
			"ocr_text":         ocrText,
			"ocr_duration_ms":  ocrDurationMs,
			"app_name":         appName,
			"window_title":     windowTitle,
		},
	}

	if ambientSuppressedNow() {
		// A voice turn started while we were capturing. Dropping the event here
		// matters as much as skipping the capture: the brain answers one by
		// pulling the image back with a fetch_capture RPC, and that multi-
		// megabyte reply would land on the connection mid-conversation.
		return
	}
	if err := send(ctx, event, nil); err != nil {
		log.Printf("[screen] Failed to send event: %v", err)
	}
}

func (o *ScreenObserver) computePixelDiff(current []byte) float64 {
	o.mu.Lock()
	prev := o.previousBuffer
	o.mu.Unlock()

	if prev == nil {
		return 1.0
	}
	if len(current) != len(prev) {
		return 1.0
	}

	step := 100
	changed := 0
	total := 0
	for i := 0; i < len(current); i += step {
		total++
		if current[i] != prev[i] {
			changed++
		}
	}
	if total == 0 {
		return 1.0
	}
	return float64(changed) / float64(total)
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// ── Window Observer ─────────────────────────────────────────────────

// WindowObserver polls the active window and emits events on change.
type WindowObserver struct {
	intervalMs       int
	stuckThresholdMs int
	lastApp          string
	lastWindow       string
	sameWindowSince  time.Time
	mu               sync.Mutex
}

func NewWindowObserver(cfg *SidecarConfig) *WindowObserver {
	return &WindowObserver{
		intervalMs:       cfg.Awareness.WindowIntervalMs,
		stuckThresholdMs: cfg.Awareness.StuckThresholdMs,
		sameWindowSince:  time.Now(),
	}
}

func (o *WindowObserver) Run(ctx context.Context, send EventSender) {
	log.Printf("[window] Monitoring active window (every %dms)", o.intervalMs)

	ticker := time.NewTicker(time.Duration(o.intervalMs) * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			o.poll(ctx, send)
		}
	}
}

func (o *WindowObserver) poll(ctx context.Context, send EventSender) {
	appName, windowTitle := platformGetActiveWindow()

	o.mu.Lock()
	prevApp := o.lastApp
	prevWindow := o.lastWindow
	changed := appName != o.lastApp || windowTitle != o.lastWindow

	if changed {
		o.lastApp = appName
		o.lastWindow = windowTitle
		o.sameWindowSince = time.Now()
	}

	stuckDuration := time.Since(o.sameWindowSince)
	stuckMs := int(stuckDuration.Milliseconds())
	stuckThreshold := o.stuckThresholdMs
	currentApp := o.lastApp
	currentWindow := o.lastWindow
	o.mu.Unlock()

	if changed {
		log.Printf("[window] Context changed: %s → %s", prevApp, appName)
		event := SidecarEvent{
			Type:      "sidecar_event",
			EventType: "context_changed",
			Timestamp: time.Now().UnixMilli(),
			Priority:  "normal",
			Payload: map[string]any{
				"from_app":    prevApp,
				"to_app":      appName,
				"from_window": prevWindow,
				"to_window":   windowTitle,
			},
		}
		if err := send(ctx, event, nil); err != nil {
			log.Printf("[window] Failed to send context_changed: %v", err)
		}
	}

	// Idle/stuck detection — fire once when crossing threshold
	if !changed && stuckMs >= stuckThreshold && stuckMs < stuckThreshold+o.intervalMs+500 {
		log.Printf("[window] Idle detected: %s for %ds", currentApp, stuckMs/1000)
		event := SidecarEvent{
			Type:      "sidecar_event",
			EventType: "idle_detected",
			Timestamp: time.Now().UnixMilli(),
			Priority:  "low",
			Payload: map[string]any{
				"app_name":     currentApp,
				"window_title": currentWindow,
				"duration_ms":  stuckMs,
			},
		}
		if err := send(ctx, event, nil); err != nil {
			log.Printf("[window] Failed to send idle_detected: %v", err)
		}
	}
}

// StartObservers launches all enabled observers as goroutines.
// Only capabilities in availableCaps (those that passed preflight) are started.
func StartObservers(ctx context.Context, cfg *SidecarConfig, availableCaps []SidecarCapability, send EventSender) {
	caps := make(map[string]bool)
	for _, c := range availableCaps {
		caps[c] = true
	}

	if caps[CapClipboard] {
		observer := NewClipboardObserver(2000)
		goSafeObserver("clipboard", func() { observer.Run(ctx, send) })
	}

	if caps[CapFileWatch] {
		// Watch the user's home, excluding the shared ~/.jarvis data dir so the
		// sidecar's own captures/logs don't generate awareness noise.
		fo := NewFileObserver([]string{homeDir()}, []string{configDir}, 5000)
		goSafeObserver("file-watcher", func() { fo.Run(ctx, send) })
	}

	if caps[CapProcesses] {
		po := NewProcessObserver(5000)
		goSafeObserver("processes", func() { po.Run(ctx, send) })
	}

	if caps[CapNotifications] {
		no := NewNotificationObserver()
		goSafeObserver("notifications", func() { no.Run(ctx, send) })
	}

	if caps[CapAwareness] {
		so := NewScreenObserver(cfg, caps[CapOCR])
		goSafeObserver("screen", func() { so.Run(ctx, send) })
		wo := NewWindowObserver(cfg)
		goSafeObserver("window", func() { wo.Run(ctx, send) })
	}
}
