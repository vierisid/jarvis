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
	client.handlers = NewHandlerRegistry(config, client.availableCaps, client.reloadConfig)
	return client, nil
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

	// Rebuild handler registry (picks up capability changes)
	c.handlers = NewHandlerRegistry(c.config, c.availableCaps, c.reloadConfig)

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
