package main

import (
	"strings"
	"testing"
	"time"
)

// The read guards are tested over the fake CDP pipe (browser_fetch_guard_test.go),
// which lets the real handlers run against scripted Page.getFrameTree replies:
// what a real browser adds is whether Chrome's frame tree says what we think,
// and that is covered by browser_file_guard_integration_test.go.

// frameTreeReply answers a Page.getFrameTree with one main frame and optional
// child frames, shaped exactly like Chrome's reply.
func (fb *fakeBrowser) frameTreeReply(id int64, mainURL string, childURLs ...string) {
	fb.t.Helper()
	fb.frameTreeReplyFull(id, mainURL, "loader-1", originOf(mainURL), childURLs...)
}

// frameTreeReplyFull is frameTreeReply with the loaderId and securityOrigin
// spelled out, for the tests that care which document it is.
func (fb *fakeBrowser) frameTreeReplyFull(id int64, mainURL, loaderID, origin string, childURLs ...string) {
	fb.t.Helper()
	children := []any{}
	for i, u := range childURLs {
		children = append(children, map[string]any{
			"frame": map[string]any{"id": "child", "url": u, "loaderId": i},
		})
	}
	fb.write(map[string]any{
		"id": id,
		"result": map[string]any{
			"frameTree": map[string]any{
				"frame": map[string]any{
					"id": "main", "url": mainURL, "loaderId": loaderID, "securityOrigin": origin,
				},
				"childFrames": children,
			},
		},
	})
}

// originOf is what Chrome reports as securityOrigin for the URLs these tests
// use: the scheme and host for a real page, "://" for about:blank and data:.
func originOf(u string) string {
	switch {
	case strings.HasPrefix(u, "https://"), strings.HasPrefix(u, "http://"):
		rest := u[strings.Index(u, "://")+3:]
		if i := strings.IndexAny(rest, "/?#"); i >= 0 {
			rest = rest[:i]
		}
		return u[:strings.Index(u, "://")+3] + rest
	default:
		return "://"
	}
}

// answerFrameTree answers the next command, which must be a Page.getFrameTree.
// The read paths check, read, then check again, so a test that scripts a read
// answers this twice.
func (fb *fakeBrowser) answerFrameTree(mainURL string) cdpCommand {
	fb.t.Helper()
	cmd := fb.nextCommand()
	if cmd.Method != "Page.getFrameTree" {
		fb.t.Fatalf("expected Page.getFrameTree, got %q", cmd.Method)
	}
	fb.frameTreeReply(cmd.ID, mainURL)
	return cmd
}

// noCommandWithin asserts the client sends nothing for a while: the point of a
// refusal is that the read never happens.
func (fb *fakeBrowser) noCommandWithin(d time.Duration) {
	fb.t.Helper()
	got := make(chan string, 1)
	go func() {
		data, err := fb.fromCmd.ReadBytes(0)
		if err == nil || len(data) > 0 {
			got <- string(data)
		}
	}()
	select {
	case cmd := <-got:
		fb.t.Fatalf("the client sent a command after refusing: %s", cmd)
	case <-time.After(d):
	}
}

// useFakeBrowserAsActiveCDP makes getCDPForParams hand the handlers this fake
// client, so the real handler code runs with no Chromium anywhere.
func useFakeBrowserAsActiveCDP(t *testing.T, c *cdpClient) {
	t.Helper()
	activeCDP.mu.Lock()
	previous := activeCDP.client
	activeCDP.client = c
	activeCDP.mu.Unlock()
	t.Cleanup(func() {
		activeCDP.mu.Lock()
		activeCDP.client = previous
		activeCDP.mu.Unlock()
	})
}

func TestAssertNotLocalContentReadsTheMainFrame(t *testing.T) {
	cases := []struct {
		name     string
		mainURL  string
		children []string
		refuse   bool
	}{
		{name: "https page", mainURL: "https://example.com/", refuse: false},
		{name: "about blank", mainURL: "about:blank", refuse: false},
		{name: "data page", mainURL: "data:text/html,hi", refuse: false},
		{name: "file page", mainURL: "file:///etc/passwd", refuse: true},
		{name: "file page uppercase", mainURL: "FILE:///etc/passwd", refuse: true},
		{name: "view-source page", mainURL: "view-source:https://example.com/", refuse: true},
		{name: "filesystem page", mainURL: "filesystem:https://example.com/temporary/x", refuse: true},
		// The check is on the MAIN frame: a page whose subframe is (or failed
		// as) file: is still an ordinary page, and the model only ever gets the
		// main document's own content plus same-origin frames.
		{name: "https page with a file subframe", mainURL: "https://example.com/", children: []string{"file:///etc/passwd"}, refuse: false},
		// ... and a file: main frame is refused however innocent its children.
		{name: "file page with an https subframe", mainURL: "file:///tmp/x.html", children: []string{"https://example.com/"}, refuse: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fb := newFakeBrowser(t)
			errCh := make(chan error, 1)
			go func() { _, err := fb.client.assertNotLocalContent(); errCh <- err }()

			cmd := fb.nextCommand()
			if cmd.Method != "Page.getFrameTree" {
				t.Fatalf("the guard asked %q, want Page.getFrameTree", cmd.Method)
			}
			fb.frameTreeReply(cmd.ID, tc.mainURL, tc.children...)

			err := <-errCh
			if tc.refuse {
				if err == nil {
					t.Fatalf("%s was allowed to be read", tc.mainURL)
				}
				if !strings.Contains(err.Error(), "does not show local files") {
					t.Fatalf("refusal %q does not say why", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("%s was refused: %v", tc.mainURL, err)
			}
		})
	}
}

// Fail closed: if the frame tree cannot be read, the read does not happen.
func TestAssertNotLocalContentFailsClosed(t *testing.T) {
	fb := newFakeBrowser(t)
	errCh := make(chan error, 1)
	go func() { _, err := fb.client.assertNotLocalContent(); errCh <- err }()

	cmd := fb.nextCommand()
	fb.write(map[string]any{"id": cmd.ID, "error": map[string]any{"code": -32000, "message": "no page"}})

	err := <-errCh
	if err == nil {
		t.Fatal("a failed frame-tree check allowed the read")
	}
	if !strings.Contains(err.Error(), "refusing to read it") {
		t.Fatalf("error %q does not say the read was refused", err)
	}
}

// Every read-path handler must check before it reads anything.
func TestReadHandlersRefuseALocalPage(t *testing.T) {
	handlers := map[string]func(*SidecarConfig) RPCHandler{
		"browser_snapshot":    makeBrowserSnapshotHandler,
		"browser_screenshot":  makeBrowserScreenshotHandler,
		"browser_evaluate":    makeBrowserEvaluateHandler,
		"browser_ax_snapshot": makeBrowserAXSnapshotHandler,
	}
	params := map[string]map[string]any{
		"browser_evaluate": {"expression": "document.body.innerText"},
	}
	for name, newHandler := range handlers {
		t.Run(name, func(t *testing.T) {
			fb := newFakeBrowser(t)
			useFakeBrowserAsActiveCDP(t, fb.client)

			p := params[name]
			if p == nil {
				p = map[string]any{}
			}
			type outcome struct {
				res *RPCResult
				err error
			}
			done := make(chan outcome, 1)
			handler := newHandler(guardTestConfig())
			go func() {
				res, err := handler(p)
				done <- outcome{res, err}
			}()

			cmd := fb.nextCommand()
			if cmd.Method != "Page.getFrameTree" {
				t.Fatalf("%s read the page before checking it (first command was %q)", name, cmd.Method)
			}
			fb.frameTreeReply(cmd.ID, "file:///home/user/.ssh/id_rsa")

			got := <-done
			if got.err == nil {
				t.Fatalf("%s returned %+v for a file: page instead of refusing", name, got.res)
			}
			if !strings.Contains(got.err.Error(), "does not show local files") {
				t.Fatalf("%s refusal %q does not say why", name, got.err)
			}
			// And nothing was read: no screenshot, no script, no AX tree.
			fb.noCommandWithin(300 * time.Millisecond)
		})
	}
}

// The snapshot also refuses on the URL the page reports, behind the frame-tree
// check -- the daemon's snapshot does the same.
func TestSnapshotRefusesWhenThePageReportsLocalContent(t *testing.T) {
	fb := newFakeBrowser(t)

	type outcome struct {
		snap *pageSnapshot
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		snap, err := takePageSnapshot(fb.client)
		done <- outcome{snap, err}
	}()

	frameTree := fb.nextCommand()
	if frameTree.Method != "Page.getFrameTree" {
		t.Fatalf("snapshot's first command was %q, want Page.getFrameTree", frameTree.Method)
	}
	fb.frameTreeReply(frameTree.ID, "https://example.com/")

	script := fb.nextCommand()
	if script.Method != "Runtime.evaluate" {
		t.Fatalf("snapshot's second command was %q, want Runtime.evaluate", script.Method)
	}
	fb.write(map[string]any{
		"id": script.ID,
		"result": map[string]any{
			"result": map[string]any{
				"type":  "string",
				"value": `{"title":"x","url":"file:///etc/passwd","text":"root:x:0:0","elements":[]}`,
			},
		},
	})

	got := <-done
	if got.err == nil {
		t.Fatalf("a snapshot reporting a file: URL was returned: %+v", got.snap)
	}
	if !strings.Contains(got.err.Error(), "does not show local files") {
		t.Fatalf("refusal %q does not say why", got.err)
	}
}

// An ordinary page is snapshotted as before: the guard adds one round-trip and
// changes nothing else.
func TestSnapshotOfAnOrdinaryPageStillWorks(t *testing.T) {
	fb := newFakeBrowser(t)

	type outcome struct {
		snap *pageSnapshot
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		snap, err := takePageSnapshot(fb.client)
		done <- outcome{snap, err}
	}()

	frameTree := fb.nextCommand()
	fb.frameTreeReply(frameTree.ID, "https://example.com/")

	script := fb.nextCommand()
	fb.write(map[string]any{
		"id": script.ID,
		"result": map[string]any{
			"result": map[string]any{
				"type": "string",
				"value": `{"title":"Example","url":"https://example.com/","text":"hello",` +
					`"elements":[{"id":1,"tag":"button","text":"Go","attrs":{"aria-label":"go"},"x":10,"y":20}]}`,
			},
		},
	})
	// The read paths check, read, then check again; answer the second check with
	// the same document.
	fb.answerFrameTree("https://example.com/")

	got := <-done
	if got.err != nil {
		t.Fatalf("snapshot of an ordinary page: %v", got.err)
	}
	if got.snap.Title != "Example" || got.snap.URL != "https://example.com/" || len(got.snap.Elements) != 1 {
		t.Fatalf("snapshot came back wrong: %+v", got.snap)
	}
	if coords, ok := fb.client.elementCoordsFor(1); !ok || coords != [2]float64{10, 20} {
		t.Fatalf("element coordinates were not stored: %v %v", coords, ok)
	}
}

// The AX snapshot reads the same document by another route -- an accessible name
// IS the document's text -- so it gets the page-reported URL check too, not only
// the frame-tree one.
func TestAXSnapshotRefusesWhenThePageReportsLocalContent(t *testing.T) {
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)

	type outcome struct {
		res *RPCResult
		err error
	}
	done := make(chan outcome, 1)
	handler := makeBrowserAXSnapshotHandler(guardTestConfig())
	go func() {
		res, err := handler(map[string]any{})
		done <- outcome{res, err}
	}()

	fb.answerFrameTree("https://example.com/")

	axTree := fb.nextCommand()
	if axTree.Method != "Accessibility.getFullAXTree" {
		t.Fatalf("second command was %q, want Accessibility.getFullAXTree", axTree.Method)
	}
	fb.write(map[string]any{
		"id": axTree.ID,
		"result": map[string]any{
			"nodes": []any{map[string]any{
				"nodeId": "1", "role": map[string]any{"value": "StaticText"},
				"name": map[string]any{"value": "root:x:0:0:root:/root:/bin/bash"},
			}},
		},
	})

	// The page's own view of where it is says file:.
	pageInfo := fb.nextCommand()
	if pageInfo.Method != "Runtime.evaluate" {
		t.Fatalf("third command was %q, want Runtime.evaluate", pageInfo.Method)
	}
	fb.write(map[string]any{
		"id": pageInfo.ID,
		"result": map[string]any{
			"result": map[string]any{
				"type":  "string",
				"value": `{"url":"file:///etc/passwd","title":"passwd"}`,
			},
		},
	})

	got := <-done
	if got.err == nil {
		t.Fatalf("the AX tree of a file: page was returned: %+v", got.res)
	}
	if !strings.Contains(got.err.Error(), "does not show local files") {
		t.Fatalf("refusal %q does not say why", got.err)
	}
}

// A read that raced a navigation is discarded: the bytes may have come from a
// document nobody checked.
func TestReadIsDiscardedWhenThePageNavigatedUnderIt(t *testing.T) {
	fb := newFakeBrowser(t)

	type outcome struct {
		snap *pageSnapshot
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		snap, err := takePageSnapshot(fb.client)
		done <- outcome{snap, err}
	}()

	first := fb.nextCommand()
	fb.frameTreeReplyFull(first.ID, "https://example.com/", "loader-1", "https://example.com")

	script := fb.nextCommand()
	fb.write(map[string]any{
		"id": script.ID,
		"result": map[string]any{
			"result": map[string]any{
				"type":  "string",
				"value": `{"title":"Example","url":"https://example.com/","text":"hello","elements":[]}`,
			},
		},
	})

	// Same URL, new document: only the loaderId gives it away.
	second := fb.nextCommand()
	if second.Method != "Page.getFrameTree" {
		t.Fatalf("the read did not check the page again (got %q)", second.Method)
	}
	fb.frameTreeReplyFull(second.ID, "https://example.com/", "loader-2", "https://example.com")

	got := <-done
	if got.err == nil {
		t.Fatalf("a snapshot taken across a navigation was returned: %+v", got.snap)
	}
	if !strings.Contains(got.err.Error(), "navigated") {
		t.Fatalf("error %q does not say the page changed", got.err)
	}
}

// A document can hold a file: origin while wearing a URL that matches none of
// the local-content prefixes (a blob: or about:blank document inherits the
// origin of whatever created it), so the origin is checked too.
func TestAssertNotLocalContentRefusesAnInheritedFileOrigin(t *testing.T) {
	fb := newFakeBrowser(t)
	errCh := make(chan error, 1)
	go func() { _, err := fb.client.assertNotLocalContent(); errCh <- err }()

	cmd := fb.nextCommand()
	fb.frameTreeReplyFull(cmd.ID, "blob:null/2f7a-1", "loader-1", "file://")

	err := <-errCh
	if err == nil {
		t.Fatal("a document with a file: origin was allowed to be read")
	}
	if !strings.Contains(err.Error(), "local-file origin") {
		t.Fatalf("refusal %q does not name the origin", err)
	}
}

// ... and an ordinary page's origin must not trip that check.
func TestAssertNotLocalContentAllowsOrdinaryOrigins(t *testing.T) {
	for _, origin := range []string{"https://example.com", "://", "", "http://localhost:3000"} {
		t.Run(origin, func(t *testing.T) {
			fb := newFakeBrowser(t)
			errCh := make(chan error, 1)
			go func() { _, err := fb.client.assertNotLocalContent(); errCh <- err }()

			cmd := fb.nextCommand()
			fb.frameTreeReplyFull(cmd.ID, "https://example.com/", "loader-1", origin)

			if err := <-errCh; err != nil {
				t.Fatalf("origin %q was refused: %v", origin, err)
			}
		})
	}
}
