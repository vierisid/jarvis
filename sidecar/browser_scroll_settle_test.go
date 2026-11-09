package main

// #1161: a forget racing a smooth scroll left mid-animation coordinates.
//
// forgetSnapshotElements runs as soon as the scroll or the paging key has been
// sent, but Chromium animates both: measured against Chromium 156 (headless
// and headful), window.scrollBy under CSS `scroll-behavior: smooth` moves for
// ~430ms over 600px and ~1200ms over 5000px, and PageDown/End move for
// ~160-170ms with or without that CSS. A snapshot taken after the forget but
// before the motion ends got a fresh generation and coordinates that were still
// moving. DOM.scrollIntoViewIfNeeded (browser_ax_click) measured instant even
// under the smooth CSS, so it needs nothing.

import (
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// The scroll tool asks for an instant scroll, so there is no animation for a
// snapshot to land inside: the page sits at its new position by the time the
// handler returns, however far it scrolled. Driven against a real Chromium,
// because the animation is Chromium's.
func TestBrowserScrollSettlesUnderSmoothCSSIntegration(t *testing.T) {
	cfg := &SidecarConfig{}
	if _, err := findChromiumExecutable(cfg); err != nil {
		t.Skipf("no Chromium available: %v", err)
	}
	profileDir, err := os.MkdirTemp("", "jarvis-scroll-settle-profile-*")
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

	var rows strings.Builder
	for i := 0; i < 400; i++ {
		rows.WriteString(`<div style="height:40px">row</div>`)
	}
	// Counts scroll events: an instant scroll dispatches one, an animated one
	// dispatches one per frame it moves. Asked separately from the position,
	// because the scroll awaits scrollBy's promise, which on Chromium 156
	// resolves only when a smooth scroll ends -- the position alone would pass
	// with the instant form removed, and older builds return no promise.
	page := `<!DOCTYPE html><html style="scroll-behavior:smooth"><head><title>Smooth</title>` +
		`<script>window.__scrolls = 0; addEventListener("scroll", () => window.__scrolls++);</script></head><body>` +
		rows.String() + `</body></html>`
	callHandler(t, makeBrowserNavigateHandler(cfg), map[string]any{"headless": true, "url": "data:text/html," + url.PathEscape(page)})

	// 5000px: ~1200ms of animation when smooth, well past the handler's own
	// 500ms wait, so a smooth scroll is still moving when it returns.
	callHandler(t, makeBrowserScrollHandler(cfg), map[string]any{"headless": true, "direction": "down", "amount": float64(5000)})
	got := callHandler(t, makeBrowserEvaluateHandler(cfg), map[string]any{"headless": true, "expression": "String(window.scrollY)"})
	if got != "5000" {
		t.Fatalf("window.scrollY = %s when the scroll handler returned, want 5000: the scroll was still animating, so a snapshot taken now records coordinates that are about to move", got)
	}
	time.Sleep(300 * time.Millisecond) // let any trailing scroll event land
	if n := callHandler(t, makeBrowserEvaluateHandler(cfg), map[string]any{"headless": true, "expression": "String(window.__scrolls)"}); n != "1" {
		t.Fatalf("the scroll dispatched %s scroll events, want 1: it animated rather than jumping", n)
	}
}

// A paging key cannot be made instant (Chromium animates keyboard scrolling on
// its own), so the handler forgets the map again once its settle wait is over.
// A snapshot some other reader (the pebble) filled while the page was still
// moving is retired with it.
func TestPagingKeyRetiresASnapshotTakenWhileThePageWasMoving(t *testing.T) {
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)

	done := make(chan error, 1)
	go func() {
		_, err := makeBrowserPressKeyHandler(&SidecarConfig{})(map[string]any{"key": "PageDown"})
		done <- err
	}()
	for _, want := range []string{"Input.dispatchKeyEvent", "Input.dispatchKeyEvent"} {
		cmd := fb.nextCommand()
		if cmd.Method != want {
			t.Fatalf("command = %q, want %q", cmd.Method, want)
		}
		fb.reply(cmd.ID)
	}

	// The first forget, right after the key.
	deadline := time.Now().Add(5 * time.Second)
	for elemGenOf(fb.client) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the paging key never forgot the map")
		}
		time.Sleep(time.Millisecond)
	}

	// A snapshot commits during the settle wait, as one taken by another
	// reader mid-animation would: its fill installs coordinates under a fresh
	// generation.
	fb.client.elemMu.Lock()
	fb.client.elemCoords = map[int][2]float64{1: {10, 20}}
	fb.client.elemGen++
	fb.client.elemMu.Unlock()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("press key: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the press key handler never returned")
	}
	if el, ok := fb.client.snapshotElementFor(1); ok {
		t.Fatalf("element 1 is still at (%v, %v): a snapshot taken while the paging key was still scrolling outlived the key", el.x, el.y)
	}
}

// Not every key: Enter must leave a snapshot taken after it alone, or "press
// Enter, then click [5]" breaks (#603).
func TestNonPagingKeyLeavesTheSnapshotAlone(t *testing.T) {
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)
	fb.client.elemMu.Lock()
	fb.client.elemCoords = map[int][2]float64{1: {10, 20}}
	fb.client.elemMu.Unlock()

	done := make(chan error, 1)
	go func() {
		_, err := makeBrowserPressKeyHandler(&SidecarConfig{})(map[string]any{"key": "Enter"})
		done <- err
	}()
	for i := 0; i < 2; i++ {
		fb.reply(fb.nextCommand().ID)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("press key: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the press key handler never returned")
	}
	if _, ok := fb.client.snapshotElementFor(1); !ok {
		t.Fatal("Enter retired the snapshot")
	}
}

// A scroll the page refused is reported as a failure, not as "Scrolled down":
// the reply is checked for an exception, and the promise Chromium 156 returns
// from scrollBy is awaited so a rejection lands there too. The daemon's
// evaluate does both (awaitPromise, exceptionDetails), so the halves agree.
func TestScrollReportsAPageExceptionAsAFailure(t *testing.T) {
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)

	type outcome struct {
		res *RPCResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := makeBrowserScrollHandler(&SidecarConfig{})(map[string]any{"direction": "down", "amount": float64(250)})
		done <- outcome{res, err}
	}()
	cmd := fb.nextCommand()
	if cmd.Method != "Runtime.evaluate" {
		t.Fatalf("command = %q, want Runtime.evaluate", cmd.Method)
	}
	if cmd.Params["awaitPromise"] != true {
		t.Fatalf("the scroll does not await scrollBy's promise, so a rejected scroll reads as done: %+v", cmd.Params)
	}
	fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{
		"result": map[string]any{"type": "object", "subtype": "error"},
		"exceptionDetails": map[string]any{"text": "Uncaught", "exception": map[string]any{
			"description": "TypeError: Failed to execute 'scrollBy' on 'Window'"}},
	}})
	select {
	case got := <-done:
		if got.err == nil {
			t.Fatalf("a scroll that threw was reported as done: %+v", got.res)
		}
		if !strings.Contains(got.err.Error(), "scrollBy") {
			t.Fatalf("error %q does not carry the page's reason", got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the scroll handler never returned")
	}
}

// The second forget after a paging key relies on pressKeySettle outlasting
// Chromium's keyboard scroll animation. Pinned here against a real Chromium: on
// a smooth-CSS page the viewport the handler returns on is the one it stays at.
func TestBrowserPagingKeySettlesIntegration(t *testing.T) {
	cfg := &SidecarConfig{}
	if _, err := findChromiumExecutable(cfg); err != nil {
		t.Skipf("no Chromium available: %v", err)
	}
	profileDir, err := os.MkdirTemp("", "jarvis-paging-settle-profile-*")
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

	var rows strings.Builder
	for i := 0; i < 400; i++ {
		rows.WriteString(`<div style="height:40px">row</div>`)
	}
	page := `<!DOCTYPE html><html style="scroll-behavior:smooth"><head><title>Smooth</title></head><body>` +
		rows.String() + `</body></html>`
	callHandler(t, makeBrowserNavigateHandler(cfg), map[string]any{"headless": true, "url": "data:text/html," + url.PathEscape(page)})

	evaluate := makeBrowserEvaluateHandler(cfg)
	for _, key := range []string{"PageDown", "End", "Home"} {
		callHandler(t, makeBrowserPressKeyHandler(cfg), map[string]any{"headless": true, "key": key})
		atReturn := callHandler(t, evaluate, map[string]any{"headless": true, "expression": "String(window.scrollY)"})
		time.Sleep(time.Second)
		settled := callHandler(t, evaluate, map[string]any{"headless": true, "expression": "String(window.scrollY)"})
		if atReturn != settled {
			t.Fatalf("%s: scrollY was %s when the handler returned and %s a second later: the page was still moving after pressKeySettle, so the second forget ran too early", key, atReturn, settled)
		}
	}
}
