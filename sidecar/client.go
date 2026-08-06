package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
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

// Connection state, surfaced to the tray (icon + status line).
const (
	connConnecting int32 = iota // not connected yet (initial / retrying)
	connConnected               // WS up + registered
	connError                   // last attempt failed (unreachable or token rejected)
)

// tokenRejectedError means the brain was reachable but refused our token during
// the WebSocket handshake (HTTP 401 missing / 403 invalid|revoked), as opposed
// to the brain being unreachable.
type tokenRejectedError struct{ status int }

func (e *tokenRejectedError) Error() string {
	return fmt.Sprintf("brain rejected the sidecar token (HTTP %d)", e.status)
}

type SidecarClient struct {
	config        *SidecarConfig
	claims        *SidecarTokenClaims
	tokenProvider *accessTokenProvider // mints short-lived panel access tokens
	handlers      map[string]RPCHandler
	// conn is read by readLoop/sendJSON/sendBinary (per-connection goroutines)
	// and written by connectAndServe; Stop() clears it from the signal-handler
	// goroutine. atomic.Pointer makes those cross-goroutine accesses race-free
	// (c.mu intentionally does not cover conn).
	conn            atomic.Pointer[websocket.Conn]
	reconnectDelay  time.Duration
	stopped         bool
	incompatible    bool         // brain hard-blocked us (version < MIN); do not reconnect
	connState       atomic.Int32 // connConnecting/connConnected/connError (tray icon + status)
	alertOnce       sync.Once    // show the invalid-token pop-up at most once
	availableCaps   []SidecarCapability
	unavailableCaps []UnavailableCapability

	shutdown  func()             // full process-shutdown (client stop + ctx cancel); set by runWithTray
	obsCancel context.CancelFunc // cancel function for running observers
	obsCtx    context.Context    // parent context (from connectAndServe's ctx)
	sendFn    EventSender        // event sender for observers
	mu        sync.Mutex         // protects handlers/obsCancel during reload

	panels    PanelService           // native window service (lazily set when CapWindows enabled)
	pebble    PebbleService          // native pebble overlay (lazily set when CapPebble enabled)
	subPebble SubPebbleService       // per-sub-agent rail overlays (CapSubPebble)
	playback  *AudioPlaybackService  // pebble TTS playback (alongside CapPebble)
	regions   RegionSelectionService // T19 drag-select capture (alongside CapPebble)

	// Realtime voice (gpt-realtime). streamPlayer is the live PCM playback
	// device, read by the readLoop's pebble.play_pcm fast-path; realtime is the
	// per-connection controller (built in connectAndServe). atomic.Pointer
	// because it's re-assigned on every reconnect while the tray/Cocoa/hotkey
	// threads read it — a plain field is a data race.
	streamPlayer atomic.Pointer[AudioStreamPlayer]
	realtime     atomic.Pointer[realtimeVoice]
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
		tokenProvider:  newAccessTokenProvider(claims.Brain, config.Token),
		reconnectDelay: minReconnectDelay,
	}
	client.runPreflight()
	client.panels = maybeNewPanelService(client.availableCaps)
	client.pebble = maybeNewPebbleService(client.availableCaps)
	client.subPebble = maybeNewSubPebbleService(client.availableCaps)
	if client.pebble != nil {
		// Apply the ethereal preference up front (stored on the core; takes
		// effect whenever the brain spawns the pebble).
		client.pebble.SetEthereal(config.Preferences.EtherealPebble, config.Preferences.EtherealIdleSeconds)
		// Playback service rides alongside the pebble — same capability gate
		// (CapPebble) since both are part of the ambient voice loop.
		client.playback = NewAudioPlaybackService()
		// Region selection (T19) — same gate; spawning the overlay only
		// makes sense when the ambient UI is active.
		client.regions = NewRegionSelectionService()
	}
	client.handlers = NewHandlerRegistry(config, &client.mu, client.availableCaps, client.panels, client.pebble, client.subPebble, client.playback, client.regions, client.reloadConfig, client.claims.Brain, client.tokenProvider.Token)
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

// maybeNewSubPebbleService mirrors the above for the multi-overlay sub-pebble
// service (rail of background-agent indicators). Returns nil if CapSubPebble
// isn't enabled.
func maybeNewSubPebbleService(caps []SidecarCapability) SubPebbleService {
	for _, c := range caps {
		if c == CapSubPebble {
			return NewSubPebbleService()
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

	// Default to TLS. Downgrade to plaintext ws only for loopback or private/LAN
	// addresses (which typically run without a cert); public hosts stay wss so
	// the bearer token is never sent in the clear over the internet. The old
	// `strings.Contains(trimmed, ":")` matched ANY host:port — including public
	// remotes given as bare host:port — and silently downgraded them.
	wsScheme := "wss"
	host := trimmed
	if h, _, err := net.SplitHostPort(trimmed); err == nil {
		host = h
	}
	if host == "localhost" {
		wsScheme = "ws"
	} else if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
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
		if c.incompatible {
			// The brain refused us for being too old. Reconnecting would just be
			// refused again, so stop hammering and leave the loud message up for
			// the user running the sidecar in a terminal.
			log.Printf("[sidecar] Not reconnecting — update the sidecar and restart.")
			return
		}
		var tokErr *tokenRejectedError
		if errors.As(err, &tokErr) {
			// The brain is reachable but the token is invalid/revoked. Retrying
			// with the same token is pointless, so alert the user (once) and stop
			// reconnecting. Stay alive so the tray keeps showing the error state
			// (connError was set in connectAndServe) until the user quits or
			// restarts after fixing the config.
			log.Printf("[sidecar] Token rejected by the brain (HTTP %d). Not reconnecting until reconfigured.", tokErr.status)
			c.alertOnce.Do(func() {
				platformShowAlert("JARVIS Sidecar",
					"This machine's enrollment token is not valid — the brain rejected it.\n\n"+
						"Re-enroll it by running 'jarvis enroll \"<device-name>\"' on the brain machine, update the token in the config, then restart.")
			})
			<-ctx.Done()
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
	if c.subPebble != nil {
		_ = c.subPebble.CloseAll()
	}
	if conn := c.conn.Load(); conn != nil {
		conn.Close(websocket.StatusNormalClosure, "client shutdown")
		c.conn.Store(nil)
	}
	c.connState.Store(connConnecting)
}

// Connected reports whether the sidecar is currently connected + registered to
// the brain. Used by the tray status entry.
func (c *SidecarClient) Connected() bool { return c.connState.Load() == connConnected }

// ConnState reports the live connection state (connConnecting/connConnected/
// connError) for the tray icon + status line.
func (c *SidecarClient) ConnState() int32 { return c.connState.Load() }

// editConfig mutates the live config under the lock and persists it to disk.
// Used by the local settings window, whose bindings run on the webview thread.
func (c *SidecarClient) editConfig(fn func(cfg *SidecarConfig)) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	fn(c.config)
	return SaveConfig(c.config)
}

// BrainOverride returns the config's manual brain-URL override (lock-protected;
// "" when unset). Used by the settings window's token check so a pasted token
// is verified against the URL the client will actually dial.
func (c *SidecarClient) BrainOverride() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.config.Brain
}

// Preferences returns a copy of the current preferences (lock-protected).
func (c *SidecarClient) Preferences() PreferencesConfig {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.config.Preferences
}

// TelemetryEnabled reports whether anonymous sidecar telemetry is on. A nil
// config value (key absent) means on — telemetry is opt-out. Read live so the
// settings-window toggle takes effect without a restart. Env overrides are
// applied by the telemetry loop, not here.
func (c *SidecarClient) TelemetryEnabled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.config.Telemetry.Enabled == nil {
		return true
	}
	return *c.config.Telemetry.Enabled
}

// AvailableCaps returns a copy of the currently-available capabilities. Locked
// because reloadConfig can re-run preflight and replace the slice.
func (c *SidecarClient) AvailableCaps() []SidecarCapability {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]SidecarCapability, len(c.availableCaps))
	copy(out, c.availableCaps)
	return out
}

// UnavailableCaps returns a copy of the capabilities that are enabled but can't
// function on this machine (with reasons). Locked for the same reason.
func (c *SidecarClient) UnavailableCaps() []UnavailableCapability {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]UnavailableCapability, len(c.unavailableCaps))
	copy(out, c.unavailableCaps)
	return out
}

// BrainAnonID returns the brain's anonymous telemetry id from the enrollment
// token, or "" if the token predates sidecar telemetry. Claims are set once at
// construction and never mutated, so no lock is needed.
func (c *SidecarClient) BrainAnonID() string {
	if c.claims == nil {
		return ""
	}
	return c.claims.Bid
}

// SetShutdown registers the full process-shutdown callback (client stop + main
// context cancel) so in-app actions like the settings restart can exit cleanly.
func (c *SidecarClient) SetShutdown(fn func()) { c.shutdown = fn }

// Restart launches a fresh sidecar process and, once it has proven it started
// (didn't crash within restartHealthWindow), shuts this one down — used by the
// settings window after a token change. If the replacement exits immediately
// (e.g. a broken build), the current process is kept alive and the error is
// reported instead of leaving the user with no sidecar.
func (c *SidecarClient) Restart() error {
	cmd, err := relaunchSidecar()
	if err != nil {
		return fmt.Errorf("could not launch a new instance: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case werr := <-exited:
		return fmt.Errorf("the new instance exited immediately: %v", werr)
	case <-time.After(restartHealthWindow):
		// Still running — hand this process off after a brief beat so the UI can
		// render "Restarting…" first.
	}
	go func() {
		time.Sleep(restartHandoffDelay)
		if c.shutdown != nil {
			c.shutdown()
		} else {
			os.Exit(0)
		}
	}()
	return nil
}

// applyPebblePrefs pushes the current pebble-related preferences into the live
// pebble service. Called after the settings window edits them.
func (c *SidecarClient) applyPebblePrefs() {
	if c.pebble != nil {
		p := c.Preferences()
		c.pebble.SetEthereal(p.EtherealPebble, p.EtherealIdleSeconds)
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
		c.pebble.SetEthereal(c.config.Preferences.EtherealPebble, c.config.Preferences.EtherealIdleSeconds)
		c.playback = NewAudioPlaybackService()
		c.regions = NewRegionSelectionService()
	} else if !hasPebble && c.pebble != nil {
		_ = c.pebble.Close()
		c.pebble = nil
		c.playback = nil
		c.regions = nil
	}

	hasSubPebble := false
	for _, cap := range c.availableCaps {
		if cap == CapSubPebble {
			hasSubPebble = true
			break
		}
	}
	if hasSubPebble && c.subPebble == nil {
		c.subPebble = NewSubPebbleService()
	} else if !hasSubPebble && c.subPebble != nil {
		_ = c.subPebble.CloseAll()
		c.subPebble = nil
	}

	// Rebuild handler registry (picks up capability changes)
	c.handlers = NewHandlerRegistry(c.config, &c.mu, c.availableCaps, c.panels, c.pebble, c.subPebble, c.playback, c.regions, c.reloadConfig, c.claims.Brain, c.tokenProvider.Token)

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

	// Snapshot the token under the lock — the settings window can change it on
	// the webview thread. (It applies on the next reconnect / restart.)
	c.mu.Lock()
	token := c.config.Token
	c.mu.Unlock()

	conn, resp, err := websocket.Dial(ctx, c.claims.Brain, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer " + token},
		},
	})
	if err != nil {
		// nhooyr returns the HTTP response on a failed handshake. A 401/403 means
		// the brain was reachable but refused the token; anything else (no
		// response) means we couldn't reach the brain at all (dead server, or a
		// token whose brain URL is wrong/unresolvable).
		c.connState.Store(connError)
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return &tokenRejectedError{status: resp.StatusCode}
		}
		return fmt.Errorf("dial: %w", err)
	}
	// Past the handshake: on any later return (disconnect) drop back to
	// "connecting" so the tray clears the error state during reconnect.
	defer c.connState.Store(connConnecting)
	c.conn.Store(conn)
	// Allow large messages (10MB)
	conn.SetReadLimit(10 * 1024 * 1024)

	log.Println("[sidecar] Connected")
	c.connState.Store(connConnected)
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
		} else {
			// Tear the listener down when this connection ends. audioSvc and
			// wakeListener are constructed fresh per connectAndServe, so without
			// this every reconnect leaked a coordinate() goroutine and a held mic
			// device — after N reconnects, N listeners fight over the microphone.
			// Stop() works via stopCh (not ctx), so it's safe that Start uses the
			// parent ctx (reloadConfig cancels obsCtx and must NOT kill the wake
			// listener). The receiver is bound now, while wakeListener is non-nil.
			defer wakeListener.Stop()
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
				// MimeType is a hint; sendEvent fills Data inline or routes a
				// large payload through a separate binary frame.
				Binary: BinaryDataInline{
					Type:     "inline",
					MimeType: "audio/pcm",
				},
			}
			if err := sendFn(ctx, endEvt, pcm); err != nil {
				log.Printf("[audio] failed to emit session_end event: %v", err)
			} else {
				log.Printf("[audio] streamed session %s to daemon (%d PCM bytes, %.2fs)", sessionID, len(pcm), dur.Seconds())
			}
		}

		// ── Native realtime voice (gpt-realtime) ──────────────────────────
		// When the daemon reports realtime is enabled, the summon hotkey
		// toggles a perpetual speech-to-speech session instead of the one-shot
		// capture above. A dedicated 24 kHz streaming capture feeds the daemon;
		// inbound PCM plays through a persistent low-latency device. See
		// realtimeVoice + PebbleRealtimeManager (daemon side).
		realtimeCapture := NewStreamingCaptureService(realtimeInputSampleRate)
		emit := func(eventType string, payload map[string]any) {
			evt := SidecarEvent{
				Type:      "sidecar_event",
				EventType: eventType,
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload:   payload,
			}
			if err := sendFn(ctx, evt, nil); err != nil {
				log.Printf("[realtime] emit %s failed: %v", eventType, err)
			}
		}
		setStream := func(p *AudioStreamPlayer) { c.streamPlayer.Store(p) }
		setPebbleState := func(s PebbleState) { _ = c.pebble.SetState(s) }
		resumeWake := func() {
			if wakeListener != nil {
				wakeListener.Resume(ctx)
			}
		}
		// openAudio dials a SECOND, dedicated WebSocket (`?channel=audio`) used
		// only for realtime PCM — isolated from this control connection so a
		// 2.4 MB screenshot can't queue in front of audio frames. Returns false
		// (graceful) if the dial fails, in which case the controller falls back
		// to streaming mic over the main connection as `pebble.audio_frame`.
		openAudio := func(onBinary func([]byte), onFlush func()) (func([]byte) error, func(), bool) {
			audioURL := c.claims.Brain + "?channel=audio"
			aconn, _, derr := websocket.Dial(ctx, audioURL, &websocket.DialOptions{
				HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}},
			})
			if derr != nil {
				log.Printf("[realtime] audio channel dial failed (using main connection): %v", derr)
				return nil, nil, false
			}
			aconn.SetReadLimit(4 << 20) // playback deltas can be tens of KB
			go func() {
				for {
					typ, data, rerr := aconn.Read(context.Background())
					if rerr != nil {
						return // conn closed on Stop → read loop exits
					}
					switch typ {
					case websocket.MessageBinary:
						onBinary(data) // playback PCM
					case websocket.MessageText:
						// Control frames are JSON ({"t":"flush"}); parse rather
						// than substring-match so unrelated text can't flush.
						var ctl struct {
							T string `json:"t"`
						}
						if json.Unmarshal(data, &ctl) == nil && ctl.T == "flush" {
							onFlush() // barge-in
						}
					}
				}
			}()
			// Keepalive: the brain's WS server reaps sockets idle >30 s, and an
			// audio channel is legitimately silent between utterances. Ping until
			// the conn dies or the connection context ends; each write is bounded
			// so a wedged TCP conn can't park the goroutine forever.
			go func() {
				t := time.NewTicker(20 * time.Second)
				defer t.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-t.C:
						wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
						err := aconn.Write(wctx, websocket.MessageText, []byte(`{"t":"ping"}`))
						cancel()
						if err != nil {
							return
						}
					}
				}
			}()
			writePCM := func(frame []byte) error {
				return aconn.Write(context.Background(), websocket.MessageBinary, frame)
			}
			closeFn := func() { _ = aconn.Close(websocket.StatusNormalClosure, "") }
			log.Printf("[realtime] dedicated audio channel open")
			return writePCM, closeFn, true
		}
		rt := newRealtimeVoice(realtimeCapture, wakeListener, emit, setStream, setPebbleState, resumeWake, openAudio)
		c.realtime.Store(rt)
		// Tear the session down when this connection ends.
		defer rt.Stop(false)

		// Tray "Mute microphone" toggle → gate the mic locally. Muting ends any
		// live realtime session (which re-arms the wake listener), then releases
		// the always-on wake mic and shows the muted pebble; unmuting re-arms the
		// wake listener and clears the pebble. Note the Stop-then-Pause order:
		// realtime.Stop() calls resumeWake internally, so Pause must come after.
		setTrayApplyMute(func(muted bool) {
			if muted {
				if rt := c.realtime.Load(); rt != nil {
					rt.Stop(true)
				}
				if wakeListener != nil {
					wakeListener.Pause()
				}
				_ = c.pebble.SetState(PebbleMuted)
			} else {
				if wakeListener != nil {
					wakeListener.Resume(ctx)
				}
				_ = c.pebble.SetState(PebbleIdle)
			}
		})
		defer setTrayApplyMute(func(bool) {})

		// Long-answer overflow — click on the "open full ↗" button emits
		// pebble.open_answer with the answer id stored via SetAnswerOverflow.
		c.pebble.OnAnswerOpen(func(answerID string) {
			evt := SidecarEvent{
				Type:      "sidecar_event",
				EventType: "pebble.open_answer",
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload:   map[string]any{"answer_id": answerID},
			}
			if err := sendFn(ctx, evt, nil); err != nil {
				log.Printf("[pebble] failed to emit open_answer event: %v", err)
			} else {
				log.Printf("[pebble] open_answer id=%s emitted", answerID)
			}
		})

		// W6-T2 — long-press on pebble disc emits pebble.blind_toggle.
		// Daemon flips awareness.enabled in config + dispatches set_blinded.
		c.pebble.OnBlindToggle(func() {
			evt := SidecarEvent{
				Type:      "sidecar_event",
				EventType: "pebble.blind_toggle",
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload:   map[string]any{},
			}
			if err := sendFn(ctx, evt, nil); err != nil {
				log.Printf("[pebble] failed to emit blind_toggle event: %v", err)
			} else {
				log.Printf("[pebble] blind_toggle emitted")
			}
		})

		c.pebble.OnSummon(func() {
			// When realtime voice is enabled, the summon hotkey toggles a
			// perpetual speech-to-speech session (press again to end) instead
			// of the one-shot capture → STT → LLM → TTS loop.
			rt := c.realtime.Load()
			rtEnabled := rt != nil && rt.enabled.Load()
			log.Printf("[pebble] summon (realtime_enabled=%v)", rtEnabled)
			if rtEnabled {
				rt.Toggle()
				return
			}
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

		// Phase B — sub-pebble disc clicks emit a `sub_pebble.clicked`
		// event so the daemon can toggle the expand bubble (fetch task
		// data + dispatch sub_pebble.set_expanded). Click handling is
		// per-window via WM_NCHITTEST + WM_LBUTTONUP in the sub-pebble
		// overlay; this is just the transport.
		if c.subPebble != nil {
			c.subPebble.OnClick(func(id string) {
				evt := SidecarEvent{
					Type:      "sidecar_event",
					EventType: "sub_pebble.clicked",
					Timestamp: time.Now().UnixMilli(),
					Priority:  "normal",
					Payload:   map[string]any{"id": id},
				}
				if err := sendFn(ctx, evt, nil); err != nil {
					log.Printf("[sub-pebble] failed to emit clicked event for %s: %v", id, err)
				} else {
					log.Printf("[sub-pebble] clicked id=%s — event sent", id)
				}
			})
			c.subPebble.OnOpenFull(func(id string) {
				evt := SidecarEvent{
					Type:      "sidecar_event",
					EventType: "sub_pebble.open_full",
					Timestamp: time.Now().UnixMilli(),
					Priority:  "normal",
					Payload:   map[string]any{"id": id},
				}
				if err := sendFn(ctx, evt, nil); err != nil {
					log.Printf("[sub-pebble] failed to emit open_full event for %s: %v", id, err)
				} else {
					log.Printf("[sub-pebble] open_full id=%s — event sent", id)
				}
			})
			log.Printf("[sub-pebble] OnClick + OnOpenFull callbacks registered")
		}

		// W3-T1 — panel bounds tracking. The sidecar polls each spawned
		// panel's window rect at 1 Hz; when bounds change (user drag /
		// resize / maximize) we forward a `panel.bounds_changed` event
		// to the daemon so it can persist per-room window state. Only
		// wired here because c.panels may be nil for sidecars lacking
		// the `windows` capability.
		if c.panels != nil {
			c.panels.OnBoundsChanged(func(id PanelID, x, y, w, h int) {
				evt := SidecarEvent{
					Type:      "sidecar_event",
					EventType: "panel.bounds_changed",
					Timestamp: time.Now().UnixMilli(),
					Priority:  "low",
					Payload: map[string]any{
						"panel_id": string(id),
						"x":        x,
						"y":        y,
						"w":        w,
						"h":        h,
					},
				}
				if err := sendFn(ctx, evt, nil); err != nil {
					log.Printf("[panels] failed to emit bounds_changed for %s: %v", id, err)
				}
			})
			// Emit panel.closed when a panel window goes away (user close or
			// Close()) so the daemon can untrack it and not accumulate stale
			// inventory or feed phantom panels to the LLM.
			c.panels.OnClosed(func(id PanelID) {
				evt := SidecarEvent{
					Type:      "sidecar_event",
					EventType: "panel.closed",
					Timestamp: time.Now().UnixMilli(),
					Priority:  "low",
					Payload: map[string]any{
						"panel_id": string(id),
					},
				}
				if err := sendFn(ctx, evt, nil); err != nil {
					log.Printf("[panels] failed to emit panel.closed for %s: %v", id, err)
				}
			})
		}

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

		// Realtime voice control (daemon → sidecar). pebble.play_pcm (the audio
		// output stream) is handled inline in readLoop to preserve frame order.
		c.handlers["pebble.configure_realtime"] = func(params map[string]any) (*RPCResult, error) {
			enabled, _ := params["enabled"].(bool)
			log.Printf("[realtime] configure_realtime enabled=%v", enabled)
			if rt := c.realtime.Load(); rt != nil {
				rt.enabled.Store(enabled)
				if !enabled {
					rt.Stop(true) // disabling mid-session ends it cleanly
				}
			}
			return &RPCResult{Result: map[string]any{"enabled": enabled}}, nil
		}
		// Tray menu live data (brain → sidecar): approvals count, recent
		// activity, pause/mute, brain/sidecar health (design: usejarvis-tray §00).
		c.handlers["tray.status"] = func(params map[string]any) (*RPCResult, error) {
			setTrayStatus(trayStatusFromParams(params))
			return &RPCResult{Result: map[string]any{"ok": true}}, nil
		}
		// Outbound OS notification (brain → sidecar): the four reasons Jarvis
		// interrupts — approval / done / sidecar / update (design: usejarvis-tray
		// §01). The sidecar raises it natively; the choice comes back via
		// notify.action (emitted below).
		c.handlers["notify.show"] = func(params map[string]any) (*RPCResult, error) {
			showNotification(notificationFromParams(params))
			return &RPCResult{Result: map[string]any{"ok": true}}, nil
		}
		setNotifyEmitAction(func(id, kind, action string) {
			_ = c.sendEvent(c.obsCtx, SidecarEvent{
				EventType: "notify.action",
				Timestamp: time.Now().UnixMilli(),
				Priority:  "normal",
				Payload:   map[string]any{"id": id, "kind": kind, "action": action},
			}, nil)
		})
		c.handlers["pebble.realtime_status"] = func(params map[string]any) (*RPCResult, error) {
			state, _ := params["state"].(string)
			// Daemon-initiated teardown (budget / timeout / error): stop the
			// local audio without re-emitting realtime_stop (its side is gone).
			if rt := c.realtime.Load(); rt != nil && (state == "closed" || state == "error") {
				rt.Stop(false)
			}
			return &RPCResult{Result: map[string]any{"ok": true}}, nil
		}
		// Override stop_audio so barge-in flushes the realtime stream player too
		// (not just the clip-based TTS queue).
		c.handlers["pebble.stop_audio"] = func(_ map[string]any) (*RPCResult, error) {
			if c.playback != nil {
				c.playback.Stop()
			}
			if sp := c.streamPlayer.Load(); sp != nil {
				sp.Flush()
			}
			return &RPCResult{Result: map[string]any{"stopped": true}}, nil
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
				// Release suppression exactly once for this selection, however it
				// ends. region.Start calls exactly one of onCapture/onCancel OR
				// returns an error (and some platform stubs fire onCancel AND
				// return), so a sync.Once keeps the counter balanced against the
				// single Suppress(true) below.
				var releaseOnce sync.Once
				releaseSuppress := func() {
					if wakeListener != nil {
						releaseOnce.Do(func() { wakeListener.Suppress(false) })
					}
				}
				if wakeListener != nil {
					wakeListener.Suppress(true)
				}
				err := c.regions.Start(
					func(pngBytes []byte, w, h int) {
						releaseSuppress()
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
							// MimeType is a hint; sendEvent inlines small captures
							// and routes large ones through a separate binary frame.
							Binary: BinaryDataInline{
								Type:     "inline",
								MimeType: "image/png",
							},
						}
						if err := sendFn(ctx, evt, pngBytes); err != nil {
							log.Printf("[region] failed to emit captured: %v", err)
						}
					},
					func() {
						releaseSuppress()
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
					releaseSuppress()
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
		Version:                 sidecarVersion,
		Capabilities:            c.availableCaps,
		UnavailableCapabilities: c.unavailableCaps,
		Timezone:                DetectIANATimezone(),
	}
	log.Printf("[sidecar] Identified as %s (%s/%s) v%s tz=%s", msg.Hostname, msg.OS, msg.Platform, msg.Version, msg.Timezone)
	return c.sendJSON(ctx, msg)
}

// handleRegisterRejected processes a brain `register_rejected` control frame:
// the connecting sidecar is below the brain's hard MIN floor. We log a loud,
// actionable message and flag the client so the reconnect loop stops (an
// incompatible sidecar must not operate, and retrying would only be refused).
func (c *SidecarClient) handleRegisterRejected(data []byte) {
	var msg struct {
		Reason      string `json:"reason"`
		Min         string `json:"min"`
		YourVersion string `json:"your_version"`
	}
	_ = json.Unmarshal(data, &msg)
	c.incompatible = true
	log.Printf("[sidecar] ====================================================================")
	log.Printf("[sidecar] INCOMPATIBLE: this brain requires sidecar >= %s, but this is %s.", msg.Min, msg.YourVersion)
	log.Printf("[sidecar] Update the sidecar (e.g. `bun install -g @usejarvis/sidecar` or")
	log.Printf("[sidecar] grab the latest from GitHub Releases) and restart it.")
	log.Printf("[sidecar] ====================================================================")
}

// handleRegisterAck processes a brain `register_ack`. The brain sends one only
// when it wants to tell us something (currently: an optional update suggestion
// when we're between RECOMMENDED and MIN); a plain accept needs no ack.
func (c *SidecarClient) handleRegisterAck(data []byte) {
	var msg struct {
		UpdateSuggested bool   `json:"update_suggested"`
		Recommended     string `json:"recommended"`
	}
	_ = json.Unmarshal(data, &msg)
	if msg.UpdateSuggested {
		log.Printf("[sidecar] An update is available (this brain recommends sidecar >= %s; running %s). Still compatible.", msg.Recommended, sidecarVersion)
	}
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
	conn := c.conn.Load()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}

		var req RPCRequest
		if err := json.Unmarshal(data, &req); err != nil {
			log.Printf("[sidecar] Invalid JSON received")
			continue
		}
		// Brain-originated control frames (compatibility handshake) arrive on the
		// same socket. Handle them before the RPC fast-path.
		switch req.Type {
		case "register_rejected":
			c.handleRegisterRejected(data)
			return fmt.Errorf("registration rejected by brain")
		case "register_ack":
			c.handleRegisterAck(data)
			continue
		}
		if req.Type != "rpc_request" {
			continue
		}

		// Realtime audio output fast-path: handle pebble.play_pcm INLINE (not in
		// a per-RPC goroutine) so frames reach the playback device in receive
		// order — goroutine reordering would click the audio. Work is just a
		// base64 decode + a buffered append (microseconds).
		if req.Method == "pebble.play_pcm" {
			if sp := c.streamPlayer.Load(); sp != nil {
				if d, ok := req.Params["data"].(string); ok {
					if pcm, err := base64.StdEncoding.DecodeString(d); err == nil {
						sp.Write(pcm)
					}
				}
			}
			c.sendResult(ctx, req.ID, &RPCResult{Result: map[string]any{"ok": true}}, nil)
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
	if result != nil && len(result.BinaryRaw) > 0 {
		// Raw bytes: inline if small, separate binary frame if large.
		mime := result.BinaryMime
		if mime == "" {
			mime = "application/octet-stream"
		}
		if err := c.attachAndSend(ctx, event, result.BinaryRaw, mime); err != nil {
			log.Printf("[sidecar] failed to send rpc_result %s: %v", rpcID, err)
		}
		return
	}
	if result != nil && result.Binary != nil {
		event.Binary = result.Binary
	}

	c.sendJSON(ctx, event)
}

// binaryRefThreshold is the size at or above which binary payloads are sent in
// a separate WebSocket binary frame (ref protocol) instead of inline base64 in
// the JSON message. Keeps JSON frames small so the inbound size cap stays tight.
const binaryRefThreshold = 256 * 1024

// attachAndSend attaches binaryData to event using the ref protocol when large
// or inline base64 when small, then writes it. Shared by sendResult/sendEvent.
func (c *SidecarClient) attachAndSend(ctx context.Context, event SidecarEvent, binaryData []byte, mime string) error {
	if mime == "" {
		mime = "application/octet-stream"
	}
	if len(binaryData) >= binaryRefThreshold {
		refId := generateRefID()
		log.Printf("[sidecar] Sending %s via binary ref (%d bytes, ref=%s)", event.EventType, len(binaryData), refId)
		event.Binary = BinaryDataRef{
			Type:     "ref",
			RefID:    refId,
			MimeType: mime,
			Size:     len(binaryData),
		}
		if err := c.sendJSON(ctx, event); err != nil {
			return err
		}
		return c.sendBinary(ctx, refId, binaryData)
	}
	event.Binary = BinaryDataInline{
		Type:     "inline",
		MimeType: mime,
		Data:     base64Encode(binaryData),
	}
	return c.sendJSON(ctx, event)
}

func (c *SidecarClient) sendJSON(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	conn := c.conn.Load()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

// sendBinary writes a binary WS frame: [36-byte refId][raw data].
func (c *SidecarClient) sendBinary(ctx context.Context, refId string, data []byte) error {
	conn := c.conn.Load()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	frame := make([]byte, 36+len(data))
	copy(frame[:36], []byte(refId))
	copy(frame[36:], data)
	return conn.Write(ctx, websocket.MessageBinary, frame)
}

// sendEvent sends a sidecar event. Large binary payloads (>= the inline
// threshold) travel in a separate WebSocket binary frame; small ones inline as
// base64. The mime type is taken from any inline Binary descriptor the caller
// pre-set as a hint, else defaults to image/png (the common screen-capture
// case). When binaryData is empty the event is sent as-is, preserving any
// Binary the caller already attached.
func (c *SidecarClient) sendEvent(ctx context.Context, event SidecarEvent, binaryData []byte) error {
	if len(binaryData) == 0 {
		return c.sendJSON(ctx, event)
	}
	mime := "image/png"
	if inl, ok := event.Binary.(BinaryDataInline); ok && inl.MimeType != "" {
		mime = inl.MimeType
	}
	return c.attachAndSend(ctx, event, binaryData, mime)
}

func base64Encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// generateRefID creates a UUID v4 string (hex + dashes, 36 chars)
// that passes the TS validator's /^[0-9a-f-]{36}$/ check.
func generateRefID() string {
	return uuid.New().String()
}
