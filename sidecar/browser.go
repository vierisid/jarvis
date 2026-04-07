package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
)

// ── CDP Client ───────────────────────────────────────────────────────

// cdpClient manages a Chrome DevTools Protocol connection.
type cdpClient struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	port    int
	msgID   atomic.Int64
	pending map[int64]chan json.RawMessage
	pendMu  sync.Mutex
}

var activeCDP struct {
	mu     sync.Mutex
	client *cdpClient
	port   int
}

func getCDP(cfg *SidecarConfig) (*cdpClient, error) {
	activeCDP.mu.Lock()
	defer activeCDP.mu.Unlock()

	port := cfg.Browser.CDPPort
	if port == 0 {
		port = 9222
	}

	if activeCDP.client != nil && activeCDP.port == port {
		return activeCDP.client, nil
	}

	client, err := newCDPClient(port)
	if err != nil {
		return nil, err
	}

	activeCDP.client = client
	activeCDP.port = port
	return client, nil
}

func newCDPClient(port int) (*cdpClient, error) {
	// Get the first page's WebSocket URL from Chrome's /json endpoint
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := fmt.Sprintf("http://localhost:%d/json", port)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Chrome not running on port %d — launch Chrome with --remote-debugging-port=%d: %w", port, port, err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var targets []struct {
		WebSocketDebuggerUrl string `json:"webSocketDebuggerUrl"`
		Type                 string `json:"type"`
	}
	if err := json.Unmarshal(body, &targets); err != nil {
		return nil, fmt.Errorf("parse CDP targets: %w", err)
	}

	wsURL := ""
	for _, t := range targets {
		if t.Type == "page" && t.WebSocketDebuggerUrl != "" {
			wsURL = t.WebSocketDebuggerUrl
			break
		}
	}
	if wsURL == "" {
		return nil, fmt.Errorf("no CDP page target found on port %d", port)
	}

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("CDP WebSocket dial: %w", err)
	}
	conn.SetReadLimit(50 * 1024 * 1024)

	c := &cdpClient{
		conn:    conn,
		port:    port,
		pending: make(map[int64]chan json.RawMessage),
	}

	// Start read loop
	go c.readLoop()

	return c, nil
}

func (c *cdpClient) readLoop() {
	for {
		_, data, err := c.conn.Read(context.Background())
		if err != nil {
			c.close()
			return
		}
		var msg struct {
			ID     int64           `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if msg.ID == 0 {
			continue // event, ignore
		}

		c.pendMu.Lock()
		ch, ok := c.pending[msg.ID]
		if ok {
			delete(c.pending, msg.ID)
		}
		c.pendMu.Unlock()

		if ok {
			if msg.Error != nil {
				ch <- msg.Error
			} else {
				ch <- msg.Result
			}
		}
	}
}

func (c *cdpClient) send(method string, params map[string]any) (json.RawMessage, error) {
	id := c.msgID.Add(1)
	ch := make(chan json.RawMessage, 1)

	c.pendMu.Lock()
	c.pending[id] = ch
	c.pendMu.Unlock()

	msg := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}

	data, _ := json.Marshal(msg)
	c.mu.Lock()
	err := c.conn.Write(context.Background(), websocket.MessageText, data)
	c.mu.Unlock()
	if err != nil {
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, err
	}

	select {
	case result := <-ch:
		return result, nil
	case <-time.After(30 * time.Second):
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, fmt.Errorf("CDP timeout for %s", method)
	}
}

func (c *cdpClient) close() {
	activeCDP.mu.Lock()
	if activeCDP.client == c {
		activeCDP.client = nil
	}
	activeCDP.mu.Unlock()
	c.conn.Close(websocket.StatusNormalClosure, "closing")
}

// ── Browser Handlers ─────────────────────────────────────────────────

func makeBrowserNavigateHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		url, _ := params["url"].(string)
		if url == "" {
			return nil, fmt.Errorf("missing required parameter: url")
		}

		cdp, err := getCDP(cfg)
		if err != nil {
			return nil, err
		}

		result, err := cdp.send("Page.navigate", map[string]any{"url": url})
		if err != nil {
			return nil, fmt.Errorf("navigate failed: %w", err)
		}

		// Wait for page load
		time.Sleep(1 * time.Second)

		// Get page content
		snapshot, _ := getBrowserSnapshot(cdp)

		return &RPCResult{Result: map[string]any{
			"success":  true,
			"url":      url,
			"navigate": json.RawMessage(result),
			"snapshot": snapshot,
		}}, nil
	}
}

func makeBrowserSnapshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		cdp, err := getCDP(cfg)
		if err != nil {
			return nil, err
		}

		snapshot, err := getBrowserSnapshot(cdp)
		if err != nil {
			return nil, err
		}

		return &RPCResult{Result: snapshot}, nil
	}
}

func makeBrowserClickHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		elemID, ok := params["element_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("missing required parameter: element_id")
		}
		if elemID < 1 || math.Trunc(elemID) != elemID {
			return nil, fmt.Errorf("invalid element_id: must be a positive integer")
		}

		cdp, err := getCDP(cfg)
		if err != nil {
			return nil, err
		}

		// Use JavaScript to find and click element by index
		script := fmt.Sprintf(`
(function() {
    var els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], [tabindex]');
    var el = els[%d];
    if (!el) return JSON.stringify({error: "Element not found", id: %d});
    el.click();
    return JSON.stringify({success: true, tag: el.tagName, id: %d});
})()
`, int(elemID)-1, int(elemID), int(elemID))

		result, err := cdp.send("Runtime.evaluate", map[string]any{
			"expression":    script,
			"returnByValue": true,
		})
		if err != nil {
			return nil, fmt.Errorf("click failed: %w", err)
		}

		return &RPCResult{Result: map[string]any{"result": json.RawMessage(result)}}, nil
	}
}

func makeBrowserTypeHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		text, _ := params["text"].(string)
		if text == "" {
			return nil, fmt.Errorf("missing required parameter: text")
		}
		rawElemID, elementIDProvided := params["element_id"]
		elemID, hasElem := rawElemID.(float64)
		if elementIDProvided && !hasElem {
			return nil, fmt.Errorf("invalid element_id: must be a positive integer")
		}
		if hasElem && (elemID < 1 || math.Trunc(elemID) != elemID) {
			return nil, fmt.Errorf("invalid element_id: must be a positive integer")
		}
		submit, _ := params["submit"].(bool)

		cdp, err := getCDP(cfg)
		if err != nil {
			return nil, err
		}

		if hasElem {
			// Focus and set value on element
			script := fmt.Sprintf(`
(function() {
    var els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], [tabindex]');
    var el = els[%d];
    if (!el) return JSON.stringify({error: "Element not found"});
    el.focus();
    el.value = %s;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return JSON.stringify({success: true, tag: el.tagName});
})()
`, int(elemID)-1, jsonString(text))
			cdp.send("Runtime.evaluate", map[string]any{
				"expression":    script,
				"returnByValue": true,
			})
		} else {
			// Type into focused element character by character
			for _, ch := range text {
				cdp.send("Input.dispatchKeyEvent", map[string]any{
					"type": "keyDown",
					"text": string(ch),
				})
				cdp.send("Input.dispatchKeyEvent", map[string]any{
					"type": "keyUp",
					"text": string(ch),
				})
			}
		}

		if submit {
			cdp.send("Input.dispatchKeyEvent", map[string]any{
				"type":                  "keyDown",
				"key":                   "Enter",
				"code":                  "Enter",
				"windowsVirtualKeyCode": 13,
			})
			cdp.send("Input.dispatchKeyEvent", map[string]any{
				"type":                  "keyUp",
				"key":                   "Enter",
				"code":                  "Enter",
				"windowsVirtualKeyCode": 13,
			})
		}

		return &RPCResult{Result: map[string]any{"success": true}}, nil
	}
}

func makeBrowserScreenshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		cdp, err := getCDP(cfg)
		if err != nil {
			return nil, err
		}

		result, err := cdp.send("Page.captureScreenshot", map[string]any{
			"format":  "png",
			"quality": 80,
		})
		if err != nil {
			return nil, fmt.Errorf("screenshot failed: %w", err)
		}

		var ss struct {
			Data string `json:"data"`
		}
		json.Unmarshal(result, &ss)

		decoded, err := base64.StdEncoding.DecodeString(ss.Data)
		if err != nil {
			return nil, fmt.Errorf("decode screenshot: %w", err)
		}

		_ = decoded // decoded bytes available if needed later

		return &RPCResult{
			Result: map[string]any{"captured": true},
			Binary: &BinaryDataInline{
				Type:     "inline",
				MimeType: "image/png",
				Data:     ss.Data,
			},
		}, nil
	}
}

func makeBrowserScrollHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		direction, _ := params["direction"].(string)
		amount, _ := params["amount"].(float64)
		if amount == 0 {
			amount = 800
		}

		cdp, err := getCDP(cfg)
		if err != nil {
			return nil, err
		}

		pixels := int(amount)
		if direction == "up" {
			pixels = -pixels
		}

		script := fmt.Sprintf("window.scrollBy(0, %d)", pixels)
		cdp.send("Runtime.evaluate", map[string]any{
			"expression": script,
		})

		return &RPCResult{Result: map[string]any{
			"success":   true,
			"direction": direction,
			"pixels":    pixels,
		}}, nil
	}
}

func makeBrowserEvaluateHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		expression, _ := params["expression"].(string)
		if expression == "" {
			return nil, fmt.Errorf("missing required parameter: expression")
		}

		cdp, err := getCDP(cfg)
		if err != nil {
			return nil, err
		}

		result, err := cdp.send("Runtime.evaluate", map[string]any{
			"expression":    expression,
			"returnByValue": true,
		})
		if err != nil {
			return nil, fmt.Errorf("evaluate failed: %w", err)
		}

		return &RPCResult{Result: map[string]any{"result": json.RawMessage(result)}}, nil
	}
}

// ── Browser Snapshot Helper ──────────────────────────────────────────

func getBrowserSnapshot(cdp *cdpClient) (map[string]any, error) {
	// Get page URL and title
	urlResult, _ := cdp.send("Runtime.evaluate", map[string]any{
		"expression":    "JSON.stringify({url: location.href, title: document.title})",
		"returnByValue": true,
	})

	var urlInfo struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	json.Unmarshal(urlResult, &urlInfo)

	var pageInfo map[string]string
	json.Unmarshal([]byte(urlInfo.Result.Value), &pageInfo)

	// Get text content and interactive elements
	script := `
(function() {
    var text = document.body ? document.body.innerText.substring(0, 5000) : '';
    var els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], [tabindex]');
    var items = [];
    for (var i = 0; i < els.length && i < 200; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        var item = {
            id: i + 1,
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || el.value || el.placeholder || el.alt || '').substring(0, 100).trim(),
            type: el.type || '',
            href: el.href || '',
            name: el.name || '',
            role: el.getAttribute('role') || ''
        };
        items.push(item);
    }
    return JSON.stringify({text: text, elements: items, element_count: items.length});
})()
`

	contentResult, err := cdp.send("Runtime.evaluate", map[string]any{
		"expression":    script,
		"returnByValue": true,
	})
	if err != nil {
		return nil, err
	}

	var contentParsed struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	json.Unmarshal(contentResult, &contentParsed)

	var content map[string]any
	json.Unmarshal([]byte(contentParsed.Result.Value), &content)

	if content == nil {
		content = map[string]any{}
	}
	if pageInfo != nil {
		content["url"] = pageInfo["url"]
		content["title"] = pageInfo["title"]
	}

	return content, nil
}

// ── Helpers ──────────────────────────────────────────────────────────

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
