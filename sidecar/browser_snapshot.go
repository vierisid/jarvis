package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ── Snapshot parity with the daemon's local browser ──────────────────
//
// This file is a faithful port of the daemon's snapshot pipeline
// (src/actions/browser/session.ts SNAPSHOT_SCRIPT + src/actions/tools/
// builtin.ts formatSnapshot). Webapp templates are written against that
// exact output format and its 1-based element ids; the sidecar must produce
// the same text or every template behaves differently when the browser is
// remote. If you change one side, change the other.

// browserSnapshotScript matches the daemon's SNAPSHOT_SCRIPT: same selector
// list, same visibility filtering, same attributes, 1-based ids, element
// refs stashed on window.__jarvis_elements for focus-based typing, and the
// same same-origin iframe traversal with coordinates offset to top-page
// space (change both together).
const browserSnapshotScript = `(() => {
  const els = [];
  const seen = new WeakSet();
  const sel = [
    'a', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="textbox"]',
    '[role="combobox"]', '[role="menuitem"]', '[role="option"]',
    '[role="row"]', '[role="gridcell"]',
    '[onclick]', '[contenteditable="true"]', '[tabindex="0"]',
    '[data-testid]'
  ].join(', ');

  const frames = [];
  const collectFrames = (doc, ox, oy, depth) => {
    frames.push({ doc, ox, oy });
    if (depth >= 3 || frames.length >= 10) return;
    for (const f of doc.querySelectorAll('iframe, frame')) {
      let child = null;
      try { child = f.contentDocument; } catch { continue; }
      if (!child) continue;
      const r = f.getBoundingClientRect();
      collectFrames(child, ox + r.x, oy + r.y, depth + 1);
    }
  };
  collectFrames(document, 0, 0, 0);

  for (const frame of frames) {
    const doc = frame.doc;
    const win = doc.defaultView || window;
    const inFrame = doc !== document;
    doc.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);

      const rect = el.getBoundingClientRect();
      const isTypingTarget = el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
      const style = win.getComputedStyle(el);
      if (style.display === 'none') return;
      if (!isTypingTarget) {
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.width < 5 || rect.height < 5) return;
        if (style.visibility === 'hidden') return;
        if (style.opacity === '0') return;
      }

      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      const attrs = {};
      for (const a of ['href', 'name', 'placeholder', 'type', 'aria-label', 'title', 'id', 'role', 'data-testid', 'contenteditable']) {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v.slice(0, 200);
      }
      // Live element values (el.value) are deliberately NOT collected.
      // Nothing formats or reads them, and an input's value can be a typed
      // password, so collecting it only creates something to leak later.
      if (inFrame) attrs.iframe = 'true';
      els.push({
        _el: el,
        tag,
        text,
        attrs,
        x: Math.round(frame.ox + rect.x + rect.width / 2),
        y: Math.round(frame.oy + rect.y + rect.height / 2)
      });
    });
  }

  window.__jarvis_elements = els.map(e => e._el);
  els.forEach((el, i) => { el.id = i + 1; delete el._el; });

  let bodyText = (document.body && document.body.innerText) || '';
  for (const frame of frames) {
    if (frame.doc === document) continue;
    const t = frame.doc.body && frame.doc.body.innerText;
    if (t && t.trim()) bodyText += '\n' + t;
  }
  bodyText = bodyText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);

  return JSON.stringify({
    title: document.title,
    url: location.href,
    text: bodyText,
    elements: els
  });
})()`

type pageElement struct {
	ID    int               `json:"id"`
	Tag   string            `json:"tag"`
	Text  string            `json:"text"`
	Attrs map[string]string `json:"attrs"`
	X     float64           `json:"x"`
	Y     float64           `json:"y"`
}

type pageSnapshot struct {
	Title    string        `json:"title"`
	URL      string        `json:"url"`
	Text     string        `json:"text"`
	Elements []pageElement `json:"elements"`
}

// takePageSnapshot runs the snapshot script, stores element coordinates on
// the client (for click/hover by id), and returns the parsed snapshot together
// with the page identity the BROWSER confirmed for it.
//
// The identity is returned, not discarded, because the brain needs it to choose
// a site playbook (#583). It is `checked` -- the frame tree read BEFORE the
// script ran -- and `assertSamePage` below has held the page to it afterwards,
// so its url names the document these bytes came from. The page's own
// `snap.URL` is not that: it is `location.href`, it is rendered into the text
// the model reads, and a page that wants a playbook is exactly the party that
// would lie about which site it is on.
func takePageSnapshot(cdp *cdpClient) (*pageSnapshot, pageIdentity, error) {
	// Before running anything in the page: a page showing local content is not
	// read back to the model (#526, browser_read_guard.go). Every snapshot
	// path goes through here -- browser_snapshot and the one navigate returns.
	//
	// This is assertNotLocalContent spelled out, for ONE extra value off the
	// SAME round trip: the whole frame tree's digest, which #592 needs so that
	// an element taken from a same-origin subframe can later be refused when
	// that subframe navigates itself. Taking it from the pre-read tree rather
	// than a second read is not just cheaper, it fails in the safe direction --
	// a subframe that commits while the script is running leaves the stored
	// digest describing the older tree, so a later click compares unequal and
	// refuses.
	checked, frameStamp, err := cdp.frameTreeState(cdpDefaultTimeout)
	if err != nil {
		return nil, checked, fmt.Errorf("could not check what the page is showing, so refusing to read it: %w", err)
	}
	if err := refuseLocalIdentity(checked); err != nil {
		return nil, checked, err
	}

	// The document has to be NAMED before its script is run, let alone before
	// its coordinates are kept.
	//
	// An unnamed frame tree (an empty loaderId) would fill the map with up to 80
	// coordinates that every reader must then refuse for the life of the
	// snapshot -- while the model can see the snapshot text and reasonably
	// expects its ids to work. That is the worst of both: not fail-closed to the
	// model, and not usable either. One legible failure here instead.
	//
	// Refused BEFORE the evaluate, for the reason this file already gives about
	// local content: there is no point running a page's script and refusing
	// afterwards.
	//
	// It costs nothing legitimate. Even `about:blank` reports a non-empty
	// loaderId once it has committed (measured), so a nameless main frame is
	// genuinely anomalous -- a pre-commit initial document, or a reply
	// json.Unmarshal filled only partly.
	if checked.loaderID == "" {
		return nil, checked, fmt.Errorf("the browser did not name the document it is showing, so refusing to read it")
	}

	result, err := cdp.send("Runtime.evaluate", map[string]any{
		"expression":    browserSnapshotScript,
		"returnByValue": true,
		"awaitPromise":  true,
	})
	if err != nil {
		return nil, checked, fmt.Errorf("snapshot failed: %w", err)
	}

	var wrapper struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(result, &wrapper); err != nil {
		return nil, checked, fmt.Errorf("parse snapshot reply: %w", err)
	}
	if wrapper.ExceptionDetails != nil {
		return nil, checked, fmt.Errorf("snapshot failed: %s", string(wrapper.ExceptionDetails))
	}

	var snap pageSnapshot
	if err := json.Unmarshal([]byte(wrapper.Result.Value), &snap); err != nil {
		return nil, checked, fmt.Errorf("parse snapshot payload: %w", err)
	}

	// Second line behind the frame-tree check above: whatever the page says it
	// is, local content is not formatted and returned. A page can only lie in
	// the safe direction here (it cannot claim to be https while the frame tree
	// says file:, because the frame tree was checked first).
	if err := refuseLocalContent(snap.URL); err != nil {
		return nil, checked, err
	}

	// And the page must still be the document that was approved: the snapshot is
	// a separate round-trip, and another RPC (or a slow navigation) can commit a
	// new document in between.
	if err := cdp.assertSamePage(checked); err != nil {
		return nil, checked, err
	}

	cdp.elemMu.Lock()
	cdp.elemCoords = make(map[int][2]float64, len(snap.Elements))
	cdp.elemFrames = make(map[int]bool, len(snap.Elements))
	for _, el := range snap.Elements {
		cdp.elemCoords[el.ID] = [2]float64{el.X, el.Y}
		if el.Attrs["iframe"] == "true" {
			cdp.elemFrames[el.ID] = true
		}
	}
	cdp.elemIdentity = checked
	cdp.elemFrameStamp = frameStamp
	cdp.elemGen++
	cdp.elemMu.Unlock()

	return &snap, checked, nil
}

// snapshotElement is one id resolved against the live snapshot map, with
// everything a caller needs to prove the answer belongs to the document the
// snapshot described.
type snapshotElement struct {
	x, y     float64
	identity pageIdentity
	gen      uint64
	inFrame  bool
	stamp    string
}

// snapshotElementFor reads one element id out of the map in a single critical
// section, so the coordinate, the document it belongs to and the generation it
// was minted in cannot be torn apart by a concurrent snapshot.
func (c *cdpClient) snapshotElementFor(id int) (snapshotElement, bool) {
	c.elemMu.Lock()
	defer c.elemMu.Unlock()
	coords, ok := c.elemCoords[id]
	if !ok {
		return snapshotElement{}, false
	}
	return snapshotElement{
		x: coords[0], y: coords[1],
		identity: c.elemIdentity,
		gen:      c.elemGen,
		inFrame:  c.elemFrames[id],
		stamp:    c.elemFrameStamp,
	}, true
}

// snapshotGeneration is the generation the map is on right now, for a caller
// that copied a coordinate out, did more work, and has to know the map was not
// refilled underneath it. See the elemGen docblock on cdpClient.
func (c *cdpClient) snapshotGeneration() uint64 {
	c.elemMu.Lock()
	defer c.elemMu.Unlock()
	return c.elemGen
}

// frameTreeState reads the main frame's identity AND the whole-tree digest from
// ONE Page.getFrameTree.
//
// The digest is one string rather than a set, because the only question asked of
// it is "did ANY document in this page change", and a string compares in one
// line at each call site. Frame ids are included so a frame appearing or
// disappearing counts as a change too -- an iframe replaced by a new one with a
// coincidentally equal loaderId is not the same page.
//
// Both halves out of one round trip because the callers need both and the
// budget is tight: a narration's coordinate is raced against 1200 ms upstream
// (src/daemon/index.ts), so a second frame-tree read to learn the same thing
// twice would be a quarter of the budget spent on nothing. It also makes the
// two values provably consistent -- an identity and a digest read a beat apart
// could describe different moments, which is the class of bug this whole
// change is about.
func (c *cdpClient) frameTreeState(timeout time.Duration) (pageIdentity, string, error) {
	raw, err := c.sendOnTimeout(c.sessionID, "Page.getFrameTree", nil, timeout)
	if err != nil {
		return pageIdentity{}, "", err
	}
	var tree struct {
		FrameTree frameTreeNode `json:"frameTree"`
	}
	if err := json.Unmarshal(raw, &tree); err != nil {
		return pageIdentity{}, "", fmt.Errorf("unexpected Page.getFrameTree reply: %w", err)
	}
	f := tree.FrameTree.Frame
	id := pageIdentity{url: f.URL, loaderID: f.LoaderID, origin: f.SecurityOrigin}
	var parts []string
	collectFrameStamp(&tree.FrameTree, &parts)
	sort.Strings(parts)
	return id, strings.Join(parts, "|"), nil
}

type frameTreeNode struct {
	Frame struct {
		ID             string `json:"id"`
		URL            string `json:"url"`
		LoaderID       string `json:"loaderId"`
		SecurityOrigin string `json:"securityOrigin"`
	} `json:"frame"`
	ChildFrames []frameTreeNode `json:"childFrames"`
}

// collectFrameStamp walks the tree depth-first. Bounded by what Chrome sends,
// which is the page's own frame count; the snapshot script itself stops at 10
// frames but this is the browser's tree, not the script's walk.
func collectFrameStamp(node *frameTreeNode, out *[]string) {
	*out = append(*out, node.Frame.ID+":"+node.Frame.LoaderID)
	for i := range node.ChildFrames {
		collectFrameStamp(&node.ChildFrames[i], out)
	}
}

// elementCoords returns the stored viewport center for a snapshot element id.
func (c *cdpClient) elementCoordsFor(id int) ([2]float64, bool) {
	c.elemMu.Lock()
	defer c.elemMu.Unlock()
	coords, ok := c.elemCoords[id]
	return coords, ok
}

// Formatter limits — keep in sync with src/actions/tools/builtin.ts.
const (
	maxPageText = 2000
	maxElements = 80
	maxSameRole = 15
)

// formatBrowserSnapshot is a faithful port of the daemon's formatSnapshot.
func formatBrowserSnapshot(snap *pageSnapshot) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("Page: %s", snap.Title))
	lines = append(lines, fmt.Sprintf("URL: %s", snap.URL))
	lines = append(lines, "")
	lines = append(lines, "--- Page Text ---")
	if len(snap.Text) > maxPageText {
		lines = append(lines, snap.Text[:maxPageText])
		lines = append(lines, fmt.Sprintf("... (%d chars truncated)", len(snap.Text)-maxPageText))
	} else {
		lines = append(lines, snap.Text)
	}
	lines = append(lines, "")

	if len(snap.Elements) == 0 {
		lines = append(lines, "(no interactive elements found)")
		return strings.Join(lines, "\n")
	}

	// Pre-count aria-label frequency to identify repeated vs unique labels
	labelFreq := map[string]int{}
	for _, el := range snap.Elements {
		if label := el.Attrs["aria-label"]; label != "" {
			labelFreq[label]++
		}
	}

	isHighValue := func(el pageElement) bool {
		return el.Tag == "input" || el.Tag == "textarea" || el.Tag == "select" ||
			el.Tag == "button" ||
			el.Attrs["contenteditable"] == "true" || el.Attrs["role"] == "textbox"
	}

	roleCounts := map[string]int{}
	var shown, deferred []pageElement
	for _, el := range snap.Elements {
		role := el.Attrs["role"]
		if role == "" {
			role = el.Tag
		}
		label := el.Attrs["aria-label"]
		hasUniqueLabel := label != "" && labelFreq[label] == 1
		if isHighValue(el) || hasUniqueLabel {
			shown = append(shown, el)
		} else if roleCounts[role] < maxSameRole {
			shown = append(shown, el)
			roleCounts[role]++
		} else {
			deferred = append(deferred, el)
		}
	}

	if budget := maxElements - len(shown); budget > 0 {
		if budget > len(deferred) {
			budget = len(deferred)
		}
		shown = append(shown, deferred[:budget]...)
	}

	sort.Slice(shown, func(i, j int) bool { return shown[i].ID < shown[j].ID })

	// Highlight key interactive elements at the top
	var keyLines []string
	for _, el := range shown {
		if el.Tag == "input" || el.Tag == "textarea" || el.Tag == "select" ||
			el.Attrs["contenteditable"] == "true" || el.Attrs["role"] == "textbox" {
			label := el.Attrs["aria-label"]
			if label == "" {
				label = el.Attrs["placeholder"]
			}
			if label == "" {
				label = el.Attrs["name"]
			}
			if label == "" {
				label = el.Tag
			}
			suffix := ""
			if el.Attrs["contenteditable"] != "" {
				suffix = " (contenteditable)"
			}
			keyLines = append(keyLines, fmt.Sprintf("[%d] INPUT: %s%s", el.ID, label, suffix))
		}
	}
	for _, el := range shown {
		if (el.Tag == "button" || el.Attrs["role"] == "button") && el.Attrs["aria-label"] != "" {
			keyLines = append(keyLines, fmt.Sprintf("[%d] BUTTON: %s", el.ID, el.Attrs["aria-label"]))
		}
	}
	if len(keyLines) > 0 {
		lines = append(lines, "--- Key Elements ---")
		lines = append(lines, keyLines...)
		lines = append(lines, "")
	}

	lines = append(lines, fmt.Sprintf("--- Interactive Elements (%d/%d) ---", len(shown), len(snap.Elements)))
	for _, el := range shown {
		var attrParts []string
		addAttr := func(key, format string) {
			if v := el.Attrs[key]; v != "" {
				attrParts = append(attrParts, fmt.Sprintf(format, v))
			}
		}
		addAttr("name", `name="%s"`)
		addAttr("placeholder", `placeholder="%s"`)
		addAttr("type", `type="%s"`)
		if href := el.Attrs["href"]; href != "" {
			if len(href) > 80 {
				href = href[:80]
			}
			attrParts = append(attrParts, fmt.Sprintf(`href="%s"`, href))
		}
		addAttr("aria-label", `aria-label="%s"`)
		addAttr("role", `role="%s"`)
		addAttr("contenteditable", `contenteditable="%s"`)
		addAttr("data-testid", `data-testid="%s"`)
		addAttr("iframe", `iframe="%s"`)

		textStr := ""
		if el.Text != "" {
			text := el.Text
			if len(text) > 50 {
				text = text[:50]
			}
			textStr = fmt.Sprintf(" %q", text)
		}
		attrStr := ""
		if len(attrParts) > 0 {
			attrStr = " " + strings.Join(attrParts, " ")
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s%s", el.ID, el.Tag, textStr, attrStr))
	}
	if hidden := len(snap.Elements) - len(shown); hidden > 0 {
		lines = append(lines, fmt.Sprintf("(%d repeated list items hidden. All inputs, buttons, and textboxes are shown above.)", hidden))
	}

	return strings.Join(lines, "\n")
}

// takeFormattedSnapshot snapshots the page and returns the LLM-facing text
// together with the browser-confirmed identity of the document it came from.
func takeFormattedSnapshot(cdp *cdpClient) (string, pageIdentity, error) {
	snap, id, err := takePageSnapshot(cdp)
	if err != nil {
		return "", id, err
	}
	return formatBrowserSnapshot(snap), id, nil
}

// ── The browser reply's shape (#583) ─────────────────────────────────
//
// Until #583 both browser read handlers replied with `formatBrowserSnapshot`'s
// text and nothing beside it, so the brain could not tell which page the text
// came from and resolved no site playbook at all for a remote browser. The brain
// may not recover it from the text: the rendering is a page, its first line is
// the page's own `document.title`, and a page printing its own `URL:` line was
// choosing which playbook the model got handed (#572). Nor from the URL the
// brain ASKED for: a redirect makes that false, open redirects are ordinary on
// exactly the hosts templates are written for, and the playbook then announces
// "You are now on <host>" over a page that is not it.
//
// So the confirmed identity travels beside the text, and ONLY when the caller
// asked for it.

// pageReply is the reply shape for a caller that asked for `page_identity`.
//
// `page_url` and `loader_id` are omitted together, never one without the other:
// the daemon accepts a URL only when a loader id came with it, because the loader
// id is what makes the URL name THIS document rather than whichever one the page
// has become since.
type pageReply struct {
	Text     string `json:"text"`
	PageURL  string `json:"page_url,omitempty"`
	LoaderID string `json:"loader_id,omitempty"`
}

// Wire bounds for the identity fields. These are NOT URL policy -- the daemon
// owns that, in `usablePageUrl` (src/actions/tools/webapp-template-injection.ts),
// which caps length, refuses control characters and requires http(s). These exist
// only so THESE FIELDS cannot grow one reply past the brain's 2 MB event cap
// (MAX_JSON_SIZE in src/sidecar/validator.ts). Exceeding it is not an error the
// model sees: the daemon drops the whole event, the RPC never resolves, and the
// page text is lost along with it. A `data:` document's frame-tree URL can be
// megabytes on its own, so an unbounded field here would be the cheapest way to
// deny a read.
//
// It does NOT make the reply as a whole safe, and the comment used to imply that.
// `formatBrowserSnapshot` renders `Page: <document.title>` and `URL:
// <location.href>` with no cap of their own, so a page with a multi-megabyte
// title can still get its own reads dropped. That predates this change, the
// daemon's local `formatSnapshot` has the same shape, and capping it is a
// formatter parity change on both sides rather than part of #583.
//
// Deliberately NOT the daemon's 2048, so nobody reads the two numbers as a
// coupling to keep in step. An over-long URL is omitted rather than truncated --
// a truncated identity is a different page, and a wrong playbook is worse than
// none.
const (
	maxWirePageURL  = 4096
	maxWireLoaderID = 64
)

// wantsPageIdentity reports whether this call asked for the structural reply.
//
// Strict, like `headlessParam`: only a real `true` counts, so a string or a
// number cannot switch the reply shape. An older brain never sends it and gets
// the bare string it has always parsed; that is what makes this additive in both
// directions rather than a flag day.
func wantsPageIdentity(params map[string]any) bool {
	v, _ := params["page_identity"].(bool)
	return v
}

// browserPageResult packages a formatted read for whichever brain asked for it.
//
// The identity is dropped unless the browser actually named the document. An
// empty loaderID is the one asymmetry with the daemon's local path: the daemon
// nulls `browserUrl` unless the loaderId it read is non-empty AND unchanged
// after the read, while `assertSamePage` compares two empty ids as equal and
// would let an unnamed document through. A frame tree can be nameless -- a
// pre-commit initial document, or a reply whose shape `json.Unmarshal` fills
// only partly. Refusing here keeps the guarantee the same on both sides, and
// costs at most one site playbook.
func browserPageResult(formatted string, id pageIdentity, params map[string]any) *RPCResult {
	if !wantsPageIdentity(params) {
		return &RPCResult{Result: formatted}
	}
	reply := pageReply{Text: formatted}
	if id.loaderID != "" && len(id.loaderID) <= maxWireLoaderID && len(id.url) <= maxWirePageURL {
		reply.PageURL = id.url
		reply.LoaderID = id.loaderID
	}
	return &RPCResult{Result: reply}
}
