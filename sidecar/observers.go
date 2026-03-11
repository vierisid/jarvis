package main

import (
	"context"
	"encoding/base64"
	"log"
	"sync"
	"time"
)

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
type ScreenObserver struct {
	intervalMs         int
	minChangeThreshold float64
	previousBuffer     []byte
	mu                 sync.Mutex
	captureCount       int
}

func NewScreenObserver(cfg *SidecarConfig) *ScreenObserver {
	return &ScreenObserver{
		intervalMs:         cfg.Awareness.ScreenIntervalMs,
		minChangeThreshold: cfg.Awareness.MinChangeThreshold,
	}
}

func (o *ScreenObserver) Run(ctx context.Context, send EventSender) {
	log.Printf("[screen] Monitoring screen (every %dms, threshold %.2f)", o.intervalMs, o.minChangeThreshold)

	ticker := time.NewTicker(time.Duration(o.intervalMs) * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			o.capture(ctx, send)
		}
	}
}

func (o *ScreenObserver) capture(ctx context.Context, send EventSender) {
	result, err := handleCaptureScreen(nil)
	if err != nil {
		log.Printf("[screen] Capture failed: %v", err)
		return
	}

	// Extract the raw image data from the result
	var imageData []byte
	if inline, ok := result.Binary.(BinaryDataInline); ok && inline.Data != "" {
		decoded, err := decodeBase64Data(inline.Data)
		if err != nil {
			log.Printf("[screen] Failed to decode screenshot: %v", err)
			return
		}
		imageData = decoded
	}
	if len(imageData) == 0 {
		return
	}

	// Compute sampled pixel diff
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

	log.Printf("[screen] Change detected (%.1f%%), sending capture #%d (%d bytes)", changePct*100, captureId, len(imageData))

	event := SidecarEvent{
		Type:      "sidecar_event",
		EventType: "screen_capture",
		Timestamp: time.Now().UnixMilli(),
		Priority:  "normal",
		Payload: map[string]any{
			"pixel_change_pct": changePct,
			"capture_id":       captureId,
		},
	}

	// Pass raw binary data to the sender — it will choose inline base64 or
	// binary ref protocol based on the size threshold.
	if err := send(ctx, event, imageData); err != nil {
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

func decodeBase64Data(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

func padTo36(s string) string {
	for len(s) < 36 {
		s += "0"
	}
	if len(s) > 36 {
		s = s[:36]
	}
	return s
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
		go observer.Run(ctx, send)
	}

	if caps[CapAwareness] {
		go NewScreenObserver(cfg).Run(ctx, send)
		go NewWindowObserver(cfg).Run(ctx, send)
	}
}
