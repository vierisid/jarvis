package main

// #602 - the accessibility actions had NO guard of any kind: no local-content
// refusal, no document check, and no confirmation that the value they write
// lands in the element the model named. They address elements by
// `backend_node_id`, a different id space from the DOM snapshot's integer ids,
// so #592's isolated-world work did not cover them.
//
// Driven against a real headless Chromium, because the two things worth proving
// here are things a fake cannot produce on demand: a page's own `focus`
// listener moving focus out of the reviewed element while the write is in
// flight, and a page redefining the prototypes the check reads through.
// Skipped when no Chromium is installed, like the parity integration test.

import (
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// axGuardPage: one honest input, one that hands focus to a thief the moment it
// is focused, and a page that has redefined the prototypes a main-world check
// would read through.
const axGuardPage = `<!DOCTYPE html>
<html><head><title>AX Guard</title></head><body>
  <input id="honest" aria-label="honest field" type="text">
  <input id="reviewed" aria-label="reviewed field" type="text">
  <input id="thief" aria-label="thief field" type="text">
  <my-field id="wrapped"></my-field>
  <script>
    // A web component with an open shadow root. The AX tree PIERCES shadow
    // roots where the DOM snapshot's querySelectorAll does not, so this node
    // reaches the AX actions -- and document.activeElement retargets to the
    // host, which is why the focus check asks the node's own root instead
    // (measured; it refused every web-component field before that).
    customElements.define('my-field', class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        const input = document.createElement('input');
        input.setAttribute('aria-label', 'shadow field');
        input.type = 'text';
        root.appendChild(input);
      }
    });
  </script>
  <script>
    // The measured attack from #592, on the AX path: the page cannot stop
    // focus() being called, but it can react to it.
    document.getElementById('reviewed').addEventListener('focus', () => {
      document.getElementById('thief').focus();
    });
    // And a page that lies about the two things the check asks: in the MAIN
    // world only, which is the whole reason the node is resolved into an
    // isolated one.
    Object.defineProperty(Node.prototype, 'isConnected', { get() { return false; }, configurable: true });
    Object.defineProperty(Document.prototype, 'activeElement', { get() { return null; }, configurable: true });
  </script>
</body></html>`

func axFindBackendID(t *testing.T, result any, ariaLabel string) int64 {
	t.Helper()
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("ax snapshot result is %T, want a map", result)
	}
	els, ok := m["elements"].([]map[string]any)
	if !ok {
		t.Fatalf("ax snapshot elements are %T", m["elements"])
	}
	for _, el := range els {
		if name, _ := el["name"].(string); name == ariaLabel {
			id, _ := el["backend_node_id"].(int64)
			if id == 0 {
				t.Fatalf("element %q has no backend node id", ariaLabel)
			}
			return id
		}
	}
	var names []string
	for _, el := range els {
		name, _ := el["name"].(string)
		names = append(names, name)
	}
	t.Fatalf("no AX element named %q; saw %v", ariaLabel, names)
	return 0
}

func TestBrowserAXActionGuardsIntegration(t *testing.T) {
	cfg := &SidecarConfig{}
	if _, err := findChromiumExecutable(cfg); err != nil {
		t.Skipf("no Chromium available: %v", err)
	}
	profileDir, err := os.MkdirTemp("", "jarvis-ax-guard-profile-*")
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
	axSnapshot := makeBrowserAXSnapshotHandler(cfg)
	axClick := makeBrowserAXClickHandler(cfg)
	axSetValue := makeBrowserAXSetValueHandler(cfg)
	evaluate := makeBrowserEvaluateHandler(cfg)

	pageURL := "data:text/html," + url.PathEscape(axGuardPage)
	if _, err := navigate(withHeadless(map[string]any{"url": pageURL})); err != nil {
		t.Fatalf("navigate: %v", err)
	}

	// ── an action before any AX snapshot has named the document ──
	//
	// It used to run: the handler went straight to DOM.resolveNode with an id
	// the model could have taken from anywhere.
	if _, err := axSetValue(withHeadless(map[string]any{
		"backend_node_id": float64(1), "value": "x",
	})); err == nil {
		t.Fatal("set_value ran with no AX snapshot naming the document")
	} else if !strings.Contains(err.Error(), "browser_ax_snapshot") {
		t.Fatalf("unhelpful refusal before any snapshot: %v", err)
	}

	snap, err := axSnapshot(withHeadless(nil))
	if err != nil {
		t.Fatalf("ax snapshot: %v", err)
	}
	honest := axFindBackendID(t, snap.Result, "honest field")
	reviewed := axFindBackendID(t, snap.Result, "reviewed field")

	// ── the honest path still works, against a page that has redefined
	// isConnected and activeElement in its own world ──
	res, err := axSetValue(withHeadless(map[string]any{
		"backend_node_id": float64(honest), "value": "typed by jarvis",
	}))
	if err != nil {
		t.Fatalf("set_value refused an honest field: %v", err)
	}
	readback, _ := res.Result.(map[string]any)["readback"].(map[string]any)
	if got, _ := readback["value"].(string); got != "typed by jarvis" {
		t.Fatalf("readback says %q", got)
	}

	// ── a form control inside an open shadow root ──
	//
	// This is where copying the DOM path's focus check verbatim broke: after
	// `focus()`, `ownerDocument.activeElement` is the shadow HOST, never the
	// input, so the document form of the check refused every web-component
	// field while focus had landed exactly where it should.
	shadow := axFindBackendID(t, snap.Result, "shadow field")
	shadowRes, err := axSetValue(withHeadless(map[string]any{
		"backend_node_id": float64(shadow), "value": "inside the shadow root",
	}))
	if err != nil {
		t.Fatalf("set_value refused a shadow-DOM field: %v", err)
	}
	shadowBack, _ := shadowRes.Result.(map[string]any)["readback"].(map[string]any)
	if got, _ := shadowBack["value"].(string); got != "inside the shadow root" {
		t.Fatalf("shadow-DOM readback says %q", got)
	}

	// ── the focus thief ──
	//
	// The page moves focus to another input the instant the reviewed one is
	// focused. The write must not happen at all: this is #592's measured
	// failure, where the script reported success while the approved text landed
	// in the page's chosen input.
	if _, err := axSetValue(withHeadless(map[string]any{
		"backend_node_id": float64(reviewed), "value": "nobody@example.com",
	})); err == nil {
		t.Fatal("set_value wrote into an element that did not hold focus")
	} else if !strings.Contains(err.Error(), "did not take focus") {
		t.Fatalf("unexpected refusal for the focus thief: %v", err)
	}

	values := callHandler(t, evaluate, withHeadless(map[string]any{
		"expression": `JSON.stringify({reviewed: document.getElementById('reviewed').value, thief: document.getElementById('thief').value})`,
	}))
	if !strings.Contains(values, `"reviewed":""`) || !strings.Contains(values, `"thief":""`) {
		t.Fatalf("the refused write still reached the page: %s", values)
	}

	// ── an id the snapshot did not emit ──
	//
	// Measured: a backendNodeId is renderer-process-local and restarts at 1
	// after a cross-site navigation, so ids from two documents collide and a
	// stale one resolves cleanly to a DIFFERENT element. Membership in the last
	// snapshot's own id set is what makes an id mean what it meant -- and it
	// also keeps the nodes the snapshot filtered out from being actionable.
	unknown := honest
	for _, el := range snap.Result.(map[string]any)["elements"].([]map[string]any) {
		if id, _ := el["backend_node_id"].(int64); id > unknown {
			unknown = id
		}
	}
	if _, err := axSetValue(withHeadless(map[string]any{
		"backend_node_id": float64(unknown + 1000), "value": "x",
	})); err == nil {
		t.Fatal("set_value acted on an id the snapshot never returned")
	} else if !strings.Contains(err.Error(), "not one the last browser_ax_snapshot returned") {
		t.Fatalf("unexpected refusal for an unknown id: %v", err)
	}

	// ── document.write replaces the DOM without changing the loaderId ──
	//
	// Measured (see #603): neither the loaderId nor the URL moves, so the
	// document check cannot see it. The ids are nonetheless stale, and the
	// isConnected term is what refuses them.
	if _, err := evaluate(withHeadless(map[string]any{
		"expression": `document.open(); document.write('<html><body><input id="fresh"></body></html>'); document.close(); 'ok'`,
	})); err != nil {
		t.Fatalf("document.write: %v", err)
	}
	if _, err := axSetValue(withHeadless(map[string]any{
		"backend_node_id": float64(honest), "value": "after the rewrite",
	})); err == nil {
		t.Fatal("set_value wrote into an element from a document that had been replaced")
	}

	// ── a real navigation ──
	if _, err := navigate(withHeadless(map[string]any{
		"url": "data:text/html," + url.PathEscape("<html><title>Other</title><body><button id=b>B</button></body></html>"),
	})); err != nil {
		t.Fatalf("second navigate: %v", err)
	}
	for name, params := range map[string]map[string]any{
		"set_value": {"backend_node_id": float64(honest), "value": "x"},
		"click":     {"backend_node_id": float64(honest)},
	} {
		handler := axSetValue
		if name == "click" {
			handler = axClick
		}
		_, err := handler(withHeadless(params))
		if err == nil {
			t.Fatalf("ax %s acted on an id from a document the browser had left", name)
		}
		if !strings.Contains(err.Error(), "navigated to a new document") {
			t.Fatalf("ax %s gave an unhelpful refusal: %v", name, err)
		}
	}
}

// TestAXSetValueScriptChecksFocusBeforeWriting pins the ORDER of the terms in
// the in-page function, which is what makes it a guard rather than a report:
// the refusal has to come before the value is assigned. Cheap, and it holds
// even where no Chromium is installed to run the integration test above.
func TestAXSetValueScriptChecksFocusBeforeWriting(t *testing.T) {
	detached := strings.Index(axSetValueScript, "'detached'")
	focusCall := strings.Index(axSetValueScript, "this.focus()")
	refusal := strings.Index(axSetValueScript, "'not_focused'")
	write := strings.Index(axSetValueScript, "desc.set.call")
	if detached < 0 || focusCall < 0 || refusal < 0 || write < 0 {
		t.Fatalf("the script is missing one of its terms:\n%s", axSetValueScript)
	}
	// isConnected first (focusing a detached node is a no-op and the write
	// would follow whatever still had focus), then focus, then the activeElement
	// refusal, and only then the write.
	if !(detached < focusCall && focusCall < refusal && refusal < write) {
		t.Fatalf("terms out of order: detached=%d focus=%d refusal=%d write=%d",
			detached, focusCall, refusal, write)
	}
}
