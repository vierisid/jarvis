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

	// Element centers from the last snapshot, keyed by 1-based element id.
	// Click/hover resolve ids against THIS, not a fresh selector query, so a
	// click lands where the snapshot said the element was.
	elemMu     sync.Mutex
	elemCoords map[int][2]float64

	// One-shot waiters for CDP events (e.g. Page.loadEventFired).
	eventMu      sync.Mutex
	eventWaiters map[string][]chan struct{}
}

// waitForEvent returns a channel that closes when the named CDP event next
// fires. Register BEFORE the action that triggers the event.
func (c *cdpClient) waitForEvent(method string) <-chan struct{} {
	ch := make(chan struct{})
	c.eventMu.Lock()
	if c.eventWaiters == nil {
		c.eventWaiters = make(map[string][]chan struct{})
	}
	c.eventWaiters[method] = append(c.eventWaiters[method], ch)
	c.eventMu.Unlock()
	return ch
}

func (c *cdpClient) fireEvent(method string) {
	c.eventMu.Lock()
	waiters := c.eventWaiters[method]
	delete(c.eventWaiters, method)
	c.eventMu.Unlock()
	for _, ch := range waiters {
		close(ch)
	}
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

	// Enable Page events so navigate can wait for Page.loadEventFired.
	// Non-fatal: navigation falls back to a fixed settle delay without it.
	if _, err := c.send("Page.enable", nil); err != nil {
		log.Printf("[browser] Page.enable failed (navigation uses fixed delay): %v", err)
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
				Method string          `json:"method"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(data, &msg) == nil {
				if msg.ID != 0 {
					c.pendMu.Lock()
					ch, ok := c.pending[msg.ID]
					if ok {
						delete(c.pending, msg.ID)
					}
					c.pendMu.Unlock()
					if ok {
						ch <- cdpReply{result: msg.Result, errMsg: msg.Error}
					}
				} else if msg.Method != "" {
					// Protocol event — wake anyone waiting on it.
					c.fireEvent(msg.Method)
				}
			}
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

		// Register the waiter BEFORE navigating so the event can't be missed
		loaded := cdp.waitForEvent("Page.loadEventFired")

		if _, err := cdp.send("Page.navigate", map[string]any{"url": url}); err != nil {
			return nil, fmt.Errorf("navigate failed: %w", err)
		}

		select {
		case <-loaded:
		case <-time.After(30 * time.Second):
			// Page may still be usable (SPAs, slow loads) — same fallback as
			// the daemon's local navigate.
			log.Printf("[browser] page load timeout for %s, continuing anyway", url)
		}

		// Let JS settle (matches the daemon's post-load delay)
		time.Sleep(800 * time.Millisecond)

		formatted, err := takeFormattedSnapshot(cdp)
		if err != nil {
			return nil, err
		}
		return &RPCResult{Result: formatted}, nil
	}
}

func makeBrowserSnapshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		formatted, err := takeFormattedSnapshot(cdp)
		if err != nil {
			return nil, err
		}
		return &RPCResult{Result: formatted}, nil
	}
}

func makeBrowserClickHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		elemID, ok := params["element_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("missing required parameter: element_id")
		}
		button, _ := params["button"].(string)
		if button != "right" {
			button = "left"
		}
		double, _ := params["double"].(bool)

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		id := int(elemID)
		coords, found := cdp.elementCoordsFor(id)
		if !found {
			return &RPCResult{Result: fmt.Sprintf("Error: Element [%d] not found. Run browser_snapshot first.", id)}, nil
		}

		if err := dispatchClick(cdp, coords[0], coords[1], button, double); err != nil {
			return nil, fmt.Errorf("click failed: %w", err)
		}

		// Wait for navigation/changes (matches the daemon's local click)
		time.Sleep(1 * time.Second)

		kind := "Clicked"
		if double {
			kind = "Double-clicked"
		} else if button == "right" {
			kind = "Right-clicked"
		}
		return &RPCResult{Result: fmt.Sprintf("%s element [%d]", kind, id)}, nil
	}
}

func makeBrowserTypeHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		text, _ := params["text"].(string)
		if text == "" {
			return nil, fmt.Errorf("missing required parameter: text")
		}
		elemID, hasElem := params["element_id"].(float64)
		if !hasElem {
			return nil, fmt.Errorf("missing required parameter: element_id")
		}
		submit, _ := params["submit"].(bool)
		appendMode, _ := params["append"].(bool)

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		id := int(elemID)
		coords, found := cdp.elementCoordsFor(id)
		if !found {
			return &RPCResult{Result: fmt.Sprintf("Error: Element [%d] not found. Run browser_snapshot first.", id)}, nil
		}

		// Focus via the DOM refs the snapshot stored, and clear or position the
		// caret — same script as the daemon's local type (session.ts).
		appendJS := "false"
		if appendMode {
			appendJS = "true"
		}
		script := fmt.Sprintf(`(() => {
        const el = window.__jarvis_elements && window.__jarvis_elements[%d];
        if (!el) return 'not_found';
        el.focus();
        const append = %s;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          if (append) {
            try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
          } else {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
          const doc = el.ownerDocument || document;
          const win = doc.defaultView || window;
          const range = doc.createRange();
          range.selectNodeContents(el);
          const sel = win.getSelection();
          sel.removeAllRanges();
          if (append) {
            range.collapse(false);
            sel.addRange(range);
          } else {
            sel.addRange(range);
            doc.execCommand('delete', false, null);
          }
        }
        return 'ok';
      })()`, id-1, appendJS)

		focusResult, err := cdp.send("Runtime.evaluate", map[string]any{
			"expression":    script,
			"returnByValue": true,
		})
		if err != nil {
			return nil, fmt.Errorf("type into element failed: %w", err)
		}
		var focusParsed struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
		}
		json.Unmarshal(focusResult, &focusParsed)

		if focusParsed.Result.Value == "not_found" {
			// Element refs lost (navigation happened) — coordinate-click
			// fallback + Ctrl+A clearing, same as the daemon.
			if err := dispatchClick(cdp, coords[0], coords[1], "left", false); err != nil {
				return nil, fmt.Errorf("type focus fallback failed: %w", err)
			}
			time.Sleep(200 * time.Millisecond)
			if !appendMode {
				for _, evType := range []string{"keyDown", "keyUp"} {
					if _, err := cdp.send("Input.dispatchKeyEvent", map[string]any{
						"type": evType, "key": "a", "code": "KeyA",
						"windowsVirtualKeyCode": 65, "nativeVirtualKeyCode": 65, "modifiers": 2,
					}); err != nil {
						return nil, fmt.Errorf("type clear fallback failed: %w", err)
					}
				}
			}
		} else {
			time.Sleep(200 * time.Millisecond)
		}

		// Insert text (paste-like — same as the daemon's Input.insertText)
		if _, err := cdp.send("Input.insertText", map[string]any{"text": text}); err != nil {
			return nil, fmt.Errorf("type failed: %w", err)
		}

		verb := "Typed"
		if appendMode {
			verb = "Appended"
		}
		result := fmt.Sprintf("%s %q into element [%d]", verb, text, id)

		if submit {
			time.Sleep(100 * time.Millisecond)
			if err := pressEnter(cdp); err != nil {
				return nil, fmt.Errorf("submit failed: %w", err)
			}
			time.Sleep(2 * time.Second)
			result += " and pressed Enter"
		}

		return &RPCResult{Result: result}, nil
	}
}

// pressEnter matches the daemon's Enter sequence (rawKeyDown + char + keyUp).
func pressEnter(cdp *cdpClient) error {
	for _, evType := range []string{"rawKeyDown", "char", "keyUp"} {
		if _, err := cdp.send("Input.dispatchKeyEvent", map[string]any{
			"type": evType, "key": "Enter", "code": "Enter",
			"windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13,
		}); err != nil {
			return err
		}
	}
	return nil
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
		direction := "down"
		if d, _ := params["direction"].(string); d == "up" {
			direction = "up"
		}
		amount, hasAmount := params["amount"].(float64)

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		// amount is PIXELS, defaulting to one viewport height — the same
		// contract as the daemon's local scroll (the old sidecar treated
		// amount as "screens", silently scrolling 100x less than asked).
		scrollAmount := amount
		if !hasAmount || scrollAmount == 0 {
			scrollAmount = 600
			if raw, err := cdp.send("Runtime.evaluate", map[string]any{
				"expression":    "window.innerHeight",
				"returnByValue": true,
			}); err == nil {
				var parsed struct {
					Result struct {
						Value float64 `json:"value"`
					} `json:"result"`
				}
				if json.Unmarshal(raw, &parsed) == nil && parsed.Result.Value > 0 {
					scrollAmount = parsed.Result.Value
				}
			}
		}

		pixels := int(scrollAmount)
		if direction == "up" {
			pixels = -pixels
		}

		if _, err := cdp.send("Runtime.evaluate", map[string]any{
			"expression": fmt.Sprintf("window.scrollBy(0, %d)", pixels),
		}); err != nil {
			return nil, fmt.Errorf("scroll failed: %w", err)
		}

		// Wait for lazy-loaded content (matches the daemon)
		time.Sleep(500 * time.Millisecond)

		return &RPCResult{Result: fmt.Sprintf("Scrolled %s by %dpx", direction, int(scrollAmount))}, nil
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
			"awaitPromise":  true,
		})
		if err != nil {
			return nil, fmt.Errorf("evaluate failed: %w", err)
		}

		// Unwrap to the same shape the daemon's evaluate tool returns:
		// "(no return value)", the raw string, or pretty-printed JSON.
		var parsed struct {
			Result struct {
				Value json.RawMessage `json:"value"`
			} `json:"result"`
			ExceptionDetails json.RawMessage `json:"exceptionDetails"`
		}
		if err := json.Unmarshal(result, &parsed); err != nil {
			return nil, fmt.Errorf("evaluate: parse reply: %w", err)
		}
		if parsed.ExceptionDetails != nil {
			return nil, fmt.Errorf("JS error: %s", string(parsed.ExceptionDetails))
		}
		if parsed.Result.Value == nil || string(parsed.Result.Value) == "null" {
			return &RPCResult{Result: "(no return value)"}, nil
		}
		var asString string
		if json.Unmarshal(parsed.Result.Value, &asString) == nil {
			return &RPCResult{Result: asString}, nil
		}
		var pretty any
		if json.Unmarshal(parsed.Result.Value, &pretty) == nil {
			if out, err := json.MarshalIndent(pretty, "", "  "); err == nil {
				return &RPCResult{Result: string(out)}, nil
			}
		}
		return &RPCResult{Result: string(parsed.Result.Value)}, nil
	}
}

func makeBrowserCloseHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		closeActiveCDP()
		return &RPCResult{Result: map[string]any{"closed": true}}, nil
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
