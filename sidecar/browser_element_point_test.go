package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// browser_element_point's tests (#591).
//
// All of them run the REAL handler over the fake CDP pipe
// (browser_fetch_guard_test.go), so the real read guards, the real generation
// bookkeeping and the real arithmetic execute with no Chromium anywhere. What a
// real browser would add is whether Chrome's window bounds and layout metrics
// mean what this code thinks -- and that is not a fake's job to answer, so it
// was measured directly instead (see the docblocks in
// browser_element_point.go).

// elementPointFixture is a fake browser with one element already in the
// snapshot map, as a snapshot would have left it.
type elementPointFixture struct {
	fb *fakeBrowser
}

func newElementPointFixture(t *testing.T, loaderID string) *elementPointFixture {
	t.Helper()
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)
	// Exactly what takePageSnapshot leaves behind, written directly so the test
	// is about the handler rather than about driving a snapshot.
	fb.client.elemCoords = map[int][2]float64{1: {300, 250}, 2: {40, 60}}
	fb.client.elemFrames = map[int]bool{2: true}
	fb.client.elemIdentity = pageIdentity{
		url: "https://mail.example.com/", loaderID: loaderID, origin: "https://mail.example.com",
	}
	fb.client.elemFrameStamp = "child:L-child|main:" + loaderID
	fb.client.elemGen = 7
	return &elementPointFixture{fb: fb}
}

// answerFrameTreeWithChild answers one Page.getFrameTree with a main frame and
// one child, both named, shaped as Chrome's reply is.
func (f *elementPointFixture) answerFrameTreeWithChild(id int64, loaderID, childLoaderID string) {
	f.fb.t.Helper()
	f.fb.write(map[string]any{
		"id": id,
		"result": map[string]any{
			"frameTree": map[string]any{
				"frame": map[string]any{
					"id": "main", "url": "https://mail.example.com/",
					"loaderId": loaderID, "securityOrigin": "https://mail.example.com",
				},
				"childFrames": []any{map[string]any{
					"frame": map[string]any{
						"id": "child", "url": "https://mail.example.com/compose",
						"loaderId": childLoaderID, "securityOrigin": "https://mail.example.com",
					},
				}},
			},
		},
	})
}

// answerWindowBounds answers Browser.getWindowForTarget. One call carries the
// bounds, which is why the handler needs no getWindowBounds round trip.
func (f *elementPointFixture) answerWindowBounds(id int64, left, top, height float64) {
	f.fb.t.Helper()
	f.fb.write(map[string]any{
		"id": id,
		"result": map[string]any{
			"windowId": 770695674,
			"bounds": map[string]any{
				"left": left, "top": top, "width": 1200.0, "height": height,
				"windowState": "normal",
			},
		},
	})
}

func (f *elementPointFixture) answerLayoutMetrics(id int64, cssClientHeight float64, zoom any) {
	f.fb.t.Helper()
	visual := map[string]any{"clientWidth": 1200.0, "clientHeight": cssClientHeight, "scale": 1.0}
	if zoom != nil {
		visual["zoom"] = zoom
	}
	f.fb.write(map[string]any{
		"id": id,
		"result": map[string]any{
			"cssLayoutViewport": map[string]any{"clientWidth": 1200.0, "clientHeight": cssClientHeight},
			"cssVisualViewport": visual,
		},
	})
}

// callElementPoint runs the handler on its own goroutine, since it blocks on
// CDP replies the test has to script.
func callElementPoint(t *testing.T, params map[string]any) (<-chan *RPCResult, <-chan error) {
	t.Helper()
	res := make(chan *RPCResult, 1)
	errs := make(chan error, 1)
	go func() {
		r, err := handleBrowserElementPoint(params)
		if err != nil {
			errs <- err
			return
		}
		res <- r
	}()
	return res, errs
}

func awaitPoint(t *testing.T, res <-chan *RPCResult, errs <-chan error) map[string]any {
	t.Helper()
	select {
	case r := <-res:
		m, ok := r.Result.(map[string]any)
		if !ok {
			t.Fatalf("reply is not an object: %#v", r.Result)
		}
		return m
	case err := <-errs:
		t.Fatalf("expected a point, got a refusal: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the handler never answered")
	}
	return nil
}

func awaitRefusal(t *testing.T, res <-chan *RPCResult, errs <-chan error) error {
	t.Helper()
	select {
	case r := <-res:
		t.Fatalf("expected a refusal, got a point: %#v", r.Result)
	case err := <-errs:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("the handler never answered")
	}
	return nil
}

// refusalCode reads the code the daemon will classify on.
//
// errors.As, not a type assertion, because that is how handlerRPCError
// classifies (sidecar/client.go) -- a test that unwrapped differently from
// production could pass while the daemon saw HANDLER_ERROR, or fail while
// production worked.
func refusalCode(t *testing.T, err error) string {
	t.Helper()
	var coded *codedError
	if !errors.As(err, &coded) {
		t.Fatalf("refusal is not a codedError, so the daemon would have to parse its text: %v", err)
	}
	return coded.code
}

// refusalMentionsNoURL guards the log-line promise: the daemon turns a refusal
// here into a line about a skipped coordinate, and #594 refused to put a URL in
// one. The sidecar's own message is what would carry it.
func refusalMentionsNoURL(t *testing.T, err error) {
	t.Helper()
	for _, marker := range []string{"http://", "https://", "file://", "data:", "about:"} {
		if strings.Contains(err.Error(), marker) {
			t.Fatalf("the refusal message carries a URL (%q), which must never reach the daemon's log line: %v", marker, err)
		}
	}
}

// The headline: the handler answers a point, in the documented space, paired
// with the loader id of the document it belongs to.
func TestBrowserElementPointAnswersAPointForTheCurrentDocument(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("first command = %q, want Page.getFrameTree", c.Method)
	}
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")

	c = f.fb.nextCommand()
	if c.Method != "Browser.getWindowForTarget" {
		t.Fatalf("second command = %q, want Browser.getWindowForTarget", c.Method)
	}
	// A browser-level domain command scoped to the attached page ONLY by the
	// session id, and it must carry no targetId: a caller-supplied one would
	// read another target's window.
	if c.Params != nil {
		if _, ok := c.Params["targetId"]; ok {
			t.Fatal("getWindowForTarget carried a targetId; it must resolve off the session")
		}
	}
	f.answerWindowBounds(c.ID, 137, 91, 800)

	c = f.fb.nextCommand()
	if c.Method != "Page.getLayoutMetrics" {
		t.Fatalf("third command = %q, want Page.getLayoutMetrics", c.Method)
	}
	f.answerLayoutMetrics(c.ID, 657, 1.0)

	// CHECK AGAIN.
	c = f.fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("fourth command = %q, want the re-check Page.getFrameTree", c.Method)
	}
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")

	got := awaitPoint(t, res, errs)
	// x = 137 + 300, y = 91 + (800 - 657) + 250 = 91 + 143 + 250.
	if got["x"] != 437 || got["y"] != 484 {
		t.Fatalf("point = (%v,%v), want (437,484)", got["x"], got["y"])
	}
	if got["space"] != "screen_dip" {
		t.Fatalf("space = %v, want screen_dip", got["space"])
	}
	if got["loader_id"] != "L1" {
		t.Fatalf("loader_id = %v, want L1", got["loader_id"])
	}
	// A coordinate never travels without its document, and no URL travels at
	// all -- a coords reply must not be a third place a page URL can arrive
	// from (#572, browser_ax.go).
	if _, ok := got["page_url"]; ok {
		t.Fatal("the reply carried a page_url; it must carry no URL at all")
	}
}

// The whole read-authority claim, as an assertion rather than a comment.
func TestBrowserElementPointSendsOnlyReads(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	var sent []string
	for i := 0; i < 4; i++ {
		c := f.fb.nextCommand()
		sent = append(sent, c.Method)
		switch c.Method {
		case "Page.getFrameTree":
			f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
		case "Browser.getWindowForTarget":
			f.answerWindowBounds(c.ID, 0, 0, 800)
		case "Page.getLayoutMetrics":
			f.answerLayoutMetrics(c.ID, 657, 1.0)
		default:
			t.Fatalf("the handler sent %q: browser_element_point is read-only and must send "+
				"only Page.getFrameTree, Browser.getWindowForTarget and Page.getLayoutMetrics", c.Method)
		}
	}
	awaitPoint(t, res, errs)

	want := "Page.getFrameTree,Browser.getWindowForTarget,Page.getLayoutMetrics,Page.getFrameTree"
	if got := strings.Join(sent, ","); got != want {
		t.Fatalf("CDP methods sent = %q, want exactly %q", got, want)
	}
	// And nothing more afterwards: no input, no focus, no navigation.
	f.fb.noCommandWithin(300 * time.Millisecond)
}

// The pebble's coordinate must never be the reason a browser appears.
func TestBrowserElementPointNeverLaunchesABrowser(t *testing.T) {
	// No active CDP client at all. There is no config to pass either, which is
	// the structural half of the guarantee: the handler is registered bare, so
	// it has nothing to launch a browser with.
	activeCDP.mu.Lock()
	previous := activeCDP.client
	activeCDP.client = nil
	activeCDP.mu.Unlock()
	t.Cleanup(func() {
		activeCDP.mu.Lock()
		activeCDP.client = previous
		activeCDP.mu.Unlock()
	})

	_, err := handleBrowserElementPoint(map[string]any{"element_id": float64(1)})
	if err == nil {
		t.Fatal("expected a refusal when no browser is running")
	}
	if code := refusalCode(t, err); code != errNoBrowser {
		t.Fatalf("refusal code = %q, want %q", code, errNoBrowser)
	}
	activeCDP.mu.Lock()
	launched := activeCDP.client
	activeCDP.mu.Unlock()
	if launched != nil {
		t.Fatal("the handler installed a CDP client: it must never launch a browser")
	}
}

// `headless` is ignored, not honoured. getCDP tears a running browser down and
// relaunches it when an explicit headless disagrees; a read-only handler must
// not be able to reach that.
func TestBrowserElementPointIgnoresHeadlessAndCannotTearDownTheBrowser(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	f.fb.client.headless = false

	res, errs := callElementPoint(t, map[string]any{
		"element_id": float64(1), "headless": true,
	})
	for i := 0; i < 4; i++ {
		c := f.fb.nextCommand()
		switch c.Method {
		case "Page.getFrameTree":
			f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
		case "Browser.getWindowForTarget":
			f.answerWindowBounds(c.ID, 0, 0, 800)
		case "Page.getLayoutMetrics":
			f.answerLayoutMetrics(c.ID, 657, 1.0)
		default:
			t.Fatalf("unexpected command %q", c.Method)
		}
	}
	awaitPoint(t, res, errs)

	if f.fb.client.closed.Load() {
		t.Fatal("the browser was shut down by a read-only call that passed headless:true")
	}
	activeCDP.mu.Lock()
	still := activeCDP.client
	activeCDP.mu.Unlock()
	if still != f.fb.client {
		t.Fatal("the active browser was replaced by a read-only call")
	}
}

// A stale coordinate is the bug #585 exists to remove, so the answer is refused
// rather than guessed.
func TestBrowserElementPointRefusesADocumentTheBrowserHasLeft(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	// The page has committed a NEW document since the snapshot.
	f.answerFrameTreeWithChild(c.ID, "L2-different", "L-child")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
	// Refusing means the geometry was never read: no window bounds, no metrics.
	f.fb.noCommandWithin(300 * time.Millisecond)
}

// A same-origin subframe can navigate itself while the main frame's loaderId
// never moves, which leaves an in-frame coordinate pointing into a destroyed
// document.
func TestBrowserElementPointRefusesAnInFrameElementAfterTheFrameNavigates(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	// Element 2 is the one the snapshot took from the subframe.
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(2)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child-NEW")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
	f.fb.noCommandWithin(300 * time.Millisecond)
}

// ...and the same frame change must NOT cost a pointer for a main-document
// element. An unrelated advertising iframe reloading is not a reason to stop
// narrating the page.
func TestBrowserElementPointStillAnswersAMainDocumentElementWhenAFrameNavigates(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	for i := 0; i < 4; i++ {
		c := f.fb.nextCommand()
		switch c.Method {
		case "Page.getFrameTree":
			f.answerFrameTreeWithChild(c.ID, "L1", "L-child-NEW")
		case "Browser.getWindowForTarget":
			f.answerWindowBounds(c.ID, 137, 91, 800)
		case "Page.getLayoutMetrics":
			f.answerLayoutMetrics(c.ID, 657, 1.0)
		default:
			t.Fatalf("unexpected command %q", c.Method)
		}
	}
	got := awaitPoint(t, res, errs)
	if got["x"] != 437 {
		t.Fatalf("x = %v, want 437", got["x"])
	}
}

// A snapshot of the SAME document refills the map and leaves the loaderId
// untouched, so the identity check cannot see it. This is what elemGen is for.
func TestBrowserElementPointRefusesWhenANewSnapshotReplacedTheMap(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")

	c = f.fb.nextCommand()
	f.answerWindowBounds(c.ID, 137, 91, 800)

	// A concurrent snapshot lands while the geometry is being read: same
	// document, different coordinates, new generation.
	f.fb.client.elemMu.Lock()
	f.fb.client.elemCoords[1] = [2]float64{999, 999}
	f.fb.client.elemGen++
	f.fb.client.elemMu.Unlock()

	c = f.fb.nextCommand()
	f.answerLayoutMetrics(c.ID, 657, 1.0)
	// The document never changed, so the re-check passes and ONLY the
	// generation can catch this -- which is the whole point of elemGen.
	c = f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
}

func TestBrowserElementPointRefusesAnIDTheSnapshotNeverMinted(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(99)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errNoElement {
		t.Fatalf("refusal code = %q, want %q", code, errNoElement)
	}
	f.fb.noCommandWithin(300 * time.Millisecond)
}

func TestBrowserElementPointRefusesAnIDThatIsNotASnapshotID(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
	}{
		{"absent", nil},
		{"a string", "1"},
		{"zero", float64(0)},
		{"negative", float64(-3)},
		{"fractional", float64(1.5)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			newElementPointFixture(t, "L1")
			params := map[string]any{}
			if tc.value != nil {
				params["element_id"] = tc.value
			}
			_, err := handleBrowserElementPoint(params)
			if err == nil {
				t.Fatal("expected a refusal")
			}
			if code := refusalCode(t, err); code != errBadElementID {
				t.Fatalf("refusal code = %q, want %q", code, errBadElementID)
			}
		})
	}
}

// A nameless frame tree cannot be told apart from another nameless one, so it
// is refused rather than compared as equal (which is what assertSamePage would
// do with two empty ids).
func TestBrowserElementPointRefusesANamelessDocument(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "", "L-child")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
}

// A page showing local content is not read, and a coordinate is not the one
// exception (#526).
func TestBrowserElementPointRefusesLocalContent(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	f.fb.write(map[string]any{
		"id": c.ID,
		"result": map[string]any{
			"frameTree": map[string]any{
				"frame": map[string]any{
					"id": "main", "url": "file:///etc/passwd",
					"loaderId": "L1", "securityOrigin": "file://",
				},
			},
		},
	})

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
	f.fb.noCommandWithin(300 * time.Millisecond)
}

// The zoom factor multiplies every term, so a nonsense value is refused rather
// than clamped: a silently corrected coordinate is a confident wrong pointer.
func TestBrowserElementPointRefusesAnUnusableZoom(t *testing.T) {
	for _, zoom := range []any{float64(0), float64(-1), float64(1e9)} {
		t.Run("", func(t *testing.T) {
			f := newElementPointFixture(t, "L1")
			res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

			c := f.fb.nextCommand()
			f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
			c = f.fb.nextCommand()
			f.answerWindowBounds(c.ID, 137, 91, 800)
			c = f.fb.nextCommand()
			f.answerLayoutMetrics(c.ID, 657, zoom)

			err := awaitRefusal(t, res, errs)
			if code := refusalCode(t, err); code != errNoGeometry {
				t.Fatalf("refusal code = %q, want %q", code, errNoGeometry)
			}
		})
	}
}

// An absent zoom means 1, which is what every real reply reported. A missing
// BOUND, by contrast, is not 0: a window at x=0 is ordinary and a reply that
// did not say where the window is must not look the same as one that did.
func TestBrowserElementPointTreatsAnAbsentZoomAsOneAndAMissingBoundAsAnError(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})
	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	c = f.fb.nextCommand()
	f.answerWindowBounds(c.ID, 137, 91, 800)
	c = f.fb.nextCommand()
	f.answerLayoutMetrics(c.ID, 657, nil) // no zoom field at all
	c = f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	if got := awaitPoint(t, res, errs); got["y"] != 484 {
		t.Fatalf("y = %v with an absent zoom, want 484", got["y"])
	}

	f2 := newElementPointFixture(t, "L1")
	res, errs = callElementPoint(t, map[string]any{"element_id": float64(1)})
	c = f2.fb.nextCommand()
	f2.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	c = f2.fb.nextCommand()
	f2.fb.write(map[string]any{
		"id":     c.ID,
		"result": map[string]any{"windowId": 1, "bounds": map[string]any{"width": 1200.0}},
	})
	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errNoGeometry {
		t.Fatalf("refusal code = %q, want %q", code, errNoGeometry)
	}
}

// The page zoom is applied to the element offset as well as to the viewport
// height, because it is the CSS-px -> DIP ratio and every term is in CSS px.
func TestBrowserElementPointAppliesTheZoomToTheElementOffset(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})
	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	c = f.fb.nextCommand()
	f.answerWindowBounds(c.ID, 100, 50, 800)
	c = f.fb.nextCommand()
	// At zoom 1.5 the viewport is 400 CSS px tall, i.e. 600 DIP, so the chrome
	// is 200 DIP and the element's 300x250 CSS offset is 450x375 DIP.
	f.answerLayoutMetrics(c.ID, 400, 1.5)
	c = f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")

	got := awaitPoint(t, res, errs)
	if got["x"] != 550 { // 100 + 300*1.5
		t.Fatalf("x = %v, want 550", got["x"])
	}
	if got["y"] != 625 { // 50 + (800 - 400*1.5) + 250*1.5
		t.Fatalf("y = %v, want 625", got["y"])
	}
}

// takePageSnapshot must not leave behind a map nobody can use: every reader
// refuses an unnamed document, so filling it would give the model a snapshot
// whose ids are all dead.
func TestTakePageSnapshotRefusesWhenTheBrowserNamesNoDocument(t *testing.T) {
	fb := newFakeBrowser(t)
	done := make(chan error, 1)
	go func() {
		_, _, err := takePageSnapshot(fb.client)
		done <- err
	}()

	c := fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("first command = %q, want Page.getFrameTree", c.Method)
	}
	fb.frameTreeReplyFull(c.ID, "https://example.com/", "", "https://example.com")

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a refusal for a nameless document")
		}
		if !strings.Contains(err.Error(), "did not name the document") {
			t.Fatalf("refusal = %q, want it to say the document was not named", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("takePageSnapshot never returned")
	}
	// And the snapshot script was never evaluated.
	fb.noCommandWithin(300 * time.Millisecond)
	if fb.client.elemCoords != nil {
		t.Fatal("the coordinate map was filled for a document the browser did not name")
	}
}

// A hidden browser has no position on anyone's screen, and only the sidecar
// knows it is hidden. Without this the handler answers a well-formed point --
// headless Chromium reports ordinary-looking bounds -- and the pebble flies to
// it and sits over whatever application really occupies that spot.
func TestBrowserElementPointRefusesAHeadlessBrowser(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	f.fb.client.headless = true

	_, err := handleBrowserElementPoint(map[string]any{"element_id": float64(1)})
	if err == nil {
		t.Fatal("expected a refusal for a browser with no window on the screen")
	}
	if code := refusalCode(t, err); code != errNoGeometry {
		t.Fatalf("refusal code = %q, want %q", code, errNoGeometry)
	}
	// And it refused before reading anything at all.
	f.fb.noCommandWithin(300 * time.Millisecond)
}

// A minimized window reports the bounds it would be RESTORED to, which is not
// where it is.
func TestBrowserElementPointRefusesAMinimizedWindow(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	c = f.fb.nextCommand()
	f.fb.write(map[string]any{
		"id": c.ID,
		"result": map[string]any{"windowId": 1, "bounds": map[string]any{
			"left": 137.0, "top": 91.0, "width": 1200.0, "height": 800.0,
			"windowState": "minimized",
		}},
	})

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errNoGeometry {
		t.Fatalf("refusal code = %q, want %q", code, errNoGeometry)
	}
}

// The snapshot filters on visibility, not on viewport containment, so an element
// below the fold sits in the map with a coordinate no screen position
// corresponds to. Answering it would put the pointer outside the window.
func TestBrowserElementPointRefusesAnElementOutsideTheViewport(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	f.fb.client.elemMu.Lock()
	f.fb.client.elemCoords[1] = [2]float64{300, 2500} // 2500 CSS px below the fold
	f.fb.client.elemMu.Unlock()

	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})
	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	c = f.fb.nextCommand()
	f.answerWindowBounds(c.ID, 137, 91, 800)
	c = f.fb.nextCommand()
	f.answerLayoutMetrics(c.ID, 657, 1.0)

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errNoGeometry {
		t.Fatalf("refusal code = %q, want %q", code, errNoGeometry)
	}
}

// The in-frame SUCCESS path. Without this, an in-frame branch that refused
// unconditionally -- a wrong stamp source, a format mismatch -- would ship
// green, because the only other in-frame test asserts a refusal.
func TestBrowserElementPointAnswersAnInFrameElementWhenNothingNavigated(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(2)})

	var sent []string
	for i := 0; i < 4; i++ {
		c := f.fb.nextCommand()
		sent = append(sent, c.Method)
		switch c.Method {
		case "Page.getFrameTree":
			f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
		case "Browser.getWindowForTarget":
			f.answerWindowBounds(c.ID, 137, 91, 800)
		case "Page.getLayoutMetrics":
			f.answerLayoutMetrics(c.ID, 657, 1.0)
		default:
			t.Fatalf("unexpected command %q", c.Method)
		}
	}

	got := awaitPoint(t, res, errs)
	// Element 2 is at 40,60 in top-page space.
	if got["x"] != 177 || got["y"] != 294 { // 137+40, 91+143+60
		t.Fatalf("in-frame point = (%v,%v), want (177,294)", got["x"], got["y"])
	}
	// An in-frame element must cost no extra round trip: the frame digest comes
	// out of the same re-check read as the document identity.
	want := "Page.getFrameTree,Browser.getWindowForTarget,Page.getLayoutMetrics,Page.getFrameTree"
	if joined := strings.Join(sent, ","); joined != want {
		t.Fatalf("in-frame path sent %q, want exactly %q", joined, want)
	}
	f.fb.noCommandWithin(300 * time.Millisecond)
}

// The re-check has to READ its reply, not merely be sent. A handler that issued
// the fourth getFrameTree and ignored the answer would satisfy the
// exact-method-set test.
func TestBrowserElementPointRefusesANavigationDuringTheGeometryRead(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	c = f.fb.nextCommand()
	f.answerWindowBounds(c.ID, 137, 91, 800)
	c = f.fb.nextCommand()
	f.answerLayoutMetrics(c.ID, 657, 1.0)
	// The page committed a new document while the geometry was being read.
	c = f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L2-during-read", "L-child")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
}

// ...and the in-frame version of the same: the MAIN document held, but the frame
// the element came from navigated mid-read.
func TestBrowserElementPointRefusesAFrameNavigationDuringTheGeometryRead(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(2)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child")
	c = f.fb.nextCommand()
	f.answerWindowBounds(c.ID, 137, 91, 800)
	c = f.fb.nextCommand()
	f.answerLayoutMetrics(c.ID, 657, 1.0)
	c = f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, "L1", "L-child-NEW")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
}

// The refusal the daemon logs about must not carry a URL (#594). The one that
// would is the local-content refusal, whose shared wording interpolates it.
func TestBrowserElementPointRefusalsCarryNoURL(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	f.fb.write(map[string]any{
		"id": c.ID,
		"result": map[string]any{"frameTree": map[string]any{
			"frame": map[string]any{
				"id": "main", "url": "file:///home/someone/secret-plans.html",
				"loaderId": "L1", "securityOrigin": "file://",
			},
		}},
	})

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
	refusalMentionsNoURL(t, err)
	if strings.Contains(err.Error(), "secret-plans") {
		t.Fatalf("the refusal leaked the page's path: %v", err)
	}
}

// An over-long loader id is refused rather than truncated: a truncated identity
// is a different document, and one oversized field drops the brain's whole
// event.
func TestBrowserElementPointRefusesAnOverLongLoaderID(t *testing.T) {
	f := newElementPointFixture(t, "L1")
	res, errs := callElementPoint(t, map[string]any{"element_id": float64(1)})

	c := f.fb.nextCommand()
	f.answerFrameTreeWithChild(c.ID, strings.Repeat("A", maxWireLoaderID+1), "L-child")

	err := awaitRefusal(t, res, errs)
	if code := refusalCode(t, err); code != errStalePage {
		t.Fatalf("refusal code = %q, want %q", code, errStalePage)
	}
	f.fb.noCommandWithin(300 * time.Millisecond)
}

// What takePageSnapshot actually records, asserted against a driven snapshot
// rather than described by a hand-written fixture.
//
// This is the test that keeps the #592 subframe guard alive. `elemFrames` is
// keyed off `attrs.iframe`, and without driving a real snapshot that key could
// be misspelled -- "iFrame", or a changed script key -- and every other test in
// this file would still pass, because their `inFrame` comes from the fixture.
// The guard would quietly become dead code and elemFrames would be empty for
// every real page.
func TestTakePageSnapshotRecordsTheDocumentGenerationAndFrameProvenance(t *testing.T) {
	fb := newFakeBrowser(t)
	fb.client.elemGen = 41

	done := make(chan error, 1)
	go func() {
		_, _, err := takePageSnapshot(fb.client)
		done <- err
	}()

	frameTree := func(id int64, childLoader string) {
		fb.write(map[string]any{
			"id": id,
			"result": map[string]any{"frameTree": map[string]any{
				"frame": map[string]any{
					"id": "main", "url": "https://mail.example.com/",
					"loaderId": "L-main", "securityOrigin": "https://mail.example.com",
				},
				"childFrames": []any{map[string]any{"frame": map[string]any{
					"id": "child", "url": "https://mail.example.com/compose",
					"loaderId": childLoader, "securityOrigin": "https://mail.example.com",
				}}},
			}},
		})
	}

	c := fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("first command = %q, want Page.getFrameTree", c.Method)
	}
	frameTree(c.ID, "L-child")

	// The isolated world the element refs go in (#592).
	fb.expectIsolatedWorld()

	c = fb.nextCommand()
	if c.Method != "Runtime.evaluate" {
		t.Fatalf("third command = %q, want Runtime.evaluate", c.Method)
	}
	if c.Params["contextId"] == nil {
		t.Fatal("the snapshot script was evaluated with no contextId, i.e. in the page's main world")
	}
	// Element 2 carries the iframe marker the snapshot script sets for anything
	// it collected from a subframe.
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"value": `{"title":"Inbox","url":"https://mail.example.com/","text":"hi",` +
			`"elements":[{"id":1,"tag":"button","text":"Send","attrs":{},"x":300,"y":250},` +
			`{"id":2,"tag":"input","text":"","attrs":{"iframe":"true"},"x":40,"y":60}]}`},
	}})

	// The check-again read.
	c = fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("third command = %q, want the re-check Page.getFrameTree", c.Method)
	}
	frameTree(c.ID, "L-child")

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("takePageSnapshot: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("takePageSnapshot never returned")
	}

	fb.client.elemMu.Lock()
	defer fb.client.elemMu.Unlock()
	if fb.client.elemIdentity.loaderID != "L-main" {
		t.Fatalf("elemIdentity.loaderID = %q, want L-main", fb.client.elemIdentity.loaderID)
	}
	if fb.client.elemGen != 42 {
		t.Fatalf("elemGen = %d, want exactly one more than before (42)", fb.client.elemGen)
	}
	if fb.client.elemFrames[1] {
		t.Fatal("element 1 came from the main document but was recorded as in-frame")
	}
	if !fb.client.elemFrames[2] {
		t.Fatal("element 2 carried attrs.iframe but was NOT recorded as in-frame: " +
			"the #592 subframe guard is dead code for every real page")
	}
	if want := "child:L-child|main:L-main"; fb.client.elemFrameStamp != want {
		t.Fatalf("elemFrameStamp = %q, want %q", fb.client.elemFrameStamp, want)
	}
	if fb.client.elemCoords[2] != [2]float64{40, 60} {
		t.Fatalf("elemCoords[2] = %v, want [40 60]", fb.client.elemCoords[2])
	}
}

// The digest has to notice a frame appearing or disappearing, not only a
// loaderId changing -- an iframe replaced by a new one with a coincidentally
// equal loaderId is not the same page.
func TestFrameTreeStampDistinguishesTheFrameSet(t *testing.T) {
	fb := newFakeBrowser(t)

	read := func(reply func(id int64)) string {
		t.Helper()
		out := make(chan string, 1)
		go func() {
			_, s, err := fb.client.frameTreeState(cdpDefaultTimeout)
			if err != nil {
				t.Errorf("frameTreeState: %v", err)
			}
			out <- s
		}()
		c := fb.nextCommand()
		reply(c.ID)
		select {
		case s := <-out:
			return s
		case <-time.After(5 * time.Second):
			t.Fatal("frameTreeState never returned")
			return ""
		}
	}

	oneChild := read(func(id int64) {
		fb.write(map[string]any{"id": id, "result": map[string]any{
			"frameTree": map[string]any{
				"frame":       map[string]any{"id": "main", "loaderId": "L1"},
				"childFrames": []any{map[string]any{"frame": map[string]any{"id": "c1", "loaderId": "X"}}},
			}}})
	})
	otherChild := read(func(id int64) {
		fb.write(map[string]any{"id": id, "result": map[string]any{
			"frameTree": map[string]any{
				"frame":       map[string]any{"id": "main", "loaderId": "L1"},
				"childFrames": []any{map[string]any{"frame": map[string]any{"id": "c2", "loaderId": "X"}}},
			}}})
	})
	noChild := read(func(id int64) {
		fb.write(map[string]any{"id": id, "result": map[string]any{
			"frameTree": map[string]any{"frame": map[string]any{"id": "main", "loaderId": "L1"}},
		}})
	})

	if oneChild == otherChild {
		t.Fatal("a different frame with the same loaderId produced the same stamp")
	}
	if oneChild == noChild {
		t.Fatal("losing a frame produced the same stamp")
	}
}
