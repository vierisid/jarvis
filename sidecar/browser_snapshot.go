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
// refs stashed on the ISOLATED WORLD's globalThis.__jarvis_elements for
// focus-based typing (#592 -- it was the page's own main world, which the page
// could overwrite), and the same same-origin iframe traversal with coordinates
// offset to top-page space (change both together).
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

  // Assign sequential IDs and store DOM refs for later direct focus.
  //
  // This script runs in an ISOLATED WORLD (#592). It used to run in the page's
  // own main world, where this array was window.__jarvis_elements -- a global
  // the PAGE can write, so a page that overwrote it had approved text typed
  // into an element of its own choosing while the snapshot, the approval card
  // and the narration all still named the reviewed one.
  //
  // The isolation is the contextId on the evaluate, NOT this spelling: inside a
  // world "window" is that world's own global proxy and expandos are
  // per-context. globalThis is here to tell a reader the script is not meant
  // for the page's world.
  globalThis.__jarvis_elements = els.map(e => e._el);
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

	// The element refs go in an ISOLATED WORLD, so the page cannot reach them
	// (#592). Refused rather than degraded when no world can be minted: falling
	// back to a main-world evaluate would put the page-writable global straight
	// back, reachable by any page that can make createIsolatedWorld fail.
	//
	// The frame id comes from the same frame-tree read that produced `checked`,
	// so the world is minted for the document that was just approved.
	contextID, err := cdp.elementWorldContext(checked.frameID, checked.loaderID)
	if err != nil {
		return nil, checked, fmt.Errorf("snapshot failed: %w", err)
	}

	// From here on the world may already hold a fresh set of refs -- the
	// snapshot script's last statement arms it -- so ANY failure below must
	// forget both halves rather than leave the world and the coordinate map
	// describing different readings. Deferred, so a return added later cannot
	// skip it.
	committed := false
	defer func() {
		if !committed {
			cdp.forgetSnapshotElements()
		}
	}()

	result, err := cdp.send("Runtime.evaluate", map[string]any{
		"expression":    browserSnapshotScript,
		"returnByValue": true,
		"awaitPromise":  true,
		"contextId":     contextID,
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

	// Both halves now describe this same reading, so the deferred cleanup above
	// must not undo it.
	committed = true
	return &snap, checked, nil
}

// How long a world mint may hold worldMu. Generous for a browser-side call
// that creates no page state, and far short of cdpDefaultTimeout's 30 seconds,
// which is how long an unbounded mint could block every other element action.
const elementWorldMintTimeout = 5 * time.Second

// elementWorldContext returns the execution context of the isolated world
// holding this document's element refs, minting one if the document has changed
// (#592).
//
// `frameID` is the main frame: the snapshot walks subframes from the top
// document, and DOM access across a same-origin boundary is gated on origin
// rather than on world, so one world in the top frame reaches every element the
// script can collect (measured).
//
// NEVER falls back to the page's main world. Re-adding a main-world read as a
// fallback would put the vulnerability back within reach of any page that can
// make createIsolatedWorld fail, which is the whole reason the snapshot refuses
// rather than degrading.
func (c *cdpClient) elementWorldContext(frameID, loaderID string) (float64, error) {
	c.worldMu.Lock()
	defer c.worldMu.Unlock()
	if c.worldLoaderID == loaderID && c.worldContext != 0 {
		return c.worldContext, nil
	}
	// The lock is held across this round trip on purpose -- two callers minting
	// a world for one document would leak a V8 context, and the map is the
	// thing being serialised -- but it is BOUNDED, so a renderer that stops
	// answering cannot park every other action behind it for the 30 seconds
	// `send` would allow. The daemon's promise-valued cache achieves the same
	// shape without a lock at all.
	raw, err := c.sendOnTimeout(c.sessionID, "Page.createIsolatedWorld", map[string]any{
		"frameId":             frameID,
		"worldName":           "jarvis-elements",
		"grantUniveralAccess": false,
	}, elementWorldMintTimeout)
	if err != nil {
		return 0, fmt.Errorf("could not create the isolated world the element references live in: %w", err)
	}
	var world struct {
		ExecutionContextID float64 `json:"executionContextId"`
	}
	if err := json.Unmarshal(raw, &world); err != nil || world.ExecutionContextID == 0 {
		return 0, fmt.Errorf("the browser did not return an isolated world to hold the element references")
	}
	c.worldLoaderID = loaderID
	c.worldContext = world.ExecutionContextID
	return world.ExecutionContextID, nil
}

// elementWorldFor returns the world a PREVIOUS snapshot minted for this
// document, without minting one. Used by the action paths: an action must not
// be the thing that creates a world, because a world with no snapshot in it
// holds no refs and the mint would only mask a missing snapshot.
func (c *cdpClient) elementWorldFor(loaderID string) (float64, bool) {
	c.worldMu.Lock()
	defer c.worldMu.Unlock()
	if c.worldLoaderID != loaderID || c.worldContext == 0 {
		return 0, false
	}
	return c.worldContext, true
}

// forgetSnapshotElements drops everything the last snapshot left behind: the
// coordinates, the document identity, the frame provenance and the isolated
// world holding the element refs.
//
// It exists because those two halves can otherwise DISAGREE. The snapshot
// script's last statement arms the world with a fresh set of refs, so a
// snapshot that fails AFTER the evaluate -- the same-document re-check
// refusing, a parse error, a refusal on the page's own reported URL -- leaves
// the world describing a reading nothing else knows about, while the
// coordinates and the identity still describe the previous one. The loaderId
// never moved, so every guard passes, and a type would then focus a ref from a
// snapshot the model never saw.
//
// Page-triggerable in the sidecar, deterministically: `assertSamePage` compares
// the URL as well, so a page calling `history.pushState` on a short timer makes
// every snapshot fail between the pre-read and the re-read while each attempt
// re-arms the world.
//
// Called from a deferred cleanup in takePageSnapshot so that EVERY failure path
// clears, including ones added later -- the alternative, clearing at each
// `return`, is one new return away from regressing.
func (c *cdpClient) forgetSnapshotElements() {
	c.elemMu.Lock()
	c.elemCoords = nil
	c.elemFrames = nil
	c.elemIdentity = pageIdentity{}
	c.elemFrameStamp = ""
	c.elemGen++
	c.elemMu.Unlock()

	c.worldMu.Lock()
	c.worldLoaderID = ""
	c.worldContext = 0
	c.worldMu.Unlock()
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

// refuseStaleElement is the guard every ACTION on a snapshot element id runs
// before it dispatches anything (#592).
//
// It answers three questions in one frame-tree read: is that id in the current
// snapshot, is the browser still showing the document it was minted in, and --
// for an id the snapshot took from a same-origin subframe -- has that subframe
// stayed put. It also hands back the isolated world holding the element refs,
// for the caller that focuses through one.
//
// Nothing here was checked before. `elemCoords` was only ever replaced by the
// next snapshot, so a click after a page-initiated navigation dispatched a
// trusted mouse event at the previous document's geometry, and the type path
// focused through a ref in a page-writable global. The read paths have checked
// their document since #526/#579; the ACTION paths did not.
//
// Returns: a model-facing refusal string (the caller returns it as the RPC
// result, the way the "not found" message already is), or an error for a
// transport failure, or the element and its world.
//
// The document comparison is the loaderId ALONE -- see confirmSameDocument for
// why the URL term would refuse an ordinary click on every SPA.
func refuseStaleElement(cdp *cdpClient, id int) (snapshotElement, float64, string, error) {
	el, found := cdp.snapshotElementFor(id)
	if !found {
		return snapshotElement{}, 0, fmt.Sprintf("Error: Element [%d] not found. Run browser_snapshot first.", id), nil
	}
	if el.identity.loaderID == "" {
		return snapshotElement{}, 0, fmt.Sprintf("Error: Element [%d] not found. Run browser_snapshot first.", id), nil
	}
	now, stamp, err := cdp.frameTreeState(cdpDefaultTimeout)
	if err != nil {
		return snapshotElement{}, 0, "", fmt.Errorf("could not confirm which page the browser is showing, so nothing was done: %w", err)
	}
	if err := refuseLocalIdentity(now); err != nil {
		return snapshotElement{}, 0, "", err
	}
	if now.loaderID == "" || now.loaderID != el.identity.loaderID {
		return snapshotElement{}, 0, fmt.Sprintf(
			"Error: The page navigated to a new document, so element [%d] from the previous snapshot no longer exists. "+
				"Run browser_snapshot first.", id), nil
	}
	// The digest is WHOLE-TREE, not per-frame, so an unrelated frame navigating
	// can refuse an in-frame element in a DIFFERENT frame. That is why the
	// message says "a frame in this page" rather than naming the element's own:
	// scoping it per-frame would need the snapshot script to report frame
	// identity, and in-page it has none -- a CDP frameId is not visible to
	// script. Over-refusal on a frame-churning page, never a stale coordinate.
	if el.inFrame && stamp != el.stamp {
		return snapshotElement{}, 0, fmt.Sprintf(
			"Error: Element [%d] came from a frame, and a frame in this page has since navigated, so its "+
				"position can no longer be trusted. Run browser_snapshot first.", id), nil
	}
	// The world a PREVIOUS snapshot minted for this document. Not minted here:
	// an action must not create the world, because a world with no snapshot in
	// it holds no refs and minting one would only mask a missing snapshot.
	ctx, ok := cdp.elementWorldFor(el.identity.loaderID)
	if !ok {
		return snapshotElement{}, 0, fmt.Sprintf(
			"Error: Element [%d] cannot be addressed any more. Run browser_snapshot first.", id), nil
	}
	// LAST, so nothing can land after it: a concurrent snapshot of the SAME
	// document re-mints every coordinate AND re-arms the world, leaving the
	// loaderId untouched -- so the identity check above cannot see it, and
	// without this a click would dispatch at the old coordinate while a type
	// focused the new ref. Each RPC runs on its own goroutine, so this is an
	// ordinary interleaving rather than an exotic one. browser_element_point
	// makes the same check for the same reason.
	if cdp.snapshotGeneration() != el.gen {
		return snapshotElement{}, 0, fmt.Sprintf(
			"Error: A new snapshot replaced element [%d] while this call was starting. "+
				"Run browser_snapshot first.", id), nil
	}
	return el, ctx, "", nil
}

// focusStillOnElement reports whether the element the snapshot called `id`
// holds focus right now, asked in the isolated world (#592).
//
// It resolves the id through the same stored ref the focus used, so it cannot
// become a second opinion about WHICH element -- it asks only about focus.
//
// EXACT equality, and a shadow root that has taken focus is not focus on the
// element: activeElement is the host when focus is inside its shadow tree. Same
// predicate as the focus script, for the same measured reasons.
//
// Fails closed: a read that errors, or a world that has gone, is not focused.
// Keep in step with verifyFocus in src/actions/browser/session.ts.
func (c *cdpClient) focusStillOnElement(id int, contextID float64) bool {
	raw, err := c.send("Runtime.evaluate", map[string]any{
		"contextId":     contextID,
		"returnByValue": true,
		"expression": fmt.Sprintf(`(() => {
        const el = globalThis.__jarvis_elements && globalThis.__jarvis_elements[%d];
        if (!el || !el.isConnected) return 'no';
        const ownerDoc = el.ownerDocument || document;
        if (ownerDoc.activeElement !== el) return 'no';
        if (el.shadowRoot && el.shadowRoot.activeElement) return 'no';
        return 'ok';
      })()`, id-1),
	})
	if err != nil {
		return false
	}
	var parsed struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return false
	}
	return parsed.Result.Value == "ok"
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
	id := pageIdentity{url: f.URL, loaderID: f.LoaderID, origin: f.SecurityOrigin, frameID: f.ID}
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
