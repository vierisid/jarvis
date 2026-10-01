package main

// #603 - the document identity has to mean "the thing it identifies has not
// changed", and in three ways it did not:
//
//   - document.open()/document.write() replaces the DOM while the loaderId AND
//     the URL both hold (measured), so every loaderId comparison saw an
//     unchanged document while every element ref and coordinate in it was
//     stale;
//   - assertSamePage compared two EMPTY loaderIds as equal, so an unnamed
//     document passed a guard that cannot tell which document it is looking at;
//   - a scroll invalidated every coordinate with nothing to see it.
//
// The constraint the fix has to respect: `history.pushState` changes
// frame.url WITHOUT changing the loaderId (measured), and that is how every SPA
// navigates -- so the identity cannot simply compare more fields.

import (
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// TestAssertSamePageRefusesAnUnnamedDocument: the empty-loaderId refusal is a
// property of the HELPER now, not of whichever caller remembered it. Three call
// sites had to remember separately and two did not (the screenshot and evaluate
// handlers).
func TestAssertSamePageRefusesAnUnnamedDocument(t *testing.T) {
	cases := []struct {
		name            string
		before, now     string
		wantRefusal     bool
		wantMentionsDoc bool
	}{
		{name: "both named and equal", before: "loader-1", now: "loader-1", wantRefusal: false},
		{name: "both named and different", before: "loader-1", now: "loader-2", wantRefusal: true},
		// The case this test exists for: two empty ids used to compare equal.
		{name: "both unnamed", before: "", now: "", wantRefusal: true, wantMentionsDoc: true},
		{name: "unnamed before", before: "", now: "loader-1", wantRefusal: true, wantMentionsDoc: true},
		{name: "unnamed now", before: "loader-1", now: "", wantRefusal: true, wantMentionsDoc: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fb := newFakeBrowser(t)
			const pageURL = "https://example.com/"
			errCh := make(chan error, 1)
			go func() {
				errCh <- fb.client.assertSamePage(pageIdentity{url: pageURL, loaderID: tc.before})
			}()
			cmd := fb.nextCommand()
			if cmd.Method != "Page.getFrameTree" {
				t.Fatalf("expected Page.getFrameTree, got %q", cmd.Method)
			}
			fb.frameTreeReplyFull(cmd.ID, pageURL, tc.now, originOf(pageURL))

			err := <-errCh
			if tc.wantRefusal && err == nil {
				t.Fatal("expected a refusal")
			}
			if !tc.wantRefusal && err != nil {
				t.Fatalf("unexpected refusal: %v", err)
			}
			if tc.wantMentionsDoc && !strings.Contains(err.Error(), "did not name the document") {
				t.Fatalf("the refusal should say the document was unnamed: %v", err)
			}
		})
	}
}

// The page for the integration test below: tall enough to scroll, with a
// button and an input inside the first viewport.
const documentIdentityPage = `<!DOCTYPE html>
<html><head><title>Identity</title></head><body style="margin:0">
  <button id="act" aria-label="act button" style="width:120px;height:30px">Act</button>
  <input id="field" aria-label="the field" type="text" style="width:200px">
  <!-- A fixed banner, which is what a cookie-consent Accept button is: its
       viewport position does NOT change when the window scrolls, so a
       page-wide scroll comparison would refuse a click that is perfectly
       good. -->
  <button id="fixed" aria-label="fixed banner button"
          style="position:fixed;left:10px;bottom:10px;width:140px;height:30px">Accept</button>
  <!-- An element inside its own scroll container, which is what Gmail's
       message list and Linear's issue list are: scrolling it moves every
       element inside without touching window.scrollY at all, so a page-wide
       scroll comparison misses it entirely. -->
  <div id="list" style="height:120px;width:300px;overflow:auto">
    <button id="row" aria-label="row button" style="width:140px;height:30px">Row</button>
    <div style="height:2000px">inner tall</div>
  </div>
  <div style="height:4000px">tall</div>
  <script>window.__clicks = 0;
    for (const id of ['act', 'fixed', 'row']) {
      document.getElementById(id).addEventListener('click', () => { window.__clicks++; });
    }
  </script>
</body></html>`

func TestBrowserDocumentIdentityIntegration(t *testing.T) {
	cfg := &SidecarConfig{}
	if _, err := findChromiumExecutable(cfg); err != nil {
		t.Skipf("no Chromium available: %v", err)
	}
	profileDir, err := os.MkdirTemp("", "jarvis-docid-profile-*")
	if err != nil {
		t.Fatalf("create profile dir: %v", err)
	}
	t.Cleanup(func() {
		for i := 0; i < 20; i++ {
			if os.RemoveAll(profileDir) == nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
	cfg.Browser.ProfileDir = profileDir
	defer closeActiveCDP()

	withHeadless := func(extra map[string]any) map[string]any {
		out := map[string]any{"headless": true}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}

	navigate := makeBrowserNavigateHandler(cfg)
	snapshot := makeBrowserSnapshotHandler(cfg)
	click := makeBrowserClickHandler(cfg)
	typeText := makeBrowserTypeHandler(cfg)
	scroll := makeBrowserScrollHandler(cfg)
	evaluate := makeBrowserEvaluateHandler(cfg)

	// A data: document, like the parity integration test uses. The
	// pushState-still-clicks case is NOT here: a data: document has a null
	// origin and Chrome refuses pushState on it. That case is covered over the
	// fake pipe in browser_element_refs_test.go ("a same-document pushState
	// does NOT refuse") and on the daemon side in
	// src/actions/browser/document-identity.test.ts.
	pageURL := "data:text/html," + url.PathEscape(documentIdentityPage)

	snapOut := callHandler(t, navigate, withHeadless(map[string]any{"url": pageURL}))
	actID := findElementID(t, snapOut, "act button")
	fieldID := findElementID(t, snapOut, "the field")

	clicksNow := func() string {
		return callHandler(t, evaluate, withHeadless(map[string]any{"expression": "String(window.__clicks)"}))
	}

	// ── the ordinary click still works ──
	if out := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(actID)})); !strings.Contains(out, "Clicked") {
		t.Fatalf("an ordinary click was refused: %s", out)
	}
	if got := clicksNow(); got != "1" {
		t.Fatalf("the click did not reach the page: %s", got)
	}

	// ── a SCROLL made by another tool: the coordinates of what MOVED are stale
	// and the click has to refuse ──
	if _, err := evaluate(withHeadless(map[string]any{"expression": "window.scrollBy(0, 500); 'ok'"})); err != nil {
		t.Fatalf("scrollBy: %v", err)
	}
	out := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(actID)}))
	if !strings.Contains(out, "has moved since the snapshot") {
		t.Fatalf("a click after a scroll should refuse, got: %s", out)
	}
	if got := clicksNow(); got != "1" {
		t.Fatalf("the refused click still reached the page: %s", got)
	}

	// ── BUT A FIXED ELEMENT HAS NOT MOVED, and refusing it is the false
	// refusal that made the page-wide scroll comparison the wrong question: a
	// consent banner's Accept button is the single most-clicked thing on the
	// web, and it sits in exactly this position. ──
	fixedID := findElementID(t, snapOut, "fixed banner button")
	if out := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(fixedID)})); !strings.Contains(out, "Clicked") {
		t.Fatalf("a click on a position:fixed element after a window scroll was refused: %s", out)
	}
	if got := clicksNow(); got != "2" {
		t.Fatalf("the fixed-element click did not reach the page: %s", got)
	}

	// ── AND AN INNER SCROLL CONTAINER DOES move its contents, while
	// window.scrollY does not change at all -- the staleness a page-wide
	// comparison misses, and the common one (Gmail's list, Linear's list, a
	// virtualised table, a chat log). ──
	snapOut = callHandler(t, snapshot, withHeadless(nil))
	rowID := findElementID(t, snapOut, "row button")
	scrollYBefore := callHandler(t, evaluate, withHeadless(map[string]any{"expression": "String(Math.round(window.scrollY))"}))
	if _, err := evaluate(withHeadless(map[string]any{
		"expression": "document.getElementById('list').scrollTop = 400; 'ok'",
	})); err != nil {
		t.Fatalf("inner scroll: %v", err)
	}
	if got := callHandler(t, evaluate, withHeadless(map[string]any{"expression": "String(Math.round(window.scrollY))"})); got != scrollYBefore {
		t.Fatalf("the inner scroll moved window.scrollY (%s -> %s); this case no longer tests what it says",
			scrollYBefore, got)
	}
	if out := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(rowID)})); !strings.Contains(out, "has moved since the snapshot") {
		t.Fatalf("a click after an inner-container scroll should refuse, got: %s", out)
	}
	// Typing reaches its element through the ref the snapshot stashed, and
	// typing itself scrolls the caret into view -- so a scroll must not refuse
	// it, or the second type into one field would refuse itself.
	if out := callHandler(t, typeText, withHeadless(map[string]any{
		"element_id": float64(fieldID), "text": "hello",
	})); strings.Contains(out, "scrolled") {
		t.Fatalf("a type after a scroll was refused: %s", out)
	}

	// ── browser_scroll drops the ids itself, and says so ──
	snapOut = callHandler(t, snapshot, withHeadless(nil))
	actID = findElementID(t, snapOut, "act button")
	scrollOut := callHandler(t, scroll, withHeadless(map[string]any{"direction": "down"}))
	if !strings.Contains(scrollOut, "no longer apply") {
		t.Fatalf("browser_scroll should say the ids are gone: %s", scrollOut)
	}
	if out := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(actID)})); !strings.Contains(out, "not found") {
		t.Fatalf("a click after browser_scroll should find no id, got: %s", out)
	}

	// ── document.write replaces the DOM with no loaderId and no URL change ──
	snapOut = callHandler(t, snapshot, withHeadless(nil))
	actID = findElementID(t, snapOut, "act button")
	before, _, err := activeCDPClient().frameTreeState(cdpDefaultTimeout)
	if err != nil {
		t.Fatalf("frame tree before document.write: %v", err)
	}
	if _, err := evaluate(withHeadless(map[string]any{
		"expression": `document.open(); document.write('<html><head><title>Rewritten</title></head><body><button id="act" aria-label="act button" style="width:120px;height:30px">Act</button></body></html>'); document.close(); 'ok'`,
	})); err != nil {
		t.Fatalf("document.write: %v", err)
	}
	after, _, err := activeCDPClient().frameTreeState(cdpDefaultTimeout)
	if err != nil {
		t.Fatalf("frame tree after document.write: %v", err)
	}
	// The measurement this whole term exists for, asserted rather than trusted:
	// if a future Chrome commits a document here, the loaderId check alone would
	// already have caught it and this test should be revisited.
	if after.loaderID != before.loaderID {
		t.Fatalf("document.write changed the loaderId (%q -> %q); the premise of #603 has changed",
			before.loaderID, after.loaderID)
	}
	if after.url != before.url {
		t.Fatalf("document.write changed the frame URL (%q -> %q)", before.url, after.url)
	}
	out = callHandler(t, click, withHeadless(map[string]any{"element_id": float64(actID)}))
	if !strings.Contains(out, "replaced the document") {
		t.Fatalf("a click after document.write should refuse, got: %s", out)
	}
}

// activeCDPClient is the client the handlers are using, for the two readings
// the document.write case asserts.
func activeCDPClient() *cdpClient {
	activeCDP.mu.Lock()
	defer activeCDP.mu.Unlock()
	return activeCDP.client
}
