package main

// browser_ax.go — CDP accessibility-tree surface provider (Phase 1 browser
// spike). Unlike the querySelectorAll-index snapshot in browser.go, this
// reads Chrome's own accessibility tree (ARIA + HTML semantics) and
// addresses elements by CDP backendDOMNodeId plus a durable SemanticRef
// (path/ordinal/sig), so actions cannot silently hit a different element
// after the DOM shifts, and stored refs survive relayouts.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// axValue is CDP's { value: ... } wrapper used across AXNode fields.
type axValue struct {
	Value json.RawMessage `json:"value"`
}

func (v *axValue) str() string {
	if v == nil || v.Value == nil {
		return ""
	}
	var s string
	if json.Unmarshal(v.Value, &s) == nil {
		return s
	}
	return string(v.Value)
}

type axNode struct {
	NodeID           string   `json:"nodeId"`
	Ignored          bool     `json:"ignored"`
	Role             *axValue `json:"role"`
	Name             *axValue `json:"name"`
	Value            *axValue `json:"value"`
	BackendDOMNodeID int64    `json:"backendDOMNodeId"`
	ParentID         string   `json:"parentId"`
	ChildIDs         []string `json:"childIds"`
	Properties       []axProp `json:"properties"`
}

type axProp struct {
	Name  string   `json:"name"`
	Value *axValue `json:"value"`
}

// axInteractiveRoles are roles that are worth emitting even without a name,
// and that carry actions.
var axInteractiveRoles = map[string]bool{
	"button": true, "link": true, "textbox": true, "searchbox": true,
	"checkbox": true, "radio": true, "combobox": true, "listbox": true,
	"menuitem": true, "menuitemcheckbox": true, "menuitemradio": true,
	"tab": true, "switch": true, "slider": true, "spinbutton": true,
	"option": true, "textfield": true, "MenuListOption": true,
}

// axIgnoredRoles are wrapper roles that carry no semantics of their own. They
// are skipped when building an ancestry path, so a path reads as meaningful
// containers rather than a chain of anonymous divs. A node with one of these
// roles is still emitted if it has an accessible name -- named text is
// context the model needs.
var axIgnoredRoles = map[string]bool{
	"none": true, "generic": true, "InlineTextBox": true, "LineBreak": true,
}

const axMaxElements = 300
const axMaxPathDepth = 6

// Page-controlled bounds on one AX reply (#597). See buildAXElements' tail for
// why a per-value cap alone was not a bound, and the use site for axMaxValue.
//
// axReplyBudget is the MEASURED JSON size of the emitted element list -- see
// axElementCost, which marshals rather than estimating. 900 KB of elements
// leaves the rest of the reply a wide margin under the brain's 2 MB cap
// (MAX_JSON_SIZE), and is reached only by a page with thousands of controls,
// where the alternative is the whole reply being dropped.
const (
	axMaxValue    = 1000
	axReplyBudget = 900000
)

// makeBrowserAXSnapshotHandler returns the accessibility-tree snapshot:
// a filtered, interactable-first element list with durable refs.
func makeBrowserAXSnapshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		// Same rule as the DOM snapshot: a file: page is not read back to the
		// model (#526). The daemon has no accessibility-tree handler to mirror,
		// but this reads the same document by another route -- and an accessible
		// name IS the document's text, so it gets both of the DOM snapshot's
		// checks, not just the frame-tree one.
		checked, err := cdp.assertNotLocalContent()
		if err != nil {
			return nil, err
		}

		raw, err := cdp.send("Accessibility.getFullAXTree", nil)
		if err != nil {
			return nil, fmt.Errorf("getFullAXTree failed: %w", err)
		}
		var tree struct {
			Nodes []axNode `json:"nodes"`
		}
		if err := json.Unmarshal(raw, &tree); err != nil {
			return nil, fmt.Errorf("parse AX tree: %w", err)
		}

		pageInfo, err := cdp.evalJSON(`JSON.stringify({url: location.href, title: document.title})`)
		if err != nil {
			// Reporting elements without saying which page they came from
			// invites the agent to act on the wrong document.
			return nil, fmt.Errorf("could not read page url/title: %w", err)
		}

		// The page's own view of where it is, checked before anything is
		// formatted -- the second line takePageSnapshot has. The url below is
		// this same string, so it is also what the model is told it read.
		reportedURL, _ := pageInfo["url"].(string)
		if err := refuseLocalContent(reportedURL); err != nil {
			return nil, err
		}
		if err := cdp.assertSamePage(checked); err != nil {
			return nil, err
		}

		elements := buildAXElements(tree.Nodes)

		// WHICH DOCUMENT these ids belong to, so the two AX actions can refuse
		// an id from a document the browser has since left (#602). Recorded
		// after `assertSamePage` above, so it is a document the browser
		// confirmed for this read.
		cdp.rememberAXDocument(checked, elements)

		// `url` here is the PAGE'S CLAIM (`location.href`), not the browser's
		// answer, and it is NOT eligible to select a site playbook -- that is
		// `page_url` on the snapshot reply, which comes from the frame tree
		// (#583, browser_snapshot.go). Two object-shaped browser replies now
		// carry a URL-ish field, and a daemon-side decoder that keys on "a url
		// in an object reply" instead of on `page_url` plus a non-empty
		// `loader_id` would hand a page its own choice of playbook again (#572).
		// `checked.url` is in scope here if this path ever needs the real thing.
		// Both fields are bounded, for the reason the DOM snapshot's `Page:` and
		// `URL:` lines are (#597): they are `document.title` and
		// `location.href`, a page chooses them, and an uncapped one pushes this
		// whole reply past the brain's 2 MB cap -- at which point the AX read is
		// dropped silently and the model gets no elements and no reason.
		//
		// NOT a plain truncation, because these two are COMPARED and not only
		// displayed: `ui_act` refuses to act when the surface it re-reads has a
		// different url or title than the one that was reviewed
		// (src/actions/tools/ui.ts). Two cut values compare EQUAL as soon as
		// their first 4096 characters agree, so a plain cut would have switched
		// that guard off for any page willing to pad its URL. That is #594's
		// mistake inverted: truncate what is RENDERED, never what is BRANCHED
		// ON. See axIdentityField.
		//
		// CORRECTION, #640: this comment used to add "and on this path that
		// comparison is the only document check there is -- browser_ax_click
		// and browser_ax_set_value have no frame-tree check of their own". That
		// was never true of the tree it shipped in: #637 added
		// `refuseStaleAXElement`, which both AX actions run, in the SAME commit
		// as this sentence. The bound still stands on its own -- `ui_act` does
		// compare these two, so they are branched on -- but it is one layer, not
		// the only one.
		axURL, _ := pageInfo["url"].(string)
		axTitle, _ := pageInfo["title"].(string)
		return &RPCResult{Result: map[string]any{
			"provider": "cdp",
			"url":      axIdentityField(axURL, maxRenderedURL),
			"title":    axIdentityField(axTitle, maxRenderedTitle),
			// THE DOCUMENT, so the daemon can compare the one thing that
			// actually identifies it (#640).
			//
			// `ui_act`'s surface check compared `url` and `title` -- the two
			// fields above, which are `location.href` and `document.title`, i.e.
			// the page's own claims -- because they were the only identity on
			// this reply. `history.pushState` moves both while the document
			// holds, and that is how every SPA navigates, so a Gmail or Linear
			// click reviewed one moment was refused the next for a surface that
			// had not changed. #603 settled the rule for every other path:
			// compare the loaderId, never the URL (`confirmSameDocument`,
			// `refuseStaleAXElement` above). This field is what lets this path
			// follow it.
			//
			// The BROWSER's answer, not the page's: `checked` comes from
			// `assertNotLocalContent`/`assertSamePage`, which read the frame
			// tree, so a page cannot choose it -- unlike `url` and `title`.
			// Unbounded here for the same reason it needs no `axIdentityField`:
			// Chrome's loaderId is a short hex string from the protocol and not
			// page-authored. The daemon bounds it anyway on arrival
			// (`MAX_LOADER_ID_LENGTH`, sidecar-route.ts), which is the standing
			// rule for a field off the wire.
			//
			// An older sidecar sends no `loader_id` and the daemon keeps the
			// url+title comparison for it, so this widens the wire without a
			// version gate: a missing field degrades to the previous, stricter,
			// SPA-refusing behaviour rather than to no check.
			"loader_id":     checked.loaderID,
			"element_count": len(elements),
			"elements":      elements,
			"captured_at":   time.Now().UnixMilli(),
		}}, nil
	}
}

// rememberAXDocument records which document the AX ids just handed out belong
// to, WHICH ids they were, and the generation of this fill (#602). Called after
// the snapshot's own `assertSamePage`, so it stores a document the browser
// confirmed rather than one it was showing at some point during the read.
func (c *cdpClient) rememberAXDocument(id pageIdentity, elements []map[string]any) {
	ids := make(map[int64]bool, len(elements))
	for _, el := range elements {
		if backendID, ok := el["backend_node_id"].(int64); ok && backendID != 0 {
			ids[backendID] = true
		}
	}
	c.axMu.Lock()
	c.axIdentity = id
	c.axIDs = ids
	c.axGen++
	c.axMu.Unlock()
}

// refuseStaleAXElement is the guard both AX ACTIONS run before they touch
// anything (#602).
//
// `browser_ax_click` and `browser_ax_set_value` had no guard of any kind: no
// local-content refusal, no document check, nothing. They address elements by
// `backend_node_id`, a different id space from the DOM snapshot's integer ids,
// so #592's isolated-world work did not cover them -- the model could name an
// id from a snapshot of one document and have it acted on in another.
//
// Four questions, one frame-tree read:
//   - was this id EMITTED by the last AX snapshot. Measured: a backendNodeId is
//     renderer-process-local and restarts at 1 after a cross-site navigation,
//     so ids from two documents collide and a stale one resolves cleanly to a
//     different element. Membership is what makes an id mean what it meant, and
//     it also stops an id the snapshot filtered out -- or dropped at the reply
//     budget -- being actionable: the model never saw it and the card never
//     named it;
//   - has an AX snapshot named a document at all;
//   - is the browser still showing that document (the loaderId ALONE, never
//     with the URL: `history.pushState` moves the URL on every SPA without
//     committing a document, and comparing it would refuse an ordinary click on
//     Gmail -- see confirmSameDocument);
//   - is that document one we may drive at all (#526).
//
// No in-frame digest term, unlike the DOM path, and that absence is measured
// rather than assumed: `Accessibility.getFullAXTree` exposes no same-origin
// SUBFRAME nodes, so every id this path can be given is a main-frame id and a
// subframe digest would have nothing to guard.
//
// Errors rather than model-facing result strings, which is this file's existing
// convention for every AX failure -- unlike the DOM path's refuseStaleElement,
// whose "not found" message shape predates it.
//
// It returns the identity it just read, INCLUDING the frame id, so a caller
// that then needs an isolated world mints it for the document that was checked
// rather than reading the frame tree a second time and racing itself.
func refuseStaleAXElement(cdp *cdpClient, backendID int64) (pageIdentity, error) {
	cdp.axMu.Lock()
	before := cdp.axIdentity
	known := cdp.axIDs[backendID]
	gen := cdp.axGen
	cdp.axMu.Unlock()

	if before.loaderID == "" {
		return pageIdentity{}, fmt.Errorf("element %d cannot be addressed: no accessibility snapshot has named "+
			"this page. Take a browser_ax_snapshot first", backendID)
	}
	if !known {
		return pageIdentity{}, fmt.Errorf("element %d is not one the last browser_ax_snapshot returned, so it "+
			"cannot be acted on; take a fresh browser_ax_snapshot and use an id from it", backendID)
	}
	now, _, err := cdp.frameTreeState(cdpDefaultTimeout)
	if err != nil {
		return pageIdentity{}, fmt.Errorf("could not confirm which page the browser is showing, so nothing was done: %w", err)
	}
	if err := refuseLocalIdentity(now); err != nil {
		return pageIdentity{}, err
	}
	if now.loaderID == "" || now.loaderID != before.loaderID {
		return pageIdentity{}, fmt.Errorf("the page navigated to a new document, so element %d from the previous "+
			"accessibility snapshot no longer exists; take a fresh browser_ax_snapshot", backendID)
	}
	// LAST, so nothing can land after it: a concurrent AX snapshot replaces the
	// id set while this call is starting, and the identity check above cannot
	// see that when the document has not changed. The DOM path's generation
	// check exists for the same window and sits in the same place.
	cdp.axMu.Lock()
	moved := cdp.axGen != gen
	cdp.axMu.Unlock()
	if moved {
		return pageIdentity{}, fmt.Errorf("a new accessibility snapshot replaced element %d while this call was "+
			"starting; take a fresh browser_ax_snapshot", backendID)
	}
	return now, nil
}

// axWorldContext is the isolated world the AX path resolves nodes into, minted
// once per document (#602). The snapshot's world is deliberately not reused --
// see the axWorldLoader field.
func (c *cdpClient) axWorldContext(frameID, loaderID string) (float64, error) {
	c.axWorldMu.Lock()
	defer c.axWorldMu.Unlock()
	if c.axWorldLoader == loaderID && c.axWorldCtx != 0 {
		return c.axWorldCtx, nil
	}
	raw, err := c.sendOnTimeout(c.sessionID, "Page.createIsolatedWorld", map[string]any{
		"frameId":             frameID,
		"worldName":           "jarvis-ax",
		"grantUniveralAccess": false,
	}, elementWorldMintTimeout)
	if err != nil {
		return 0, fmt.Errorf("could not create the isolated world this element is addressed in: %w", err)
	}
	var world struct {
		ExecutionContextID float64 `json:"executionContextId"`
	}
	if err := json.Unmarshal(raw, &world); err != nil || world.ExecutionContextID == 0 {
		return 0, fmt.Errorf("the browser did not return an isolated world for this element")
	}
	c.axWorldLoader = loaderID
	c.axWorldCtx = world.ExecutionContextID
	return world.ExecutionContextID, nil
}

// forgetAXWorld drops the cached world so the next call mints a fresh one.
//
// The DOM twin needs no such method: `forgetSnapshotElements` clears it on
// every snapshot failure, and a snapshot is required before every DOM action,
// so a dead context self-heals. Nothing requires an AX snapshot before an AX
// action, so without this a world destroyed while its loaderId held -- a
// session re-attach, a `Runtime.disable` -- would leave set_value failing on
// that document until a navigation.
func (c *cdpClient) forgetAXWorld() {
	c.axWorldMu.Lock()
	c.axWorldLoader = ""
	c.axWorldCtx = 0
	c.axWorldMu.Unlock()
}

// axIdentityField bounds a page-controlled value that a CALLER COMPARES.
//
// Under the cap it is the value, byte for byte. Over it, the cut carries a
// digest of the whole value, so two documents that share a long prefix still
// differ here -- which is what keeps `ui_act`'s staleness check working on a
// padded URL. The digest is short because it only has to make the strings
// unequal, not to be a secret; it is of the FULL value, so it cannot be
// reproduced from the cut.
//
// A comparison is all it is for. A keyword past the cut no longer reaches
// `uiEffectHints`' context match, which is a heuristic over untrusted UI text
// either way (src/authority/ui-intent.ts says so), and 4096 characters of URL
// before the first mention of "mail" is not a page a hint was going to classify.
func axIdentityField(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	sum := sha256.Sum256([]byte(s))
	return string(r[:limit]) + "...#" + hex.EncodeToString(sum[:8])
}

// buildAXElements converts the flat AX node list into emitted elements with
// path/ordinal/sig refs. Interactive or named nodes only, capped.
func buildAXElements(nodes []axNode) []map[string]any {
	byID := make(map[string]*axNode, len(nodes))
	for i := range nodes {
		byID[nodes[i].NodeID] = &nodes[i]
	}

	// Ancestry path per node (root-first), capped depth, skipping unnamed
	// generic wrappers to keep paths meaningful.
	pathOf := func(n *axNode) []map[string]any {
		var rev []map[string]any
		for cur := byID[n.ParentID]; cur != nil; cur = byID[cur.ParentID] {
			role := cur.Role.str()
			name := cur.Name.str()
			if role == "" || (axIgnoredRoles[role] && name == "") {
				continue
			}
			name = truncateRunes(name, 40)
			rev = append(rev, map[string]any{"role": role, "name": name})
			if len(rev) >= axMaxPathDepth {
				break
			}
		}
		// reverse to root-first
		for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
			rev[i], rev[j] = rev[j], rev[i]
		}
		return rev
	}

	// Ordinals among same-parent siblings with equal role+name. Keyed on the
	// truncated name the sig is built from, so siblings that differ only past
	// the cut still get distinct ordinals (and so distinct sigs).
	ordCount := map[string]int{}
	ordinalOf := func(parentID, role, name string) int {
		key := parentID + "|" + role + "|" + name
		ord := ordCount[key]
		ordCount[key]++
		return ord
	}

	// Collect all emittable elements first, then cap. The cap must NOT be applied
	// in raw tree order — on a big page (Gmail inbox + open compose dialog) the
	// actionable fields can sit past the first N nodes and get truncated, so the
	// agent "opens compose but can't find the To field". Keep every interactive
	// element; cap only the static-text context.
	var interactiveEls, contextEls []map[string]any
	for i := range nodes {
		n := &nodes[i]
		if n.Ignored {
			continue
		}
		// Skip nodes with no backing DOM node: they cannot be clicked,
		// set_value'd, or box-modeled (DOM.resolveNode/getBoxModel fail with
		// "No node with given id found"), so emitting them only creates
		// un-actionable targets. Gmail's compose exposes such AX-only wrapper
		// nodes named "To"/"Subject" alongside the real editable fields.
		if n.BackendDOMNodeID == 0 {
			continue
		}
		role := n.Role.str()
		name := truncateRunes(n.Name.str(), 100)
		interactive := axInteractiveRoles[role]
		// Unnamed and not interactive: a wrapper with nothing to act on or
		// read. (This subsumes the ignored-roles check -- none of those roles
		// is interactive, so a nameless one never gets this far.)
		if !interactive && name == "" {
			continue
		}
		ord := ordinalOf(n.ParentID, role, name)

		path := pathOf(n)
		stableID := fmt.Sprintf("%d", n.BackendDOMNodeID)
		el := map[string]any{
			"ax_id":           n.NodeID,
			"backend_node_id": n.BackendDOMNodeID,
			"role":            role,
			"name":            name,
			"interactive":     interactive,
			"path":            path,
			"ordinal":         ord,
			"sig":             semanticSig(role, name, "", path, ord),
			"stable_id":       stableID,
		}
		// An element's VALUE comes from the same place its name does -- the
		// page -- and `name` has been cut at 100 since this file was written
		// while this was not (#597). One textarea holding a megabyte was enough
		// to get every element in the reply dropped at the brain's 2 MB cap.
		// Generous, because a value is read back for verification (ui_act's
		// `value_equals`) where a name is not; the whole-reply bound at the end
		// of this function is what actually holds the total.
		if v := n.Value.str(); v != "" {
			el["value"] = truncateRunes(v, axMaxValue)
		}
		for _, p := range n.Properties {
			if p.Value == nil || p.Value.Value == nil {
				continue
			}
			switch p.Name {
			case "disabled", "focused", "expanded", "checked", "selected":
				el[p.Name] = p.Value.Value
			}
		}
		if interactive {
			interactiveEls = append(interactiveEls, el)
		} else {
			contextEls = append(contextEls, el)
		}
	}

	// Interactive elements first, then as much named-text context as fits.
	out := interactiveEls
	if out == nil {
		out = []map[string]any{}
	}
	if budget := axMaxElements - len(out); budget > 0 {
		if budget > len(contextEls) {
			budget = len(contextEls)
		}
		out = append(out, contextEls[:budget]...)
	}
	// AND A LAST-RESORT BOUND ON THE WHOLE REPLY (#597).
	//
	// `axMaxElements` budgets only the CONTEXT elements: every interactive
	// element is kept however many there are, deliberately, because capping in
	// tree order made the agent "open compose but not find the To field" (see
	// above, and TestBuildAXElementsKeepsInteractiveElementsPastTheCap). That
	// priority is right and is NOT a bound: a page with a few thousand links or
	// one textarea holding a megabyte -- an ordinary big page, not an
	// adversarial one -- built a reply past the brain's 2 MB cap
	// (MAX_JSON_SIZE), at which point the whole AX read was dropped silently
	// and the model got NO elements at all, To and Subject included. Capping
	// `value` moved that threshold; it did not create one.
	//
	// So the bound is on the reply's SIZE, not on a count, and it is set far
	// above any honest page: it exists to turn "the model gets nothing" into
	// "the model gets the first several hundred elements", which strictly
	// dominates. The cost per element is an estimate, not an exact byte count --
	// an order-of-magnitude bound well under the cap is all that is wanted, and
	// an exact one would mean marshalling the reply twice.
	//
	// Fail SOFT, unlike the identity fields: a shortened element list is still
	// a usable surface where a dropped reply is nothing at all.
	spent := 0
	for i, el := range out {
		cost, err := axElementCost(el)
		if err != nil {
			out = out[:i]
			break
		}
		spent += cost
		if spent > axReplyBudget {
			out = out[:i]
			break
		}
	}
	return out
}

// axElementCost is the JSON bytes one emitted element costs, MEASURED rather
// than estimated.
//
// An estimate was wrong in both directions and wrong in the direction that
// matters. Go's encoder escapes `<`, `>` and `&` to six bytes each, so 600
// inputs each holding a thousand ampersands -- trivial to author, and exactly
// the page #597 is about -- measured 4.5x an estimate built from raw byte
// lengths: a 900 KB budget passed a 3.8 MB reply, which the brain then dropped
// whole, which is the bug. The same estimate was 15% PESSIMISTIC for ordinary
// ASCII, so it also cost honest pages capacity.
//
// One extra Marshal of an element is microseconds, and it cannot disagree with
// the encoder that writes the reply, because it IS that encoder. The `+ 1` is
// the comma that joins it to the array.
func axElementCost(el map[string]any) (int, error) {
	raw, err := json.Marshal(el)
	if err != nil {
		return 0, err
	}
	return len(raw) + 1, nil
}

// makeBrowserAXClickHandler clicks an element by backend_node_id: scroll it
// into view, resolve its box, and dispatch a real mouse click at its center.
// Element-addressed — immune to the index-shift problem of browser_click.
func makeBrowserAXClickHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		backendID, ok := params["backend_node_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("missing required parameter: backend_node_id (from browser_ax_snapshot)")
		}

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		// The id must still belong to the document it was read from, and that
		// document must be one we may drive (#602). Before anything is
		// scrolled, let alone clicked.
		if _, err := refuseStaleAXElement(cdp, int64(backendID)); err != nil {
			return nil, err
		}

		// Best effort; a hidden element will fail at the box-model step with
		// a precise error.
		//
		// THIS SCROLLS, by definition, which moves every coordinate the DOM
		// snapshot handed out while changing nothing any document check reports
		// (#603). The action paths would notice at use time -- their sentinel
		// compares each element's live position -- but the pebble's coordinate
		// readers deliberately do not run it, so the map is dropped here
		// instead of leaving them pointing at a pre-scroll position. The AX
		// ids are unaffected: a backendNodeId is re-resolved live.
		_, _ = cdp.send("DOM.scrollIntoViewIfNeeded", map[string]any{"backendNodeId": int64(backendID)})
		cdp.forgetSnapshotElements()

		raw, err := cdp.send("DOM.getBoxModel", map[string]any{"backendNodeId": int64(backendID)})
		if err != nil {
			return nil, fmt.Errorf("element %d has no layout box — it is detached or hidden; take a fresh browser_ax_snapshot: %w", int64(backendID), err)
		}
		var box struct {
			Model struct {
				Content []float64 `json:"content"`
			} `json:"model"`
		}
		if err := json.Unmarshal(raw, &box); err != nil || len(box.Model.Content) < 8 {
			return nil, fmt.Errorf("could not read element %d box model", int64(backendID))
		}
		// content quad: x1,y1,x2,y2,x3,y3,x4,y4
		cx := (box.Model.Content[0] + box.Model.Content[4]) / 2
		cy := (box.Model.Content[1] + box.Model.Content[5]) / 2

		// Same dispatcher browser_click uses: it moves the pointer to the
		// target first, so hover-gated controls (menus, Gmail's toolbars)
		// react the way they do for a real user.
		if err := dispatchClick(cdp, cx, cy, "left", false); err != nil {
			return nil, fmt.Errorf("click dispatch failed: %w", err)
		}

		return &RPCResult{Result: map[string]any{
			"success":         true,
			"backend_node_id": int64(backendID),
			"clicked_at":      map[string]any{"x": cx, "y": cy},
		}}, nil
	}
}

// axSetValueScript is the function `browser_ax_set_value` runs on the resolved
// node, in an isolated world. Named rather than inline so the ORDER of its
// terms can be asserted: the refusal has to come before the write, which is
// what makes it a guard rather than a report (#602).
//
// FOCUS IS ASKED OF THE NODE'S OWN ROOT, not of its document, and that is the
// one place this cannot copy the DOM path. `document.activeElement` RETARGETS
// to the shadow HOST, so for a node inside a shadow tree
// `ownerDocument.activeElement === this` is always false even when focus landed
// exactly where it should -- measured: focusing an `<input>` inside an open
// shadow root left `ownerDocument.activeElement` as the custom element while
// the shadow root's own `activeElement` was the input. The DOM snapshot never
// sees such a node (`querySelectorAll` does not pierce shadow roots) so its
// check is right as written; the AX tree DOES pierce, and asking the document
// here would have refused every web-component form field -- Salesforce
// Lightning, Shoelace, Ionic, Vaadin -- with a message telling the model to
// take a snapshot that cannot help.
//
// `getRootNode()` is the document for an ordinary node, so the honest path is
// unchanged. The `this.shadowRoot` term after it answers a different question
// (this node is itself a host whose shadow tree holds focus) and stays.
const axSetValueScript = `function(v) {
	if (!this.isConnected) return JSON.stringify({refused: 'detached'});
	this.focus();
	const root = this.getRootNode();
	const scope = root && 'activeElement' in root ? root : (this.ownerDocument || document);
	if (scope.activeElement !== this) return JSON.stringify({refused: 'not_focused'});
	if (this.shadowRoot && this.shadowRoot.activeElement) return JSON.stringify({refused: 'not_focused'});
	const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const desc = Object.getOwnPropertyDescriptor(proto, 'value');
	if (desc && desc.set && (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA')) {
		desc.set.call(this, v);
	} else if (this.isContentEditable) {
		this.textContent = v;
	} else {
		this.value = v;
	}
	this.dispatchEvent(new Event('input', {bubbles: true}));
	this.dispatchEvent(new Event('change', {bubbles: true}));
	return JSON.stringify({value: this.value !== undefined ? this.value : this.textContent, tag: this.tagName});
}`

// makeBrowserAXSetValueHandler sets a form control's value by
// backend_node_id via the DOM node itself (focus + value + input/change
// events), reading the value back for verification.
func makeBrowserAXSetValueHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		backendID, ok := params["backend_node_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("missing required parameter: backend_node_id (from browser_ax_snapshot)")
		}
		value, hasValue := params["value"].(string)
		if !hasValue {
			return nil, fmt.Errorf("missing required parameter: value")
		}

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		// Same document check the click path makes (#602), before a value is
		// written anywhere. Its reading is reused for the world below.
		identity, err := refuseStaleAXElement(cdp, int64(backendID))
		if err != nil {
			return nil, err
		}

		// RESOLVED INTO AN ISOLATED WORLD, not the page's own (#602).
		//
		// `DOM.resolveNode` with no executionContextId hands back an object in
		// the page's main world, and `Runtime.callFunctionOn` then runs the
		// function below there -- where the page controls the prototypes the
		// function reads through. Measured: with the page having redefined
		// `Node.prototype.isConnected` and `Document.prototype.activeElement`,
		// the main world reported `isConnected:false, focused:false` for the
		// very element it was about to write into, while an isolated-world
		// resolve of the same backendNodeId reported the truth. Putting the new
		// focus check in the main world would have been a check the page
		// answers. (The pre-existing `HTMLInputElement.prototype` value-setter
		// read has the same shape and the same fix.)
		//
		// The world is the MAIN FRAME's, which is sound because every id this
		// path can be given is a main-frame id: measured,
		// Accessibility.getFullAXTree exposes no same-origin subframe nodes.
		//
		// That premise is load-bearing and the fallback is NOT a refusal --
		// also measured: `DOM.resolveNode` of a same-origin subframe node into
		// the MAIN frame's isolated world succeeds, so if the AX snapshot ever
		// starts emitting subframe nodes, this would run the script in the
		// main frame's world with `this` from a child document. Still
		// isolated, and `getRootNode().activeElement` is still the child's, so
		// the outcome is safe -- but whether frame A's value setter accepts a
		// receiver from frame B is then the thing to measure.
		contextID, err := cdp.axWorldContext(identity.frameID, identity.loaderID)
		if err != nil {
			return nil, err
		}

		raw, err := cdp.send("DOM.resolveNode", map[string]any{
			"backendNodeId":      int64(backendID),
			"executionContextId": contextID,
		})
		if err != nil {
			// The cached world is the likeliest thing to have gone, and nothing
			// else clears it, so drop it: the next call mints a fresh one
			// rather than failing here for the life of the document.
			cdp.forgetAXWorld()
			return nil, fmt.Errorf("element %d could not be resolved — it is gone; take a fresh browser_ax_snapshot: %w", int64(backendID), err)
		}
		var resolved struct {
			Object struct {
				ObjectID string `json:"objectId"`
			} `json:"object"`
		}
		if err := json.Unmarshal(raw, &resolved); err != nil || resolved.Object.ObjectID == "" {
			return nil, fmt.Errorf("element %d resolved to no object", int64(backendID))
		}
		// resolveNode pins the node in the page's remote-object table; without
		// this the handle outlives every call for the life of the document.
		defer func() {
			_, _ = cdp.send("Runtime.releaseObject", map[string]any{"objectId": resolved.Object.ObjectID})
		}()

		fnRaw, err := cdp.send("Runtime.callFunctionOn", map[string]any{
			"objectId": resolved.Object.ObjectID,
			// FOCUS IS VERIFIED BEFORE THE VALUE IS WRITTEN (#602, #592's
			// measured predicate on the AX path).
			//
			// This is the AX twin of #592: it writes a value into an element
			// the model named, and nothing confirmed that the element it lands
			// on is the one that was reviewed. An isolated world alone does not
			// close that -- worlds share the DOM AND ITS EVENTS, so the page's
			// own `focus` listener still runs when `this.focus()` is called and
			// can move focus wherever it likes. #592 measured the consequence
			// on the DOM path: the script reported success while the approved
			// text landed in the page's chosen input.
			//
			// Same three terms as the DOM focus check, for the same measured
			// reasons: `isConnected` first (focusing a detached node is a
			// no-op and the write would follow whatever still had focus),
			// `activeElement` in the element's OWN document (for anything
			// inside a frame the top document's activeElement is the frame),
			// and EXACT equality with no shadow root holding focus.
			//
			// REFUSES rather than writing: a value written into an element that
			// could not take focus is a write nobody reviewed.
			"functionDeclaration": axSetValueScript,
			"arguments":           []map[string]any{{"value": value}},
			"returnByValue":       true,
		})
		if err != nil {
			cdp.forgetAXWorld()
			return nil, fmt.Errorf("set_value failed: %w", err)
		}
		var fnRes struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
			ExceptionDetails *struct {
				Text string `json:"text"`
			} `json:"exceptionDetails"`
		}
		_ = json.Unmarshal(fnRaw, &fnRes)
		if fnRes.ExceptionDetails != nil {
			// The page writes this text, so it is capped like every other
			// page-controlled reply (#597).
			return nil, fmt.Errorf("set_value threw in page: %s",
				truncateMarked(fnRes.ExceptionDetails.Text, maxPageControlledReply))
		}
		verify := map[string]any{}
		_ = json.Unmarshal([]byte(fnRes.Result.Value), &verify)
		// The focus check above refused, so NOTHING was written. Said as an
		// error, because a model that reads "success" here would move on.
		if refused, _ := verify["refused"].(string); refused != "" {
			if refused == "detached" {
				return nil, fmt.Errorf("element %d is no longer in the page, so nothing was typed; "+
					"take a fresh browser_ax_snapshot", int64(backendID))
			}
			return nil, fmt.Errorf("element %d did not take focus, so nothing was typed -- the page moved "+
				"focus elsewhere, or the element is covered or disabled; take a fresh browser_ax_snapshot "+
				"and check the element is the one you mean", int64(backendID))
		}
		// The readback is read AFTER the page's own `input`/`change` listeners
		// have run, so a listener chooses what comes back here -- and it was
		// unbounded, which is the dropped-reply bug again on the path that
		// confirms a write happened (#597). Capped like the snapshot's values.
		if v, ok := verify["value"].(string); ok {
			verify["value"] = truncateRunes(v, axMaxValue)
		}

		return &RPCResult{Result: map[string]any{
			"success":         true,
			"backend_node_id": int64(backendID),
			"readback":        verify,
		}}, nil
	}
}
