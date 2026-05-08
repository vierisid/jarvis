package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

const (
	minReconnectDelay = 1 * time.Second
	maxReconnectDelay = 60 * time.Second
)

type SidecarClient struct {
	config          *SidecarConfig
	claims          *SidecarTokenClaims
	handlers        map[string]RPCHandler
	conn            *websocket.Conn
	reconnectDelay  time.Duration
	stopped         bool
	availableCaps   []SidecarCapability
	unavailableCaps []UnavailableCapability

	obsCancel context.CancelFunc // cancel function for running observers
	obsCtx    context.Context    // parent context (from connectAndServe's ctx)
	sendFn    EventSender        // event sender for observers
	mu        sync.Mutex         // protects handlers/obsCancel during reload

	panels   PanelService          // native window service (lazily set when CapWindows enabled)
	pebble   PebbleService         // native pebble overlay (lazily set when CapPebble enabled)
	playback *AudioPlaybackService // pebble TTS playback (alongside CapPebble)
	regions  RegionSelectionService // T19 drag-select capture (alongside CapPebble)
}

func NewSidecarClient(config *SidecarConfig) (*SidecarClient, error) {
	claims, err := DecodeJWTPayload(config.Token)
	if err != nil {
		return nil, fmt.Errorf("decode token: %w", err)
	}
	if override := normalizeBrainOverride(config.Brain); override != "" {
		claims.Brain = override
	}

	client := &SidecarClient{
		config:         config,
		claims:         claims,
		reconnectDelay: minReconnectDelay,
	}
	client.runPreflight()
	client.panels = maybeNewPanelService(client.availableCaps)
	client.pebble = maybeNewPebbleService(client.availableCaps)
	if client.pebble != nil {
		// Playback service rides alongside the pebble — same capability gate
		// (CapPebble) since both are part of the ambient voice loop.
		client.playback = NewAudioPlaybackService()
		// Region selection (T19) — same gate; spawning the overlay only
		// makes sense when the ambient UI is active.
		client.regions = NewRegionSelectionService()
	}
	client.handlers = NewHandlerRegistry(config, client.availableCaps, client.panels, client.pebble, client.playback, client.regions, client.reloadConfig)
	return client, nil
}

// maybeNewPanelService returns a PanelService if CapWindows is enabled,
// otherwise nil. Handlers gate on nil so the rest of the system still works
// when panels are disabled.
func maybeNewPanelService(caps []SidecarCapability) PanelService {
	for _, c := range caps {
		if c == CapWindows {
			return NewPanelService()
		}
	}
	return nil
}

// maybeNewPebbleService mirrors maybeNewPanelService for the native pebble
// overlay. Returns nil if CapPebble isn't enabled so the rest of the
// sidecar still functions.
func maybeNewPebbleService(caps []SidecarCapability) PebbleService {
	for _, c := range caps {
		if c == CapPebble {
			return NewPebbleService()
		}
	}
	return nil
}

func normalizeBrainOverride(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "ws://") || strings.HasPrefix(trimmed, "wss://") {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
		u, err := url.Parse(trimmed)
		if err != nil || u.Host == "" {
			return trimmed
		}
		wsScheme := "ws"
		if u.Scheme == "https" {
			wsScheme = "wss"
		}
		return fmt.Sprintf("%s://%s/sidecar/connect", wsScheme, u.Host)
	}

	wsScheme := "wss"
	if strings.Contains(trimmed, "localhost") || strings.Contains(trimmed, "127.0.0.1") || strings.Contains(trimmed, ":") {
		wsScheme = "ws"
	}
	return fmt.Sprintf("%s://%s/sidecar/connect", wsScheme, trimmed)
}

func (c *SidecarClient) Start(ctx context.Context) {
	c.stopped = false
	for !c.stopped {
		err := c.connectAndServe(ctx)
		if c.stopped {
			return
		}
		if err != nil {
			log.Printf("[sidecar] Disconnected: %v", err)
		}
		log.Printf("[sidecar] Reconnecting in %s...", c.reconnectDelay)
		select {
		case <-time.After(c.reconnectDelay):
		case <-ctx.Done():
			return
		}
		c.reconnectDelay = min(c.reconnectDelay*2, maxReconnectDelay)
	}
}

func (c *SidecarClient) Stop() {
	c.stopped = true
	if c.panels != nil {
		c.panels.Stop()
	}
	if c.pebble != nil {
		_ = c.pebble.Close()
	}
	if c.conn != nil {
		c.conn.Close(websocket.StatusNormalClosure, "client shutdown")
		c.conn = nil
	}
}

func (c *SidecarClient) reloadConfig() {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Re-run preflight checks (capabilities or tools may have changed)
	c.runPreflight()

	// (Re-)init panel service if CapWindows toggled on; tear it down if off.
	hasWindows := false
	for _, cap := range c.availableCaps {
		if cap == CapWindows {
			hasWindows = true
			break
		}
	}
	if hasWindows && c.panels == nil {
		c.panels = NewPanelService()
	} else if !hasWindows && c.panels != nil {
		c.panels.Stop()
		c.panels = nil
	}

	hasPebble := false
	for _, cap := range c.availableCaps {
		if cap == CapPebble {
			hasPebble = true
			break
		}
	}
	if hasPebble && c.pebble == nil {
		c.pebble = NewPebbleService()
		c.playback = NewAudioPlaybackService()
		c.regions = NewRegionSelectionService()
	} else if !hasPebble && c.pebble != nil {
		_ = c.pebble.Close()
		c.pebble = nil
		c.playback = nil
		c.regions = nil
	}

	// Rebuild handler registry (picks up capability changes)
	c.handlers = NewHandlerRegistry(c.config, c.availableCaps, c.panels, c.pebble, c.playback, c.regions, c.reloadConfig)

	// Restart observers (picks up interval/threshold changes)
	if c.obsCancel != nil {
		c.obsCancel()
	}
	if c.obsCtx != nil && c.sendFn != nil {
		newCtx, cancel := context.WithCancel(c.obsCtx)
		c.obsCancel = cancel
		StartObservers(newCtx, c.config, c.availableCaps, c.sendFn)
	}

	// Send capabilities update so the brain updates its capabilities list
	if c.obsCtx != nil {
		if err := c.sendCapabilitiesUpdate(c.obsCtx); err != nil {
			log.Printf("[sidecar] Failed to send capabilities update after config reload: %v", err)
		}
	}

	log.Println("[sidecar] Config reloaded: handlers rebuilt, observers restarted")
}

func (c *SidecarClient) runPreflight() {
	c.availableCaps, c.unavailableCaps = CheckCapabilities(c.config)
	if len(c.unavailableCaps) > 0 {
		for _, u := range c.unavailableCaps {
			log.Printf("[sidecar] Capability %q unavailable: %s", u.Name, u.Reason)
		}
	}
	log.Printf("[sidecar] Available capabilities: %v", c.availableCaps)
}

func (c *SidecarClient) connectAndServe(ctx context.Context) error {
	log.Printf("[sidecar] Connecting to %s...", c.claims.Brain)

	conn, _, err := websocket.Dial(ctx, c.claims.Brain, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer " + c.config.Token},
		},
	})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	c.conn = conn
	// Allow large messages (10MB)
	conn.SetReadLimit(10 * 1024 * 1024)

	log.Println("[sidecar] Connected")
	c.reconnectDelay = minReconnectDelay

	if err := c.sendRegistration(ctx); err != nil {
		return fmt.Errorf("registration: %w", err)
	}

	// Start observers (clipboard, etc.) — cancelled when connection drops
	obsCtx, obsCancel := context.WithCancel(ctx)
	defer obsCancel()

	sendFn := func(ctx context.Context, event SidecarEvent, binaryData []byte) error {
		return c.sendEvent(ctx, event, binaryData)
	}

	c.mu.Lock()
	c.obsCtx = ctx // store parent context so reloadConfig can create fresh children
	c.obsCancel = obsCancel
	c.sendFn = sendFn
	c.mu.Unlock()

	StartObservers(obsCtx, c.config, c.availableCaps, sendFn)

	// Wire the pebble's summon hotkey to the brain via a SidecarEvent.
	// The daemon listens for "pebble.summon" and drives state transitions
	// via pebble.set_state RPC — so the brain stays the source of truth
	// for what happens after summon (voice capture / LLM / TTS / element
	// pointing). Pebble itself is purely visual.
	if c.pebble != nil {
		audioSvc := NewAudioCaptureService()

		// Sidecar-native wake-word listener (T16). Always on whenever the
		// pebble is — no separate config gate, since the pebble is the
		// whole reason wake-word matters. Emits one `audio.wake_segment`
		// per VAD-detected utterance to the daemon, which transcribes +
		// regex-matches "jarvis". Pauses around Ctrl+Space session
		// captures so it doesn't fight for the mic device.
		wakeListener := NewWakeListenerService(audioSvc, sendFn, DefaultWakeListenerOpts())
		if err := wakeListener.Start(ctx); err != nil {
			log.Printf("[wake] failed to start: %v", err)
			wakeListener = nil
		}

		// Suppress wake captures while TTS is playing so JARVIS's own
		// voice through the speakers doesn't trigger a self-wake. Hooked
		// via the playback service's state-change callback.
		if wakeListener != nil && c.playback != nil {
			c.playback.SetPlayStateListener(func(playing bool) {
				wakeListener.Suppress(playing)
			})
		}

		// runSessionCapture handles one summon→capture→stream cycle. Used
		// by both the Ctrl+Space hotkey path and the wake-word follow-up
		// path (when the daemon dispatches `pebble.start_listening` after
		// matching a wake phrase that had no trailing command).
		var sessionInFlight atomic.Bool
		runSessionCapture := func(sessionID string) {
			if !sessionInFlight.CompareAndSwap(false, true) {
				log.Printf("[audio] session %s skipped — capture already in flight", sessionID)
				return
			}
			defer sessionInFlight.Store(false)

			startEvt := SidecarEvent{
				Type:      "sidecar_event",
				EventType: "audio.session_start",
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload: map[string]any{
					"session_id":  sessionID,
					"sample_rate": pebbleAudioSampleRate,
					"channels":    pebbleAudioChannels,
					"format":      "pcm_s16le",
				},
			}
			_ = sendFn(ctx, startEvt, nil)

			if wakeListener != nil {
				wakeListener.Pause()
				defer wakeListener.Resume(ctx)
			}
			pcm, dur, err := pebbleCaptureWithVAD(audioSvc, sessionID, DefaultVADOpts())
			if err != nil {
				log.Printf("[audio] capture failed: %v", err)
				return
			}

			endEvt := SidecarEvent{
				Type:      "sidecar_event",
				EventType: "audio.session_end",
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload: map[string]any{
					"session_id":  sessionID,
					"duration_ms": dur.Milliseconds(),
					"sample_rate": pebbleAudioSampleRate,
					"channels":    pebbleAudioChannels,
					"format":      "pcm_s16le",
				},
				Binary: BinaryDataInline{
					Type:     "inline",
					MimeType: "audio/pcm",
					Data:     base64.StdEncoding.EncodeToString(pcm),
				},
			}
			if err := sendFn(ctx, endEvt, nil); err != nil {
				log.Printf("[audio] failed to emit session_end event: %v", err)
			} else {
				log.Printf("[audio] streamed session %s to daemon (%d PCM bytes, %.2fs)", sessionID, len(pcm), dur.Seconds())
			}
		}

		c.pebble.OnSummon(func() {
			sessionID := fmt.Sprintf("%d", time.Now().UnixMilli())
			summonEvt := SidecarEvent{
				Type:      "sidecar_event",
				EventType: "pebble.summon",
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload:   map[string]any{"session_id": sessionID},
			}
			if err := sendFn(ctx, summonEvt, nil); err != nil {
				log.Printf("[pebble] failed to emit summon event: %v", err)
			}
			go runSessionCapture(sessionID)
		})

		// W4 — palette hotkey (Ctrl+K) emits a "pebble.palette" event with
		// the current cursor position. The daemon owns the open/close
		// lifecycle of the palette panel itself; the sidecar's only job is
		// to surface the keypress + cursor coords.
		c.pebble.OnPalette(func() {
			cx, cy := 0, 0
			if x, y, err := platformGetCursorPos(); err == nil {
				cx, cy = x, y
			}
			log.Printf("[pebble] emitting pebble.palette event (cursor=%d,%d)", cx, cy)
			paletteEvt := SidecarEvent{
				Type:      "sidecar_event",
				EventType: "pebble.palette",
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload:   map[string]any{"cursor_x": cx, "cursor_y": cy},
			}
			if err := sendFn(ctx, paletteEvt, nil); err != nil {
				log.Printf("[pebble] failed to emit palette event: %v", err)
			} else {
				log.Printf("[pebble] pebble.palette event sent to daemon")
			}
		})
		log.Printf("[pebble] OnPalette callback registered")

		// pebble.start_listening — daemon-driven session capture (no
		// pebble.summon event). Used by the wake-word path: when a wake
		// phrase fires with no trailing command, the daemon transitions
		// the bubble to listening and calls this so the user's next
		// utterance gets captured + streamed just like Ctrl+Space.
		c.mu.Lock()
		c.handlers["pebble.start_listening"] = func(_ map[string]any) (*RPCResult, error) {
			sessionID := fmt.Sprintf("listen-%d", time.Now().UnixMilli())
			go runSessionCapture(sessionID)
			return &RPCResult{Result: map[string]any{"session_id": sessionID, "started": true}}, nil
		}
		c.mu.Unlock()

		// region.start_selection (T19) — start a drag-select overlay.
		// On capture, emit a `region.captured` event with the PNG bytes
		// inline so the daemon can hand it to the LLM. On cancel, emit
		// `region.cancelled` so the daemon can flip the pebble back to
		// idle. Pause the wake listener for the duration so chord-press
		// audio ("help with this") doesn't bleed into the capture.
		if c.regions != nil {
			c.mu.Lock()
			c.handlers["region.start_selection"] = func(_ map[string]any) (*RPCResult, error) {
				selectionID := fmt.Sprintf("region-%d", time.Now().UnixMilli())
				if wakeListener != nil {
					wakeListener.Suppress(true)
				}
				err := c.regions.Start(
					func(pngBytes []byte, w, h int) {
						if wakeListener != nil {
							wakeListener.Suppress(false)
						}
						evt := SidecarEvent{
							Type:      "sidecar_event",
							EventType: "region.captured",
							Timestamp: time.Now().UnixMilli(),
							Priority:  "normal",
							Payload: map[string]any{
								"selection_id": selectionID,
								"width":        w,
								"height":       h,
							},
							Binary: BinaryDataInline{
								Type:     "inline",
								MimeType: "image/png",
								Data:     base64.StdEncoding.EncodeToString(pngBytes),
							},
						}
						if err := sendFn(ctx, evt, nil); err != nil {
							log.Printf("[region] failed to emit captured: %v", err)
						}
					},
					func() {
						if wakeListener != nil {
							wakeListener.Suppress(false)
						}
						evt := SidecarEvent{
							Type:      "sidecar_event",
							EventType: "region.cancelled",
							Timestamp: time.Now().UnixMilli(),
							Priority:  "normal",
							Payload:   map[string]any{"selection_id": selectionID},
						}
						_ = sendFn(ctx, evt, nil)
					},
				)
				if err != nil {
					if wakeListener != nil {
						wakeListener.Suppress(false)
					}
					return nil, err
				}
				return &RPCResult{Result: map[string]any{"selection_id": selectionID, "started": true}}, nil
			}
			c.mu.Unlock()
		}
	}

	return c.readLoop(ctx)
}

func (c *SidecarClient) sendRegistration(ctx context.Context) error {
	hostname, _ := os.Hostname()
	msg := SidecarRegistration{
		Type:                    "register",
		Hostname:                hostname,
		OS:                      runtime.GOOS,
		Platform:                runtime.GOARCH,
		Capabilities:            c.availableCaps,
		UnavailableCapabilities: c.unavailableCaps,
	}
	log.Printf("[sidecar] Identified as %s (%s/%s)", msg.Hostname, msg.OS, msg.Platform)
	return c.sendJSON(ctx, msg)
}

func (c *SidecarClient) sendCapabilitiesUpdate(ctx context.Context) error {
	msg := SidecarCapabilitiesUpdate{
		Type:                    "capabilities_update",
		Capabilities:            c.availableCaps,
		UnavailableCapabilities: c.unavailableCaps,
	}
	log.Printf("[sidecar] Sending capabilities update: %v", c.availableCaps)
	return c.sendJSON(ctx, msg)
}

func (c *SidecarClient) readLoop(ctx context.Context) error {
	for {
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			return err
		}

		var req RPCRequest
		if err := json.Unmarshal(data, &req); err != nil {
			log.Printf("[sidecar] Invalid JSON received")
			continue
		}
		if req.Type != "rpc_request" {
			continue
		}

		log.Printf("[sidecar] RPC %s: %s", req.ID, req.Method)

		c.mu.Lock()
		handler, ok := c.handlers[req.Method]
		c.mu.Unlock()
		if !ok {
			c.sendResult(ctx, req.ID, nil, &rpcError{Code: "METHOD_NOT_FOUND", Message: fmt.Sprintf("Unknown method: %s", req.Method)})
			continue
		}

		// Run handler in goroutine to not block the read loop
		go func(id string, h RPCHandler, params map[string]any) {
			result, err := h(params)
			if err != nil {
				c.sendResult(ctx, id, nil, &rpcError{Code: "HANDLER_ERROR", Message: err.Error()})
				return
			}
			c.sendResult(ctx, id, result, nil)
		}(req.ID, handler, req.Params)
	}
}

type rpcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (c *SidecarClient) sendResult(ctx context.Context, rpcID string, result *RPCResult, rpcErr *rpcError) {
	payload := map[string]any{"rpc_id": rpcID}
	if rpcErr != nil {
		payload["error"] = rpcErr
	} else if result != nil {
		payload["result"] = result.Result
	}

	event := SidecarEvent{
		Type:      "rpc_result",
		EventType: "rpc_result",
		Timestamp: time.Now().UnixMilli(),
		Payload:   payload,
	}
	if result != nil && result.Binary != nil {
		event.Binary = result.Binary
	}

	c.sendJSON(ctx, event)
}

func (c *SidecarClient) sendJSON(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	return c.conn.Write(ctx, websocket.MessageText, data)
}

// sendBinary writes a binary WS frame: [36-byte refId][raw data].
func (c *SidecarClient) sendBinary(ctx context.Context, refId string, data []byte) error {
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	frame := make([]byte, 36+len(data))
	copy(frame[:36], []byte(refId))
	copy(frame[36:], data)
	return c.conn.Write(ctx, websocket.MessageBinary, frame)
}

// sendEvent sends a sidecar event, using binary ref protocol for large binary payloads (>=256KB).
func (c *SidecarClient) sendEvent(ctx context.Context, event SidecarEvent, binaryData []byte) error {
	const binaryRefThreshold = 256 * 1024

	if len(binaryData) > 0 && len(binaryData) >= binaryRefThreshold {
		// Use binary ref protocol: send JSON with ref, then binary frame.
		refId := generateRefID()
		log.Printf("[sidecar] Sending %s via binary ref (%d bytes, ref=%s)", event.EventType, len(binaryData), refId)

		event.Binary = BinaryDataRef{
			Type:     "ref",
			RefID:    refId,
			MimeType: "image/png",
			Size:     len(binaryData),
		}

		if err := c.sendJSON(ctx, event); err != nil {
			return err
		}
		return c.sendBinary(ctx, refId, binaryData)
	}

	if len(binaryData) > 0 {
		// Inline as base64
		event.Binary = BinaryDataInline{
			Type:     "inline",
			MimeType: "image/png",
			Data:     base64Encode(binaryData),
		}
	}

	return c.sendJSON(ctx, event)
}

func base64Encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// generateRefID creates a UUID v4 string (hex + dashes, 36 chars)
// that passes the TS validator's /^[0-9a-f-]{36}$/ check.
func generateRefID() string {
	return uuid.New().String()
}
