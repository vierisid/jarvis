package main

import (
	"strings"
	"testing"
	"time"
)

// #592 on the sidecar: the element refs live where the page cannot reach them,
// and typing refuses unless focus is verifiably on the reviewed element.
//
// Over the fake CDP pipe, so the real handler code runs with no Chromium: the
// question here is what the handler SENDS and what it refuses. Whether Chrome
// actually isolates a world, defers a focus event, or honours focus emulation
// is a browser behaviour, and those were measured directly against a real
// Chromium (see the daemon's page-writable-element-refs.test.ts, which drives
// the identical script through the identical sequence).

// typeFixture is a fake browser with one element in the snapshot map and an
// isolated world already minted for its document, as a snapshot would leave it.
func newTypeFixture(t *testing.T) *fakeBrowser {
	t.Helper()
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)
	fb.client.elemCoords = map[int][2]float64{1: {300, 250}}
	fb.client.elemFrames = map[int]bool{}
	fb.client.elemIdentity = pageIdentity{
		url: "https://app.example.com/", loaderID: "L1", origin: "https://app.example.com", frameID: "main",
	}
	fb.client.elemFrameStamp = "main:L1"
	fb.client.elemGen = 3
	fb.client.worldLoaderID = "L1"
	fb.client.worldContext = isolatedWorldContextID
	return fb
}

func callTypeHandler(t *testing.T, params map[string]any) (<-chan *RPCResult, <-chan error) {
	t.Helper()
	res := make(chan *RPCResult, 1)
	errs := make(chan error, 1)
	handler := makeBrowserTypeHandler(guardTestConfig())
	go func() {
		r, err := handler(params)
		if err != nil {
			errs <- err
			return
		}
		res <- r
	}()
	return res, errs
}

func awaitTypeResult(t *testing.T, res <-chan *RPCResult, errs <-chan error) string {
	t.Helper()
	select {
	case r := <-res:
		s, _ := r.Result.(string)
		return s
	case err := <-errs:
		t.Fatalf("the type handler errored: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the type handler never answered")
	}
	return ""
}

// The headline for the sidecar half: the focus script runs in the ISOLATED
// WORLD and reads globalThis, not the page's own window.
func TestBrowserTypeFocusesThroughTheIsolatedWorld(t *testing.T) {
	fb := newTypeFixture(t)
	res, errs := callTypeHandler(t, map[string]any{
		"element_id": float64(1), "text": "approved text",
	})

	// The document guard reads the frame tree first.
	c := fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("first command = %q, want the document guard's Page.getFrameTree", c.Method)
	}
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	// Nothing replaced and nothing scrolled since the snapshot (#603).
	fb.answerDomGeneration("ok")

	// Then the focus script, in the world.
	c = fb.nextCommand()
	if c.Method != "Runtime.evaluate" {
		t.Fatalf("second command = %q, want Runtime.evaluate", c.Method)
	}
	if c.Params["contextId"] == nil {
		t.Fatal("the focus script was evaluated with no contextId, i.e. in the page's own main world")
	}
	expr, _ := c.Params["expression"].(string)
	if !strings.Contains(expr, "globalThis.__jarvis_elements") {
		t.Fatalf("the focus script does not read the isolated world's global: %s", expr)
	}
	// A SPELLING guard, not the boundary. Inside an isolated world `window` IS
	// that world's global proxy and expando properties are per-context, so
	// `window.` would work identically -- the isolation comes entirely from the
	// contextId asserted above. This keeps the rename from being undone by a
	// well-meaning edit, because the name is what tells a reader the script is
	// not meant for the page's world.
	if strings.Contains(expr, "window.__jarvis_elements") {
		t.Fatalf("the focus script names the page's window rather than the world's global: %s", expr)
	}
	// And it verifies where focus landed, in the element's OWN document, by
	// EXACT equality, refusing a shadow tree that took focus and refusing a
	// frame outright.
	for _, want := range []string{
		"isConnected",
		"ownerDoc.activeElement !== el",
		"el.shadowRoot && el.shadowRoot.activeElement",
		"'IFRAME'",
	} {
		if !strings.Contains(expr, want) {
			t.Fatalf("the focus script does not check %q: %s", want, expr)
		}
	}
	// `el.contains(active)` must NOT come back: it let a page redirect the
	// approved text into an input it appended inside the reviewed element
	// (measured), and bought nothing -- activeElement is the focusable element,
	// not the caret's node.
	if strings.Contains(expr, "contains(active)") {
		t.Fatalf("the focus script accepts a descendant as focused, which is the hole: %s", expr)
	}
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "ok"},
	}})

	// The pre-insert re-verify, also in the world.
	c = fb.nextCommand()
	if c.Method != "Runtime.evaluate" || c.Params["contextId"] == nil {
		t.Fatalf("expected the pre-insert focus re-verify in the isolated world, got %q", c.Method)
	}
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "ok"},
	}})

	c = fb.nextCommand()
	if c.Method != "Input.insertText" {
		t.Fatalf("expected Input.insertText once focus was verified, got %q", c.Method)
	}
	fb.reply(c.ID)

	// The post-insert verify: a slip must not be reported as success.
	c = fb.nextCommand()
	if c.Method != "Runtime.evaluate" {
		t.Fatalf("expected the post-insert focus verify, got %q", c.Method)
	}
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "ok"},
	}})

	if got := awaitTypeResult(t, res, errs); !strings.Contains(got, "Typed") {
		t.Fatalf("type result = %q, want it to report success", got)
	}
}

// A page that steals focus from the reviewed element gets NOTHING typed, and no
// input is dispatched at all.
func TestBrowserTypeRefusesWhenTheElementDidNotTakeFocus(t *testing.T) {
	fb := newTypeFixture(t)
	res, errs := callTypeHandler(t, map[string]any{
		"element_id": float64(1), "text": "approved text",
	})

	c := fb.nextCommand()
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	// Nothing replaced and nothing scrolled since the snapshot (#603).
	fb.answerDomGeneration("ok")

	c = fb.nextCommand()
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "not_focused"},
	}})

	got := awaitTypeResult(t, res, errs)
	if !strings.Contains(got, "did not take focus") {
		t.Fatalf("type result = %q, want it to say focus did not land", got)
	}
	// The whole point: no keystrokes, and no coordinate-click fallback either.
	fb.noCommandWithin(300 * time.Millisecond)
}

// A reviewed element the page detached is reported as gone, and nothing is
// typed. Before #592 this succeeded silently and the text followed whatever
// still held focus.
func TestBrowserTypeRefusesADetachedElement(t *testing.T) {
	fb := newTypeFixture(t)
	res, errs := callTypeHandler(t, map[string]any{
		"element_id": float64(1), "text": "approved text",
	})

	c := fb.nextCommand()
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	// Nothing replaced and nothing scrolled since the snapshot (#603).
	fb.answerDomGeneration("ok")

	c = fb.nextCommand()
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "gone"},
	}})

	got := awaitTypeResult(t, res, errs)
	if !strings.Contains(got, "removed from the page") {
		t.Fatalf("type result = %q, want it to say the element is gone", got)
	}
	fb.noCommandWithin(300 * time.Millisecond)
}

// The refs were lost without the document changing: refuse, and do NOT fall
// back to a coordinate click. That fallback's main reachable cause used to be a
// navigation having wiped the page global, which meant clicking and typing
// inside a document nobody reviewed.
func TestBrowserTypeDoesNotFallBackToACoordinateClick(t *testing.T) {
	fb := newTypeFixture(t)
	res, errs := callTypeHandler(t, map[string]any{
		"element_id": float64(1), "text": "approved text",
	})

	c := fb.nextCommand()
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	// Nothing replaced and nothing scrolled since the snapshot (#603).
	fb.answerDomGeneration("ok")

	c = fb.nextCommand()
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "not_found"},
	}})

	got := awaitTypeResult(t, res, errs)
	if !strings.Contains(got, "no longer addressable") {
		t.Fatalf("type result = %q, want a refusal", got)
	}
	// No Input.dispatchMouseEvent, no Input.dispatchKeyEvent, no insertText.
	fb.noCommandWithin(300 * time.Millisecond)
}

// Focus that slips AFTER the insert is reported, never reported as success:
// nothing can un-type the text, so the honest answer is that it may have gone
// elsewhere.
func TestBrowserTypeReportsFocusLostDuringTheInsert(t *testing.T) {
	fb := newTypeFixture(t)
	res, errs := callTypeHandler(t, map[string]any{
		"element_id": float64(1), "text": "approved text",
	})

	c := fb.nextCommand()
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	// Nothing replaced and nothing scrolled since the snapshot (#603).
	fb.answerDomGeneration("ok")
	c = fb.nextCommand()
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "ok"},
	}})
	c = fb.nextCommand() // pre-insert verify
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "ok"},
	}})
	c = fb.nextCommand() // the insert
	fb.reply(c.ID)
	c = fb.nextCommand() // post-insert verify: focus moved
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "no"},
	}})

	got := awaitTypeResult(t, res, errs)
	if !strings.Contains(got, "may have gone to another element") {
		t.Fatalf("type result = %q, want it to admit the text may have gone elsewhere", got)
	}
}

// The pre-insert re-verify is the layer that refuses BEFORE a keystroke is
// sent. Without a test, deleting it left the whole suite green.
func TestBrowserTypeRefusesWhenFocusIsLostBeforeTheInsert(t *testing.T) {
	fb := newTypeFixture(t)
	res, errs := callTypeHandler(t, map[string]any{
		"element_id": float64(1), "text": "approved text",
	})

	c := fb.nextCommand()
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	// Nothing replaced and nothing scrolled since the snapshot (#603).
	fb.answerDomGeneration("ok")

	// The focus script is happy...
	c = fb.nextCommand()
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "ok"},
	}})
	// ...and focus has moved by the time the insert is about to go out. This is
	// the real shape of the measured attack: Chromium defers the page's focus
	// event, so the steal lands after the focus script returned.
	c = fb.nextCommand()
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string", "value": "no"},
	}})

	got := awaitTypeResult(t, res, errs)
	if !strings.Contains(got, "lost focus before anything was typed") {
		t.Fatalf("type result = %q, want the pre-insert refusal", got)
	}
	// The point of refusing HERE rather than after: no keystrokes were sent.
	fb.noCommandWithin(300 * time.Millisecond)
}

// An element taken from a subframe is refused when a frame in the page has
// navigated. Nothing covered this, so disabling the check left the suite green.
func TestBrowserActionsRefuseAnInFrameElementAfterAFrameNavigates(t *testing.T) {
	for _, name := range []string{"click", "type", "hover"} {
		t.Run(name, func(t *testing.T) {
			fb := newTypeFixture(t)
			// Element 2 is the one the snapshot took from the subframe.
			fb.client.elemCoords[2] = [2]float64{40, 60}
			fb.client.elemFrames[2] = true
			fb.client.elemFrameStamp = "child:C1|main:L1"
			fb.client.elemIdentity.frameID = "main"

			res := make(chan *RPCResult, 1)
			errs := make(chan error, 1)
			go func() {
				var (
					r   *RPCResult
					err error
				)
				switch name {
				case "click":
					r, err = makeBrowserClickHandler(guardTestConfig())(map[string]any{"element_id": float64(2)})
				case "type":
					r, err = makeBrowserTypeHandler(guardTestConfig())(map[string]any{"element_id": float64(2), "text": "x"})
				default:
					r, err = makeBrowserHoverHandler(guardTestConfig())(map[string]any{"element_id": float64(2)})
				}
				if err != nil {
					errs <- err
					return
				}
				res <- r
			}()

			c := fb.nextCommand()
			// The MAIN document is unchanged; a child has committed a new one.
			fb.write(map[string]any{
				"id": c.ID,
				"result": map[string]any{"frameTree": map[string]any{
					"frame": map[string]any{
						"id": "main", "url": "https://app.example.com/",
						"loaderId": "L1", "securityOrigin": "https://app.example.com",
					},
					"childFrames": []any{map[string]any{"frame": map[string]any{
						"id": "child", "url": "https://app.example.com/inner",
						"loaderId": "C2-NEW", "securityOrigin": "https://app.example.com",
					}}},
				}},
			})

			got := awaitTypeResult(t, res, errs)
			if !strings.Contains(got, "a frame in this page has since navigated") {
				t.Fatalf("%s result = %q, want the in-frame refusal", name, got)
			}
			fb.noCommandWithin(300 * time.Millisecond)
		})
	}
}

// ...and a main-document element is NOT refused by the same frame churn: an
// unrelated advertising iframe reloading must not stop the page being driven.
func TestBrowserClickStillWorksForAMainDocumentElementWhenAFrameNavigates(t *testing.T) {
	fb := newTypeFixture(t)
	fb.client.elemFrameStamp = "child:C1|main:L1"

	res := make(chan *RPCResult, 1)
	errs := make(chan error, 1)
	go func() {
		r, err := makeBrowserClickHandler(guardTestConfig())(map[string]any{"element_id": float64(1)})
		if err != nil {
			errs <- err
			return
		}
		res <- r
	}()

	c := fb.nextCommand()
	fb.write(map[string]any{
		"id": c.ID,
		"result": map[string]any{"frameTree": map[string]any{
			"frame": map[string]any{
				"id": "main", "url": "https://app.example.com/",
				"loaderId": "L1", "securityOrigin": "https://app.example.com",
			},
			"childFrames": []any{map[string]any{"frame": map[string]any{
				"id": "child", "url": "https://ads.example/", "loaderId": "C2-NEW", "securityOrigin": "https://ads.example",
			}}},
		}},
	})
	// The sentinel answers per ELEMENT (#603): a frame rewriting itself leaves
	// an element outside it alone, so a main-document id is unaffected.
	// Scoping it any coarser would hand any page with an iframe a way to deny
	// every click.
	fb.answerDomGeneration("ok")

	for i := 0; i < 3; i++ {
		c = fb.nextCommand()
		if c.Method != "Input.dispatchMouseEvent" {
			t.Fatalf("command %d = %q, want the click to proceed", i, c.Method)
		}
		fb.reply(c.ID)
	}
	if got := awaitTypeResult(t, res, errs); !strings.Contains(got, "Clicked") {
		t.Fatalf("click result = %q, want success", got)
	}
}

// A snapshot that fails AFTER its script ran must not leave the isolated world
// holding refs the coordinate map knows nothing about: the loaderId never
// moved, so every other guard would pass and a type would focus a ref from a
// reading the model never saw.
func TestAFailedSnapshotForgetsTheWorldItAlreadyArmed(t *testing.T) {
	fb := newFakeBrowser(t)
	fb.client.elemCoords = map[int][2]float64{1: {300, 250}}
	fb.client.elemFrames = map[int]bool{}
	fb.client.elemIdentity = pageIdentity{
		url: "https://app.example.com/", loaderID: "L1", origin: "https://app.example.com", frameID: "main",
	}
	fb.client.elemFrameStamp = "main:L1"
	fb.client.elemGen = 3
	fb.client.worldLoaderID = "L1"
	fb.client.worldContext = isolatedWorldContextID

	done := make(chan error, 1)
	go func() {
		_, _, err := takePageSnapshot(fb.client)
		done <- err
	}()

	c := fb.nextCommand()
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	// No Page.createIsolatedWorld here: a world is already cached for this
	// document, which is the situation that makes this bug reachable -- the
	// snapshot re-arms the refs inside a world that survives its failure.
	c = fb.nextCommand() // the script; it has already armed the world by now
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"type": "string",
			"value": `{"title":"x","url":"https://app.example.com/","text":"hi","elements":[]}`},
	}})
	// The re-check refuses: the page moved while it was being read.
	c = fb.nextCommand()
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/moved", "L1", "https://app.example.com")

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the snapshot was returned despite the page moving under it")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("takePageSnapshot never returned")
	}

	if _, ok := fb.client.snapshotElementFor(1); ok {
		t.Fatal("a failed snapshot left its coordinates behind")
	}
	if _, ok := fb.client.elementWorldFor("L1"); ok {
		t.Fatal("a failed snapshot left the isolated world armed, so a type would focus " +
			"a ref from a reading nothing else knows about")
	}
}

// Every action on a snapshot element refuses once the document has changed --
// click, type and hover alike, and none of them dispatches anything.
func TestBrowserActionsRefuseAfterTheDocumentChanged(t *testing.T) {
	for _, tc := range []struct {
		name  string
		start func(t *testing.T) (<-chan *RPCResult, <-chan error)
	}{
		{"click", func(t *testing.T) (<-chan *RPCResult, <-chan error) {
			res := make(chan *RPCResult, 1)
			errs := make(chan error, 1)
			h := makeBrowserClickHandler(guardTestConfig())
			go func() {
				r, err := h(map[string]any{"element_id": float64(1)})
				if err != nil {
					errs <- err
					return
				}
				res <- r
			}()
			return res, errs
		}},
		{"type", func(t *testing.T) (<-chan *RPCResult, <-chan error) {
			return callTypeHandler(t, map[string]any{"element_id": float64(1), "text": "x"})
		}},
		{"hover", func(t *testing.T) (<-chan *RPCResult, <-chan error) {
			res := make(chan *RPCResult, 1)
			errs := make(chan error, 1)
			h := makeBrowserHoverHandler(guardTestConfig())
			go func() {
				r, err := h(map[string]any{"element_id": float64(1)})
				if err != nil {
					errs <- err
					return
				}
				res <- r
			}()
			return res, errs
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fb := newTypeFixture(t)
			res, errs := tc.start(t)

			c := fb.nextCommand()
			if c.Method != "Page.getFrameTree" {
				t.Fatalf("%s's first command = %q, want the document guard", tc.name, c.Method)
			}
			// Same URL, NEW document: only the loaderId gives it away.
			fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L2", "https://app.example.com")

			got := awaitTypeResult(t, res, errs)
			if !strings.Contains(got, "navigated to a new document") {
				t.Fatalf("%s result = %q, want a refusal naming the navigation", tc.name, got)
			}
			// Nothing was dispatched into the new document.
			fb.noCommandWithin(300 * time.Millisecond)
		})
	}
}

// ...and a same-document pushState does NOT refuse. The guard compares the
// loaderId alone on purpose: pushState rewrites frameTree.frame.url while the
// loaderId holds, and that is how every SPA navigates.
func TestBrowserClickStillWorksAfterASameDocumentUrlChange(t *testing.T) {
	fb := newTypeFixture(t)
	res := make(chan *RPCResult, 1)
	errs := make(chan error, 1)
	h := makeBrowserClickHandler(guardTestConfig())
	go func() {
		r, err := h(map[string]any{"element_id": float64(1)})
		if err != nil {
			errs <- err
			return
		}
		res <- r
	}()

	c := fb.nextCommand()
	// A DIFFERENT url, the SAME loaderId -- history.pushState.
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/spa/view/2", "L1", "https://app.example.com")
	// The DOM is untouched and nothing scrolled: a pushState changes neither.
	fb.answerDomGeneration("ok")

	// The click proceeds: three mouse events at the stored coordinates.
	for i := 0; i < 3; i++ {
		c = fb.nextCommand()
		if c.Method != "Input.dispatchMouseEvent" {
			t.Fatalf("command %d = %q, want Input.dispatchMouseEvent", i, c.Method)
		}
		if c.Params["x"] != 300.0 || c.Params["y"] != 250.0 {
			t.Fatalf("click dispatched at (%v,%v), want the snapshot's (300,250)", c.Params["x"], c.Params["y"])
		}
		fb.reply(c.ID)
	}

	if got := awaitTypeResult(t, res, errs); !strings.Contains(got, "Clicked") {
		t.Fatalf("click result = %q, want success after a pushState", got)
	}
}
