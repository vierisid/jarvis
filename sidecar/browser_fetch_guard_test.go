package main

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

// The Fetch guard is driven entirely over the CDP pipe, so it can be tested
// against a fake browser on the other end of two in-memory pipes: no Chromium,
// no debug port, and the real readLoop / sendOn code paths. What still needs a
// real browser is whether CHROME pauses the requests we asked it to (redirect
// hops in particular) -- see the test names below.

type fakeBrowser struct {
	t       *testing.T
	client  *cdpClient
	fromCmd *bufio.Reader  // commands the client wrote
	toEvent io.WriteCloser // replies and events we push at the client
}

// cdpCommand is one NUL-terminated message the client sent us.
type cdpCommand struct {
	ID        int64          `json:"id"`
	Method    string         `json:"method"`
	SessionID string         `json:"sessionId"`
	Params    map[string]any `json:"params"`
}

func newFakeBrowser(t *testing.T) *fakeBrowser {
	t.Helper()
	cmdR, cmdW := io.Pipe() // client -> us
	evtR, evtW := io.Pipe() // us -> client
	c := &cdpClient{
		proc:    &browserProc{write: cmdW, read: evtR},
		pending: make(map[int64]chan cdpReply),
	}
	go c.readLoop(evtR)
	fb := &fakeBrowser{t: t, client: c, fromCmd: bufio.NewReader(cmdR), toEvent: evtW}
	t.Cleanup(func() {
		c.closed.Store(true)
		evtW.Close()
		cmdW.Close()
	})
	return fb
}

// nextCommand reads the next command the client sent, failing the test if none
// arrives. A missing command is how a deadlocked or dropped paused request
// shows up.
func (fb *fakeBrowser) nextCommand() cdpCommand {
	fb.t.Helper()
	type result struct {
		cmd cdpCommand
		err error
	}
	done := make(chan result, 1)
	go func() {
		data, err := fb.fromCmd.ReadBytes(0)
		if err != nil && len(data) == 0 {
			done <- result{err: err}
			return
		}
		var cmd cdpCommand
		err = json.Unmarshal([]byte(strings.TrimSuffix(string(data), "\x00")), &cmd)
		done <- result{cmd: cmd, err: err}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			fb.t.Fatalf("reading the client's command: %v", r.err)
		}
		return r.cmd
	case <-time.After(5 * time.Second):
		fb.t.Fatal("the client sent no command: a paused request was dropped or the pipe deadlocked")
		return cdpCommand{}
	}
}

func (fb *fakeBrowser) reply(id int64) {
	fb.t.Helper()
	fb.write(map[string]any{"id": id, "result": map[string]any{}})
}

// pauseRequest pushes a Fetch.requestPaused event, as Chrome would.
func (fb *fakeBrowser) pauseRequest(requestID, url, resourceType string) {
	fb.t.Helper()
	fb.write(map[string]any{
		"method": "Fetch.requestPaused",
		"params": map[string]any{
			"requestId":    requestID,
			"resourceType": resourceType,
			"request":      map[string]any{"url": url, "method": "GET"},
		},
	})
}

func (fb *fakeBrowser) write(msg map[string]any) {
	fb.t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		fb.t.Fatalf("marshal fake browser message: %v", err)
	}
	if _, err := fb.toEvent.Write(append(data, 0)); err != nil {
		fb.t.Fatalf("write fake browser message: %v", err)
	}
}

func TestFetchGuardEnableRegistersThePatterns(t *testing.T) {
	fb := newFakeBrowser(t)

	errCh := make(chan error, 1)
	go func() { errCh <- fb.client.installFetchGuard() }()

	cmd := fb.nextCommand()
	if cmd.Method != "Fetch.enable" {
		t.Fatalf("first command is %q, want Fetch.enable", cmd.Method)
	}
	if cmd.SessionID != "" {
		t.Fatalf("Fetch.enable was sent on session %q; the guard must be browser-level", cmd.SessionID)
	}
	patterns, ok := cmd.Params["patterns"].([]any)
	if !ok {
		t.Fatalf("Fetch.enable params have no patterns list: %+v", cmd.Params)
	}
	var got []string
	for _, p := range patterns {
		m, ok := p.(map[string]any)
		if !ok {
			t.Fatalf("pattern %+v is not an object", p)
		}
		got = append(got, m["urlPattern"].(string))
	}
	wantAll := []string{"file:*", "*://*:9222/*", "*://*:9223/*"}
	if len(got) != len(wantAll) {
		t.Fatalf("registered patterns %v, want %v", got, wantAll)
	}
	for i, want := range wantAll {
		if got[i] != want {
			t.Fatalf("registered patterns %v, want %v", got, wantAll)
		}
	}

	fb.reply(cmd.ID)
	if err := <-errCh; err != nil {
		t.Fatalf("installFetchGuard: %v", err)
	}
}

// A failing Fetch.enable must be reported, so launchCDP can refuse to drive the
// browser rather than drive it unguarded.
func TestFetchGuardEnableReportsFailure(t *testing.T) {
	fb := newFakeBrowser(t)

	errCh := make(chan error, 1)
	go func() { errCh <- fb.client.installFetchGuard() }()

	cmd := fb.nextCommand()
	fb.write(map[string]any{"id": cmd.ID, "error": map[string]any{"code": -32601, "message": "Fetch not supported"}})
	err := <-errCh
	if err == nil {
		t.Fatal("installFetchGuard reported success on a CDP error")
	}
	if !strings.Contains(err.Error(), "Fetch not supported") {
		t.Fatalf("installFetchGuard error %q does not carry Chrome's message", err)
	}
}

func TestFetchGuardFailsLocalAndDevtoolsRequests(t *testing.T) {
	cases := []struct {
		name   string
		url    string
		reason string
	}{
		{"file document", "file:///etc/passwd", "does not load local files"},
		{"file uppercase", "FILE:///etc/passwd", "does not load local files"},
		{"file subresource", "file:///home/user/.ssh/id_rsa", "does not load local files"},
		{"devtools json", "http://127.0.0.1:9222/json/list", "DevTools port"},
		{"devtools new tab", "http://127.0.0.1:9222/json/new?file:///etc/passwd", "DevTools port"},
		{"devtools other browser", "http://127.0.0.1:9223/json/version", "DevTools port"},
		// A host that only DNS knows is loopback: unreachable for the
		// navigate-time check, caught here because Chrome matched the port.
		{"devtools via a resolving name", "http://127.0.0.1.nip.io:9222/json/list", "DevTools port"},
		// This one pins the DECISION only: Chrome never pauses a WebSocket
		// handshake, so the guard is not what stops that route (see the header
		// comment in browser_fetch_guard.go). Kept so the decision stays
		// consistent if Chrome's interception ever grows to cover it.
		{"devtools websocket (decision only)", "ws://127.0.0.1:9222/devtools/browser/abc", "DevTools port"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fb := newFakeBrowser(t)
			fb.pauseRequest("req-1", tc.url, "Document")

			cmd := fb.nextCommand()
			if cmd.Method != "Fetch.failRequest" {
				t.Fatalf("answered %q with %q, want Fetch.failRequest", tc.url, cmd.Method)
			}
			if cmd.Params["requestId"] != "req-1" {
				t.Fatalf("answered request %v, want req-1", cmd.Params["requestId"])
			}
			if cmd.Params["errorReason"] != "BlockedByClient" {
				t.Fatalf("errorReason is %v, want BlockedByClient", cmd.Params["errorReason"])
			}
			fb.reply(cmd.ID)

			blocked := fb.client.blockedSince(time.Now().Add(-time.Minute))
			if blocked == nil {
				t.Fatalf("the guard did not record blocking %q", tc.url)
			}
			if blocked.url != tc.url || !strings.Contains(blocked.reason, tc.reason) {
				t.Fatalf("recorded %+v, want url %q and a reason mentioning %q", *blocked, tc.url, tc.reason)
			}
		})
	}
}

// Every request that is not blocked MUST be continued. A dropped answer holds
// the page load open until Chrome gives up, which looks like a hung browser.
func TestFetchGuardContinuesEverythingElse(t *testing.T) {
	for _, url := range []string{
		"https://example.com/",
		// Matched the port pattern by accident: ":9222" in the path, not the
		// authority. Must still be continued.
		"https://example.com/a:9222/b",
		"https://example.com/?next=http://127.0.0.1:9222/json/list",
		"https://example.com:443/x",
		"data:text/html,hi",
	} {
		t.Run(url, func(t *testing.T) {
			fb := newFakeBrowser(t)
			fb.pauseRequest("req-continue", url, "Document")

			cmd := fb.nextCommand()
			if cmd.Method != "Fetch.continueRequest" {
				t.Fatalf("answered %q with %q, want Fetch.continueRequest", url, cmd.Method)
			}
			if cmd.Params["requestId"] != "req-continue" {
				t.Fatalf("continued request %v, want req-continue", cmd.Params["requestId"])
			}
			fb.reply(cmd.ID)

			if blocked := fb.client.blockedSince(time.Now().Add(-time.Minute)); blocked != nil {
				t.Fatalf("%q was recorded as blocked: %+v", url, *blocked)
			}
		})
	}
}

// A request paused while its answer is still in flight must not stop the read
// loop: that is the deadlock this design is shaped to avoid. Ten unanswered
// requests are answered, and an ordinary command completes while they are
// outstanding.
func TestFetchGuardDoesNotBlockTheReadLoop(t *testing.T) {
	fb := newFakeBrowser(t)

	const n = 10
	for i := 0; i < n; i++ {
		fb.pauseRequest("req", "file:///etc/shadow", "Document")
	}

	var pending []int64
	for i := 0; i < n; i++ {
		cmd := fb.nextCommand()
		if cmd.Method != "Fetch.failRequest" {
			t.Fatalf("command %d is %q, want Fetch.failRequest", i, cmd.Method)
		}
		pending = append(pending, cmd.ID)
	}

	// The read loop is still serving round-trips although none of the above has
	// been answered yet.
	done := make(chan error, 1)
	go func() {
		_, err := fb.client.sendOn("", "Browser.getVersion", nil)
		done <- err
	}()
	version := fb.nextCommand()
	if version.Method != "Browser.getVersion" {
		t.Fatalf("expected Browser.getVersion to get through, got %q", version.Method)
	}
	fb.reply(version.ID)
	if err := <-done; err != nil {
		t.Fatalf("Browser.getVersion while requests were paused: %v", err)
	}

	for _, id := range pending {
		fb.reply(id)
	}
}

// A redirect hop reaches the guard as an ordinary paused request whose url is
// the redirect TARGET, so the same decision applies. That Chrome pauses redirect
// hops at all is its documented behaviour and is what the daemon relies on; it
// takes a real browser to prove end to end.
func TestFetchGuardFailsARedirectIntoAFileURL(t *testing.T) {
	fb := newFakeBrowser(t)
	fb.write(map[string]any{
		"method": "Fetch.requestPaused",
		"params": map[string]any{
			"requestId":           "req-redirect",
			"resourceType":        "Document",
			"redirectedRequestId": "req-original",
			"request":             map[string]any{"url": "file:///etc/passwd", "method": "GET"},
		},
	})

	cmd := fb.nextCommand()
	if cmd.Method != "Fetch.failRequest" {
		t.Fatalf("a redirect into file: was answered with %q, want Fetch.failRequest", cmd.Method)
	}
	fb.reply(cmd.ID)

	// And the navigate handler turns Chrome's generic error into the reason.
	msg := fb.client.describeBlockedNavigation("http://example.com/r", "net::ERR_BLOCKED_BY_CLIENT", time.Now().Add(-time.Minute))
	if !strings.Contains(msg, "file:///etc/passwd") || !strings.Contains(msg, "does not load local files") {
		t.Fatalf("describeBlockedNavigation = %q, want it to name the blocked URL and the reason", msg)
	}
}

func TestDescribeBlockedNavigationIgnoresUnrelatedFailures(t *testing.T) {
	fb := newFakeBrowser(t)
	now := time.Now()

	// No block recorded at all: report Chrome's own error text.
	if msg := fb.client.describeBlockedNavigation("http://example.com/", "net::ERR_BLOCKED_BY_CLIENT", now); msg != "" {
		t.Fatalf("describeBlockedNavigation with nothing blocked = %q, want \"\"", msg)
	}

	// A block from BEFORE this navigation belongs to the previous one.
	fb.client.recordBlocked(blockedRequest{
		url: "file:///etc/passwd", reason: "the browser does not load local files",
		resourceType: "Document", at: now.Add(-time.Second),
	})
	if msg := fb.client.describeBlockedNavigation("http://example.com/", "net::ERR_BLOCKED_BY_CLIENT", now); msg != "" {
		t.Fatalf("describeBlockedNavigation reused an older block: %q", msg)
	}

	// A blocked SUBRESOURCE did not fail the navigation.
	fb.client.recordBlocked(blockedRequest{
		url: "file:///etc/passwd", reason: "the browser does not load local files",
		resourceType: "Image", at: now.Add(time.Second),
	})
	if msg := fb.client.describeBlockedNavigation("http://example.com/", "net::ERR_BLOCKED_BY_CLIENT", now); msg != "" {
		t.Fatalf("describeBlockedNavigation blamed a subresource: %q", msg)
	}

	// A different error is not the guard's doing.
	fb.client.recordBlocked(blockedRequest{
		url: "file:///etc/passwd", reason: "the browser does not load local files",
		resourceType: "Document", at: now.Add(time.Second),
	})
	if msg := fb.client.describeBlockedNavigation("http://example.com/", "net::ERR_NAME_NOT_RESOLVED", now); msg != "" {
		t.Fatalf("describeBlockedNavigation claimed a DNS failure: %q", msg)
	}
}

// An answer that is never acknowledged must not wedge anything. The command is
// already on the wire when the timeout fires, so Chrome acts on it either way --
// the timeout only abandons the log line.
func TestFetchGuardHandlerGivesUpOnAnUnansweredReply(t *testing.T) {
	fb := newFakeBrowser(t)

	previous := fetchGuardReplyTimeoutForTest
	fetchGuardReplyTimeoutForTest = 150 * time.Millisecond
	t.Cleanup(func() { fetchGuardReplyTimeoutForTest = previous })

	fb.pauseRequest("req-unanswered", "file:///etc/passwd", "Document")
	cmd := fb.nextCommand()
	if cmd.Method != "Fetch.failRequest" {
		t.Fatalf("answered with %q, want Fetch.failRequest", cmd.Method)
	}
	// Deliberately no reply. The pipe must keep working regardless.
	done := make(chan error, 1)
	go func() {
		_, err := fb.client.sendOn("", "Browser.getVersion", nil)
		done <- err
	}()
	version := fb.nextCommand()
	fb.reply(version.ID)
	if err := <-done; err != nil {
		t.Fatalf("Browser.getVersion after an unanswered fail: %v", err)
	}

	// And the abandoned round-trip left nothing behind.
	time.Sleep(300 * time.Millisecond)
	fb.client.pendMu.Lock()
	pending := len(fb.client.pending)
	fb.client.pendMu.Unlock()
	if pending != 0 {
		t.Fatalf("%d pending replies left after the timeout, want 0", pending)
	}
}

// A paused request that arrives while the pipe is going down must not panic or
// block; it is logged and dropped, and Chrome releases it when the pipe closes.
func TestFetchGuardSurvivesADeadPipe(t *testing.T) {
	fb := newFakeBrowser(t)
	fb.client.closed.Store(true)

	// Answering now fails at the closed check rather than the write.
	fb.client.handlePausedRequest("", []byte(`{"requestId":"r","resourceType":"Document","request":{"url":"file:///etc/passwd"}}`))

	if blocked := fb.client.blockedSince(time.Now().Add(-time.Minute)); blocked == nil {
		t.Fatal("the guard did not record the block it could not send")
	}
}

// A malformed event must not panic or wedge the loop; the next one is answered.
func TestFetchGuardSurvivesAMalformedEvent(t *testing.T) {
	fb := newFakeBrowser(t)
	fb.write(map[string]any{"method": "Fetch.requestPaused", "params": map[string]any{"resourceType": "Document"}})
	fb.pauseRequest("req-after", "file:///etc/passwd", "Document")

	cmd := fb.nextCommand()
	if cmd.Method != "Fetch.failRequest" || cmd.Params["requestId"] != "req-after" {
		t.Fatalf("after a malformed event the guard answered %q for %v", cmd.Method, cmd.Params["requestId"])
	}
	fb.reply(cmd.ID)
}
