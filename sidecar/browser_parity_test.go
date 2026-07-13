package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

// Integration test: drives the real browser RPC handlers against a headless
// Chromium over the CDP pipe and asserts the LLM-facing strings match the
// daemon's local-browser output format (WEBAPP_TEMPLATES_AUDIT.md, P0
// "sidecar/local browser parity"). Skipped when no Chromium is installed.

const parityTestPage = `<!DOCTYPE html>
<html><head><title>Parity Test</title></head><body>
  <div id="message" role="row" aria-label="message row" style="width:200px;height:40px;background:#eee">A message row</div>
  <button id="reaction" aria-label="Add reaction" style="display:none">Add reaction</button>
  <input id="field" aria-label="field" type="text" value="hello">
  <div id="editor" contenteditable="true" role="textbox" aria-label="editor" style="width:200px;height:40px">first line</div>
  <button id="clickme" aria-label="click target" style="width:100px;height:30px">Click target</button>
  <script>
    window.__events = [];
    document.getElementById('message').addEventListener('mouseenter', () => {
      document.getElementById('reaction').style.display = 'block';
    });
    document.addEventListener('keydown', (e) => {
      window.__events.push('key:' + (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key);
    });
    const btn = document.getElementById('clickme');
    btn.addEventListener('dblclick', () => window.__events.push('dblclick'));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); window.__events.push('contextmenu'); });

    // Same-origin iframe with interactive content (frames[0])
    const f1 = document.createElement('iframe');
    f1.style.cssText = 'width:300px;height:120px;border:0;display:block';
    document.body.appendChild(f1);
    f1.contentDocument.write('<button aria-label="frame button" style="width:120px;height:30px">Frame Button</button><input aria-label="frame input" type="text">');
    f1.contentDocument.close();
    f1.contentDocument.querySelector('button').addEventListener('click', () => parent.__events.push('frame-click'));

    // Tiny clipped iframe hiding a contenteditable — Google Docs pattern (frames[1])
    const f2 = document.createElement('iframe');
    f2.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:0;top:0';
    document.body.appendChild(f2);
    f2.contentDocument.write('<div contenteditable="true" role="textbox" aria-label="docs editor"></div>');
    f2.contentDocument.close();
  </script>
</body></html>`

// findElementID extracts the [id] of the snapshot line matching an aria-label.
func findElementID(t *testing.T, snapshot, ariaLabel string) int {
	t.Helper()
	re := regexp.MustCompile(fmt.Sprintf(`\[(\d+)\][^\n]*aria-label="%s"`, regexp.QuoteMeta(ariaLabel)))
	m := re.FindStringSubmatch(snapshot)
	if m == nil {
		t.Fatalf("element with aria-label=%q not found in snapshot:\n%s", ariaLabel, snapshot)
	}
	var id int
	fmt.Sscanf(m[1], "%d", &id)
	return id
}

func callHandler(t *testing.T, h RPCHandler, params map[string]any) string {
	t.Helper()
	res, err := h(params)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	s, ok := res.Result.(string)
	if !ok {
		t.Fatalf("handler result is %T, want string (parity requires string results): %+v", res.Result, res.Result)
	}
	return s
}

func TestBrowserHandlerParityIntegration(t *testing.T) {
	cfg := &SidecarConfig{}
	if _, err := findChromiumExecutable(cfg); err != nil {
		t.Skipf("no Chromium available: %v", err)
	}
	cfg.Browser.ProfileDir = t.TempDir()

	// All handlers share the process-global activeCDP; launch headless.
	defer closeActiveCDP()
	headless := map[string]any{"headless": true}
	withHeadless := func(extra map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range headless {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}

	navigate := makeBrowserNavigateHandler(cfg)
	snapshot := makeBrowserSnapshotHandler(cfg)
	click := makeBrowserClickHandler(cfg)
	typeText := makeBrowserTypeHandler(cfg)
	hover := makeBrowserHoverHandler(cfg)
	pressKey := makeBrowserPressKeyHandler(cfg)
	scroll := makeBrowserScrollHandler(cfg)
	evaluate := makeBrowserEvaluateHandler(cfg)

	pageURL := "data:text/html," + url.PathEscape(parityTestPage)

	// ── navigate returns the daemon's formatted snapshot text ──
	navOut := callHandler(t, navigate, withHeadless(map[string]any{"url": pageURL}))
	for _, want := range []string{"Page: Parity Test", "--- Page Text ---", "--- Key Elements ---", "--- Interactive Elements"} {
		if !strings.Contains(navOut, want) {
			t.Fatalf("navigate output missing %q:\n%s", want, navOut)
		}
	}
	if !strings.Contains(navOut, "[1]") {
		t.Fatalf("navigate output should use 1-based element ids:\n%s", navOut)
	}
	if strings.Contains(navOut, `aria-label="Add reaction"`) {
		t.Fatalf("hover-hidden element must not be in the pre-hover snapshot:\n%s", navOut)
	}

	// ── hover reveals hover-only elements for the next snapshot ──
	rowID := findElementID(t, navOut, "message row")
	hoverOut := callHandler(t, hover, withHeadless(map[string]any{"element_id": float64(rowID)}))
	if !strings.Contains(hoverOut, fmt.Sprintf("Hovering over element [%d]", rowID)) {
		t.Fatalf("unexpected hover output: %s", hoverOut)
	}
	snapOut := callHandler(t, snapshot, withHeadless(nil))
	reactionID := findElementID(t, snapOut, "Add reaction")
	clickOut := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(reactionID)}))
	if clickOut != fmt.Sprintf("Clicked element [%d]", reactionID) {
		t.Fatalf("unexpected click output: %s", clickOut)
	}

	// ── type: replace by default, append with append=true ──
	snapOut = callHandler(t, snapshot, withHeadless(nil))
	fieldID := findElementID(t, snapOut, "field")
	typeOut := callHandler(t, typeText, withHeadless(map[string]any{"element_id": float64(fieldID), "text": "replaced"}))
	if !strings.Contains(typeOut, fmt.Sprintf(`Typed "replaced" into element [%d]`, fieldID)) {
		t.Fatalf("unexpected type output: %s", typeOut)
	}
	appendOut := callHandler(t, typeText, withHeadless(map[string]any{"element_id": float64(fieldID), "text": " plus appended", "append": true}))
	if !strings.Contains(appendOut, "Appended") {
		t.Fatalf("unexpected append output: %s", appendOut)
	}
	fieldValue := callHandler(t, evaluate, withHeadless(map[string]any{"expression": `document.getElementById("field").value`}))
	if fieldValue != "replaced plus appended" {
		t.Fatalf("field value = %q, want %q", fieldValue, "replaced plus appended")
	}

	// ── append on contenteditable preserves existing content ──
	editorID := findElementID(t, snapOut, "editor")
	callHandler(t, typeText, withHeadless(map[string]any{"element_id": float64(editorID), "text": " second part", "append": true}))
	editorText := callHandler(t, evaluate, withHeadless(map[string]any{"expression": `document.getElementById("editor").innerText`}))
	if editorText != "first line second part" {
		t.Fatalf("editor text = %q, want %q", editorText, "first line second part")
	}

	// ── press_key delivers modified keys as trusted events ──
	pressOut := callHandler(t, pressKey, withHeadless(map[string]any{"key": "Ctrl+K"}))
	if pressOut != "Pressed Ctrl+K" {
		t.Fatalf("unexpected press_key output: %s", pressOut)
	}
	events := callHandler(t, evaluate, withHeadless(map[string]any{"expression": `window.__events.join(",")`}))
	if !strings.Contains(events, "key:Ctrl+k") {
		t.Fatalf("Ctrl+K not seen by the page, events: %s", events)
	}

	// ── right/double click dispatch real events ──
	targetID := findElementID(t, snapOut, "click target")
	dblOut := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(targetID), "double": true}))
	if dblOut != fmt.Sprintf("Double-clicked element [%d]", targetID) {
		t.Fatalf("unexpected double-click output: %s", dblOut)
	}
	rightOut := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(targetID), "button": "right"}))
	if rightOut != fmt.Sprintf("Right-clicked element [%d]", targetID) {
		t.Fatalf("unexpected right-click output: %s", rightOut)
	}
	events = callHandler(t, evaluate, withHeadless(map[string]any{"expression": `window.__events.join(",")`}))
	for _, want := range []string{"dblclick", "contextmenu"} {
		if !strings.Contains(events, want) {
			t.Fatalf("%s not seen by the page, events: %s", want, events)
		}
	}

	// ── iframe traversal: offset click, iframe marker, hidden contenteditable ──
	snapOut = callHandler(t, snapshot, withHeadless(nil))
	if !strings.Contains(snapOut, `iframe="true"`) {
		t.Fatalf("iframe elements missing the iframe marker:\n%s", snapOut)
	}
	frameBtnID := findElementID(t, snapOut, "frame button")
	callHandler(t, click, withHeadless(map[string]any{"element_id": float64(frameBtnID)}))
	events = callHandler(t, evaluate, withHeadless(map[string]any{"expression": `window.__events.join(",")`}))
	if !strings.Contains(events, "frame-click") {
		t.Fatalf("offset click did not reach the button inside the iframe, events: %s", events)
	}

	frameInputID := findElementID(t, snapOut, "frame input")
	callHandler(t, typeText, withHeadless(map[string]any{"element_id": float64(frameInputID), "text": "typed in frame"}))
	frameValue := callHandler(t, evaluate, withHeadless(map[string]any{"expression": `frames[0].document.querySelector("input").value`}))
	if frameValue != "typed in frame" {
		t.Fatalf("frame input value = %q, want %q", frameValue, "typed in frame")
	}

	// Google Docs pattern: contenteditable in a 1x1 clipped iframe must be
	// captured (typing-target exemption) and typable with append semantics.
	docsID := findElementID(t, snapOut, "docs editor")
	callHandler(t, typeText, withHeadless(map[string]any{"element_id": float64(docsID), "text": "Hello Docs"}))
	callHandler(t, typeText, withHeadless(map[string]any{"element_id": float64(docsID), "text": " and more", "append": true}))
	docsText := callHandler(t, evaluate, withHeadless(map[string]any{"expression": `frames[1].document.querySelector("[contenteditable]").innerText`}))
	if docsText != "Hello Docs and more" {
		t.Fatalf("docs editor text = %q, want %q", docsText, "Hello Docs and more")
	}

	// ── scroll reports pixels like the daemon ──
	scrollOut := callHandler(t, scroll, withHeadless(map[string]any{"direction": "down", "amount": float64(250)}))
	if scrollOut != "Scrolled down by 250px" {
		t.Fatalf("unexpected scroll output: %s", scrollOut)
	}

	// ── stale/unknown ids produce the daemon's guidance string ──
	staleOut := callHandler(t, click, withHeadless(map[string]any{"element_id": float64(999)}))
	if staleOut != "Error: Element [999] not found. Run browser_snapshot first." {
		t.Fatalf("unexpected stale-id output: %s", staleOut)
	}
}

func TestFormatBrowserSnapshotShape(t *testing.T) {
	snap := &pageSnapshot{
		Title: "T",
		URL:   "https://example.com",
		Text:  "hello world",
		Elements: []pageElement{
			{ID: 1, Tag: "input", Attrs: map[string]string{"aria-label": "Search", "type": "text"}},
			{ID: 2, Tag: "button", Text: "Send now", Attrs: map[string]string{"aria-label": "Send"}},
			{ID: 3, Tag: "div", Text: "row one", Attrs: map[string]string{"role": "gridcell"}},
		},
	}
	out := formatBrowserSnapshot(snap)

	for _, want := range []string{
		"Page: T",
		"URL: https://example.com",
		"--- Page Text ---",
		"hello world",
		"--- Key Elements ---",
		"[1] INPUT: Search",
		"[2] BUTTON: Send",
		"--- Interactive Elements (3/3) ---",
		`[1] input type="text" aria-label="Search"`,
		`[2] button "Send now" aria-label="Send"`,
		`[3] div "row one" role="gridcell"`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("formatted snapshot missing %q:\n%s", want, out)
		}
	}
}

func TestFormatBrowserSnapshotEmpty(t *testing.T) {
	out := formatBrowserSnapshot(&pageSnapshot{Title: "E", URL: "u"})
	if !strings.Contains(out, "(no interactive elements found)") {
		t.Fatalf("empty snapshot should say no elements:\n%s", out)
	}
}
