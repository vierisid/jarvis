package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ── CDP over an inherited pipe ────────────────────────────────────────
//
// Instead of opening a localhost debugging *port* (which any local process /
// page could connect to), the sidecar launches the browser with
// `--remote-debugging-pipe` and speaks the Chrome DevTools Protocol over a pair
// of inherited file descriptors: the browser reads commands on fd 3 and writes
// responses/events on fd 4. Messages are NUL-delimited JSON. Because the
// connection is browser-level (not bound to one page), we attach to a page
// target up front and tag page-scoped commands with its flat-mode sessionId.
//
// The OS-specific plumbing that wires fd 3/4 lives in startBrowserPipe
// (browser_pipe_unix.go / browser_pipe_windows.go); everything below is shared.

// browserProc is a launched browser whose CDP pipe we own.
type browserProc struct {
	write io.WriteCloser // commands we write  -> browser fd 3
	read  io.ReadCloser  // responses we read  <- browser fd 4
	kill  func()         // terminate the browser process
}

// cdpClient manages a Chrome DevTools Protocol connection over the pipe.
type cdpClient struct {
	mu        sync.Mutex // serializes writes to the pipe
	proc      *browserProc
	sessionID string // flat-mode session for the attached page target
	headless  bool   // visibility mode the browser was launched in

	msgID   atomic.Int64
	pending map[int64]chan cdpReply
	pendMu  sync.Mutex
	closed  atomic.Bool
}

type cdpReply struct {
	result json.RawMessage
	errMsg json.RawMessage
}

var activeCDP struct {
	mu      sync.Mutex
	client  *cdpClient
	healthy bool
}

// getCDP returns the live browser CDP client, launching the browser lazily on
// first use. A running browser is reused; but when the caller *explicitly*
// requests the other visibility mode (explicit==true and headless differs), the
// current browser is torn down and relaunched so the option takes effect. When
// headless is not specified (explicit==false) the running browser is kept as-is
// to avoid thrashing on every call.
func getCDP(cfg *SidecarConfig, headless, explicit bool) (*cdpClient, error) {
	activeCDP.mu.Lock()
	defer activeCDP.mu.Unlock()

	if c := activeCDP.client; c != nil && !c.closed.Load() {
		if explicit && c.headless != headless {
			activeCDP.client = nil
			c.shutdown()
		} else {
			return c, nil
		}
	}

	client, err := launchCDP(cfg, headless)
	if err != nil {
		return nil, err
	}
	activeCDP.client = client
	return client, nil
}

// browserProfileName derives a per-browser user-data dir name from the
// executable, e.g. chrome.exe -> "jarvis-chrome-profile",
// msedge.exe -> "jarvis-msedge-profile".
func browserProfileName(exe string) string {
	base := strings.ToLower(filepath.Base(exe))
	if ext := filepath.Ext(base); ext != "" {
		base = strings.TrimSuffix(base, ext)
	}
	base = strings.ReplaceAll(base, " ", "-")
	if base == "" {
		base = "chromium"
	}
	return "jarvis-" + base + "-profile"
}

// chromiumLaunchArgs builds the command-line flags for the automation browser.
func chromiumLaunchArgs(profileDir string, headless bool) []string {
	args := []string{
		"--remote-debugging-pipe",
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
	}
	if headless {
		args = append(args, "--headless=new", "--hide-scrollbars")
	}
	args = append(args, "about:blank")
	return args
}

// launchCDP finds a Chromium-based browser, starts it with the CDP pipe, and
// attaches to a page target.
func launchCDP(cfg *SidecarConfig, headless bool) (*cdpClient, error) {
	exe, err := findChromiumExecutable(cfg)
	if err != nil {
		return nil, err
	}

	profileDir := cfg.Browser.ProfileDir
	if profileDir == "" {
		// Per-browser profile dir: a profile created by Chrome can't be reused by
		// Edge/Brave (Chromium refuses a profile from a different brand with a
		// "can't use this profile" alert), so key it on the executable.
		profileDir = filepath.Join(os.TempDir(), browserProfileName(exe))
	}

	proc, err := startBrowserPipe(exe, chromiumLaunchArgs(profileDir, headless))
	if err != nil {
		return nil, fmt.Errorf("launch browser %q: %w", exe, err)
	}

	mode := "headed"
	if headless {
		mode = "headless"
	}
	log.Printf("[browser] launched %s (%s) with CDP pipe", filepath.Base(exe), mode)

	c := &cdpClient{
		proc:     proc,
		headless: headless,
		pending:  make(map[int64]chan cdpReply),
	}
	go c.readLoop(proc.read)

	if err := c.attachToPage(); err != nil {
		c.shutdown()
		return nil, fmt.Errorf("attach to page: %w", err)
	}
	return c, nil
}

// attachToPage finds (or creates) a page target and stores its flat session id.
func (c *cdpClient) attachToPage() error {
	targetID := ""
	// The about:blank window the browser opens at launch may not register as a
	// target for a beat; poll briefly before falling back to creating one.
	deadline := time.Now().Add(3 * time.Second)
	for {
		raw, err := c.sendOn("", "Target.getTargets", nil)
		if err != nil {
			return err
		}
		var res struct {
			TargetInfos []struct {
				TargetID string `json:"targetId"`
				Type     string `json:"type"`
			} `json:"targetInfos"`
		}
		json.Unmarshal(raw, &res)
		for _, t := range res.TargetInfos {
			if t.Type == "page" {
				targetID = t.TargetID
				break
			}
		}
		if targetID != "" || time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	if targetID == "" {
		raw, err := c.sendOn("", "Target.createTarget", map[string]any{"url": "about:blank"})
		if err != nil {
			return err
		}
		var res struct {
			TargetID string `json:"targetId"`
		}
		json.Unmarshal(raw, &res)
		targetID = res.TargetID
	}
	if targetID == "" {
		return fmt.Errorf("no page target available")
	}

	raw, err := c.sendOn("", "Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	})
	if err != nil {
		return err
	}
	var att struct {
		SessionID string `json:"sessionId"`
	}
	json.Unmarshal(raw, &att)
	if att.SessionID == "" {
		return fmt.Errorf("attach returned no sessionId")
	}
	c.sessionID = att.SessionID
	return nil
}

// readLoop consumes NUL-delimited CDP messages and routes replies by id.
func (c *cdpClient) readLoop(r io.Reader) {
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		data, err := br.ReadBytes(0)
		if len(data) > 1 {
			if n := len(data); data[n-1] == 0 {
				data = data[:n-1]
			}
			var msg struct {
				ID     int64           `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(data, &msg) == nil && msg.ID != 0 {
				c.pendMu.Lock()
				ch, ok := c.pending[msg.ID]
				if ok {
					delete(c.pending, msg.ID)
				}
				c.pendMu.Unlock()
				if ok {
					ch <- cdpReply{result: msg.Result, errMsg: msg.Error}
				}
			}
			// id == 0 -> protocol event; ignored.
		}
		if err != nil {
			c.fail()
			return
		}
	}
}

// send issues a page-scoped command (tagged with the attached sessionId).
func (c *cdpClient) send(method string, params map[string]any) (json.RawMessage, error) {
	return c.sendOn(c.sessionID, method, params)
}

// sendOn issues a command on a specific session ("" = browser-level).
func (c *cdpClient) sendOn(sessionID, method string, params map[string]any) (json.RawMessage, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("browser connection closed")
	}

	id := c.msgID.Add(1)
	ch := make(chan cdpReply, 1)
	c.pendMu.Lock()
	c.pending[id] = ch
	c.pendMu.Unlock()

	msg := map[string]any{"id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if sessionID != "" {
		msg["sessionId"] = sessionID
	}
	data, _ := json.Marshal(msg)
	data = append(data, 0) // NUL terminator

	c.mu.Lock()
	_, err := c.proc.write.Write(data)
	c.mu.Unlock()
	if err != nil {
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, err
	}

	select {
	case reply := <-ch:
		if reply.errMsg != nil {
			return nil, fmt.Errorf("CDP %s: %s", method, string(reply.errMsg))
		}
		return reply.result, nil
	case <-time.After(30 * time.Second):
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, fmt.Errorf("CDP timeout for %s", method)
	}
}

// shutdown tears down the connection and the browser process. Idempotent. Does
// NOT touch activeCDP, so it is safe to call while holding activeCDP.mu.
func (c *cdpClient) shutdown() {
	if c.closed.Swap(true) {
		return
	}
	if c.proc != nil {
		c.proc.write.Close()
		c.proc.read.Close()
		if c.proc.kill != nil {
			c.proc.kill()
		}
	}
}

// fail is invoked when the pipe dies: it clears the cached client (so the next
// browser tool call relaunches) and shuts the connection down.
func (c *cdpClient) fail() {
	activeCDP.mu.Lock()
	if activeCDP.client == c {
		activeCDP.client = nil
	}
	activeCDP.mu.Unlock()
	c.shutdown()
}

// closeActiveCDP closes the current browser (if any) and clears the cache so the
// next browser tool call starts fresh — e.g. to switch visibility modes.
func closeActiveCDP() {
	activeCDP.mu.Lock()
	c := activeCDP.client
	activeCDP.client = nil
	activeCDP.mu.Unlock()
	if c != nil {
		c.shutdown()
	}
}

// headlessParam reads the optional headless flag from RPC params. explicit
// reports whether the caller actually supplied it (vs. defaulting). Default
// false -> the browser opens headed so the user can see and interact with it.
func headlessParam(params map[string]any) (value bool, explicit bool) {
	v, ok := params["headless"]
	if !ok {
		return false, false
	}
	b, _ := v.(bool)
	return b, true
}

// getCDPForParams launches/reuses the browser honoring the call's headless flag.
func getCDPForParams(cfg *SidecarConfig, params map[string]any) (*cdpClient, error) {
	headless, explicit := headlessParam(params)
	return getCDP(cfg, headless, explicit)
}

// ── Browser Handlers ─────────────────────────────────────────────────

func makeBrowserNavigateHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		url, _ := params["url"].(string)
		if url == "" {
			return nil, fmt.Errorf("missing required parameter: url")
		}

		cdp, err := getCDPForParams(cfg, params)
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
		cdp, err := getCDPForParams(cfg, params)
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

		cdp, err := getCDPForParams(cfg, params)
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
`, int(elemID), int(elemID), int(elemID))

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
		elemID, hasElem := params["element_id"].(float64)
		submit, _ := params["submit"].(bool)

		cdp, err := getCDPForParams(cfg, params)
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
`, int(elemID), jsonString(text))
			if _, err := cdp.send("Runtime.evaluate", map[string]any{
				"expression":    script,
				"returnByValue": true,
			}); err != nil {
				return nil, fmt.Errorf("type into element failed: %w", err)
			}
		} else {
			// Type into focused element character by character
			for _, ch := range text {
				if _, err := cdp.send("Input.dispatchKeyEvent", map[string]any{
					"type": "keyDown",
					"text": string(ch),
				}); err != nil {
					return nil, fmt.Errorf("type failed mid-string: %w", err)
				}
				if _, err := cdp.send("Input.dispatchKeyEvent", map[string]any{
					"type": "keyUp",
					"text": string(ch),
				}); err != nil {
					return nil, fmt.Errorf("type failed mid-string: %w", err)
				}
			}
		}

		if submit {
			if _, err := cdp.send("Input.dispatchKeyEvent", map[string]any{
				"type":                  "keyDown",
				"key":                   "Enter",
				"code":                  "Enter",
				"windowsVirtualKeyCode": 13,
			}); err != nil {
				return nil, fmt.Errorf("submit (Enter down) failed: %w", err)
			}
			if _, err := cdp.send("Input.dispatchKeyEvent", map[string]any{
				"type":                  "keyUp",
				"key":                   "Enter",
				"code":                  "Enter",
				"windowsVirtualKeyCode": 13,
			}); err != nil {
				return nil, fmt.Errorf("submit (Enter up) failed: %w", err)
			}
		}

		return &RPCResult{Result: map[string]any{"success": true}}, nil
	}
}

func makeBrowserScreenshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		cdp, err := getCDPForParams(cfg, params)
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

		return &RPCResult{
			Result:     map[string]any{"captured": true},
			BinaryRaw:  decoded,
			BinaryMime: "image/png",
		}, nil
	}
}

func makeBrowserScrollHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		direction, _ := params["direction"].(string)
		amount, _ := params["amount"].(float64)
		if amount == 0 {
			amount = 3
		}

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		pixels := int(amount * 100)
		if direction == "up" {
			pixels = -pixels
		}

		script := fmt.Sprintf("window.scrollBy(0, %d)", pixels)
		if _, err := cdp.send("Runtime.evaluate", map[string]any{
			"expression": script,
		}); err != nil {
			return nil, fmt.Errorf("scroll failed: %w", err)
		}

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

		cdp, err := getCDPForParams(cfg, params)
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

func makeBrowserCloseHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		closeActiveCDP()
		return &RPCResult{Result: map[string]any{"closed": true}}, nil
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
            id: i,
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
