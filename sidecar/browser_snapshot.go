package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
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

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
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
        _fi: fi,
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

  // WHAT WAS TRUE WHEN THESE IDS WERE HANDED OUT, so a use-time guard can tell
  // that the thing an id names has changed while every field the frame tree
  // reports stayed put (#603).
  //
  // Three parts, each answering something no other check can see:
  //
  //   __jarvis_points   where each element WAS, in the same top-page viewport
  //                     space and the same rounding the click dispatches at.
  //                     Comparing the element's live centre to this is the
  //                     exact question -- "is the coordinate still where the
  //                     element is" -- where comparing the window's scroll
  //                     offset is only a proxy for it, and a bad one in both
  //                     directions: a position: fixed consent banner or a
  //                     sticky header does not move when the window scrolls
  //                     (so the proxy refuses a click that would have been
  //                     perfectly good), while an overflow: auto list
  //                     scrolling its own contents -- Gmail's message list,
  //                     Linear's issue list, a virtualised table, a chat log
  //                     -- moves every element inside it without touching
  //                     window.scrollY at all (so the proxy misses the
  //                     commonest staleness there is). Reflow from a
  //                     late-loading banner, a settling lazy image, a window
  //                     resize and a zoom change are all missed by the proxy
  //                     and caught by this.
  //   __jarvis_frames   which frame each element came from, so a frame that
  //                     rewrites itself invalidates only ITS OWN elements. The
  //                     app's own same-origin iframes churn constantly (a
  //                     Google Docs or Gmail compose editor lives in one), and
  //                     a cross-origin ad frame is never collected here at all,
  //                     so "some frame changed" would refuse typing into the
  //                     editor because a sibling frame reloaded.
  //   __jarvis_dom      each frame's documentElement, body and scroll offset.
  //                     The first two are how a REPLACED document is detected:
  //                     document.open()/write() replaces both while the
  //                     loaderId and the URL both hold (measured), and a
  //                     Turbo-style whole-body swap replaces the body alone
  //                     (measured), while pushState and an innerHTML re-render
  //                     anywhere in the tree touch neither (measured) -- which
  //                     is what makes this safe on every ordinary SPA click.
  //                     The scroll offset stays as the FALLBACK for an element
  //                     whose own node the page has since replaced, where
  //                     there is no live rect to compare.
  globalThis.__jarvis_points = els.map(e => [e.x, e.y]);
  globalThis.__jarvis_frames = els.map(e => e._fi);
  els.forEach((el, i) => { el.id = i + 1; delete el._el; delete el._fi; });

  globalThis.__jarvis_dom = frames.map(f => {
    const w = f.doc.defaultView;
    return [
      f.doc.documentElement,
      f.doc.body,
      w ? Math.round(w.scrollX || 0) : 0,
      w ? Math.round(w.scrollY || 0) : 0
    ];
  });

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

	// gen is the generation token this snapshot filled the element map under
	// (#676), taken in the SAME critical section as the fill. Unexported, so
	// the page's own JSON can never set it. Read later instead, it could name a
	// snapshot that refilled the map in between.
	gen string
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
		// Capped: `exceptionDetails` carries the page's own message and stack,
		// so an uncapped interpolation here is the same dropped-reply bug as the
		// title line was (#597) -- a page that throws a multi-megabyte Error
		// would lose its own snapshot's error to the 2 MB event cap.
		return nil, checked, fmt.Errorf("snapshot failed: %s",
			truncateMarked(string(wrapper.ExceptionDetails), maxPageControlledReply))
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
	snap.gen = cdp.elemGenTokenLocked()
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
//
// AND, since #603, from the three tools that move the page's geometry without
// navigating: browser_scroll, a paging key through browser_press_key, and
// browser_ax_click's scrollIntoViewIfNeeded. Their reason is different -- the
// coordinates describe where an element used to be -- and the action paths
// would refuse at use time anyway; what the drop buys is the readers that
// deliberately do not run that check, the pebble's coordinate and screen
// origin, which would otherwise keep pointing at a pre-scroll position.
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
	// token is the map's generation as the wire spells it (#676), read in the
	// same critical section as everything above.
	token string
}

// snapshotElementFor reads one element id out of the map in a single critical
// section, so the coordinate, the document it belongs to and the generation it
// was minted in cannot be torn apart by a concurrent snapshot.
//
// `token` is filled even when the id is not in the map, so a caller holding a
// reviewed generation can tell "this id was never in the snapshot you reviewed"
// from "the snapshot you reviewed is not the one in the map any more".
func (c *cdpClient) snapshotElementFor(id int) (snapshotElement, bool) {
	c.elemMu.Lock()
	defer c.elemMu.Unlock()
	coords, ok := c.elemCoords[id]
	if !ok {
		return snapshotElement{token: c.elemGenTokenLocked()}, false
	}
	return snapshotElement{
		x: coords[0], y: coords[1],
		identity: c.elemIdentity,
		gen:      c.elemGen,
		inFrame:  c.elemFrames[id],
		stamp:    c.elemFrameStamp,
		token:    c.elemGenTokenLocked(),
	}, true
}

// elemGenTokenLocked is the element map's generation as it travels on the wire
// (#676): `<epoch>.<elemGen>`. The caller holds elemMu.
//
// AN OPAQUE STRING, not the counter, for two reasons. The counter restarts at
// zero on every cdpClient -- a relaunched browser, a headless switch, a
// restarted sidecar -- so two different maps would hand out equal numbers, and
// a generation the brain reviewed against one would pass against the next. The
// epoch makes the token name this client's map and no other. And a string is
// compared for equality and nothing else on both sides, which is all either
// side may do with it: the brain does not order generations, it carries one.
func (c *cdpClient) elemGenTokenLocked() string {
	if c.elemEpoch == "" {
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			// crypto/rand does not fail on a supported platform; if it ever
			// does, a time-derived epoch still differs between clients.
			c.elemEpoch = strconv.FormatInt(time.Now().UnixNano(), 16)
		} else {
			c.elemEpoch = hex.EncodeToString(b[:])
		}
	}
	return c.elemEpoch + "." + strconv.FormatUint(c.elemGen, 10)
}

// browserSnapshotSupersededCode marks an element action refused because the
// snapshot the call was REVIEWED against is not the one in the map (#676).
// Returned before anything is dispatched -- before the frame-tree read, even --
// so the daemon may report it as not started (NOT_STARTED_RPC_CODES in
// src/actions/tools/sidecar-route.ts).
const browserSnapshotSupersededCode = "BROWSER_SNAPSHOT_SUPERSEDED"

// maxWireElemGen bounds the reviewed generation an action accepts. A real
// token is at most 37 bytes (16 hex, a dot, a uint64); anything longer is not
// one this sidecar minted.
const maxWireElemGen = 64

// reviewedElemGen reads the generation an element action was reviewed against
// (#676), or "" when the brain sent none.
//
// ABSENT means "nothing was reviewed": a brain older than #676, or a call that
// took no approval card. That is the behaviour before this existed, and it is
// the brain's job, not this one's, to refuse a reviewed call on a sidecar that
// cannot compare -- it knows which calls were reviewed and this side does not.
//
// PRESENT BUT MALFORMED is refused rather than ignored. A key that is there and
// not a usable string was meant to bind the call to something, and treating it
// as absent would be the fail-open this whole check exists to remove.
func reviewedElemGen(params map[string]any) (string, error) {
	raw, present := params["elem_gen"]
	if !present {
		return "", nil
	}
	gen, ok := raw.(string)
	if !ok || gen == "" || len(gen) > maxWireElemGen {
		return "", &codedError{code: browserSnapshotSupersededCode, err: fmt.Errorf(
			"the snapshot this action was reviewed against could not be read from the request, so nothing was done. " +
				"Run browser_snapshot and review the action again")}
	}
	return gen, nil
}

// browserSnapshotSuperseded is the refusal for a reviewed generation that is
// not the map's. Worded for the model: the ids it holds are from a snapshot
// that has been replaced, and only a fresh snapshot and a fresh review fix it.
func browserSnapshotSuperseded(id int) error {
	return &codedError{code: browserSnapshotSupersededCode, err: fmt.Errorf(
		"element [%d] was reviewed against a browser snapshot that has since been replaced or dropped, so "+
			"nothing was done: the id may now name a different element. Run browser_snapshot and review the "+
			"action again", id)}
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
//
// `usesCoordinates` says whether this caller will DISPATCH AT the stored
// coordinate (click, hover) or only use the id to find its element ref
// (type). It decides whether a scroll since the snapshot is disqualifying:
// a scroll moves every coordinate and invalidates no ref (#603).
//
// `reviewed` is the generation the call was REVIEWED against (#676), or "" for
// a call nobody reviewed. It is compared FIRST, against the token read in the
// same critical section as the element, and the generation check at the end of
// this function then holds the map to that same generation -- so a call that
// passes both acted on the COORDINATE MAP the person approved. It does not
// prove the isolated world's refs came from that same snapshot: two snapshots
// in flight at once can interleave their evaluate (which arms the refs) and
// their fill (which mints the generation), leaving one snapshot's refs under
// the other's generation. That race predates #676 and is not closed here; it
// matters to browser_type, which acts through a ref. The comparison lives here,
// on the side that owns the counter, because nothing brain-side can read it at
// the instant that matters.
func refuseStaleElement(cdp *cdpClient, id int, usesCoordinates bool, reviewed string) (snapshotElement, float64, string, error) {
	el, found := cdp.snapshotElementFor(id)
	if reviewed != "" && el.token != reviewed {
		return snapshotElement{}, 0, "", browserSnapshotSuperseded(id)
	}
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
	// The DOCUMENT may also have been replaced WITHOUT a new loaderId, and the
	// page may have scrolled (#603). Neither moves anything the frame tree
	// reports, so the terms above cannot see either one; both leave every
	// coordinate describing where an element used to be.
	//
	// Scoped exactly like the frame digest: a top-document change refuses every
	// id, a subframe change refuses only ids taken from a subframe. Without
	// that scoping a same-origin ad iframe rewriting itself on a timer would
	// refuse clicks on the main document -- page-triggerable denial of the
	// whole action path.
	switch cdp.domGeneration(ctx, id-1) {
	case "gone":
		return snapshotElement{}, 0, fmt.Sprintf(
			"Error: Element [%d] cannot be addressed any more. Run browser_snapshot first.", id), nil
	case "busy":
		return snapshotElement{}, 0, fmt.Sprintf(
			"Error: The page was too busy to confirm where element [%d] is, so nothing was done. Try again.",
			id), nil
	case "dom":
		return snapshotElement{}, 0, fmt.Sprintf(
			"Error: The page replaced the document element [%d] came from, so it no longer exists. "+
				"Run browser_snapshot first.", id), nil
	case "moved":
		// Only a caller that DISPATCHES AT the coordinate cares: see
		// `usesCoordinates` on this function and the sentinel's own docblock.
		if usesCoordinates {
			return snapshotElement{}, 0, fmt.Sprintf(
				"Error: Element [%d] has moved since the snapshot, so its position can no longer be trusted. "+
					"Run browser_snapshot first.", id), nil
		}
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

// domGenerationScriptFor asks the isolated world what has changed for ONE
// element since the snapshot handed out its id (#603).
//
// PER ELEMENT, not per page, because the answer differs per element and the
// coarse version was wrong in both directions: a page-wide scroll comparison
// refuses a click on a `position: fixed` consent banner that has not moved,
// and misses an `overflow: auto` list that has scrolled every element inside
// it without touching `window.scrollY`. See the arming block above.
//
// TWO VERDICTS, because they invalidate different things and the callers use
// different things:
//
//	'dom'    this element's own document, or the top document, was REPLACED.
//	         Every ref and every coordinate in it is stale, so every caller
//	         refuses -- including `browser_type`, which holds a ref.
//	'moved'  the element is still there and is no longer where the id says.
//	         Only a caller that DISPATCHES AT the coordinate cares:
//	         `browser_type` reaches its element through the ref and never
//	         reads the coordinate, and typing scrolls the caret into view, so
//	         refusing it here would make the second type into one
//	         contenteditable refuse itself.
//
// 'ok' is "nothing that matters to this id has changed"; 'gone' is "the world
// holds no reading for this id", which every caller refuses.
//
// The index is interpolated the way the focus script interpolates it. Keep in
// step with `domGenerationScript` in src/actions/browser/session.ts.
func domGenerationScriptFor(index int) string {
	return fmt.Sprintf(`(() => {
  const dom = globalThis.__jarvis_dom;
  const pts = globalThis.__jarvis_points;
  const fis = globalThis.__jarvis_frames;
  const i = %d;
  if (!dom || !dom.length || !pts || !fis) return 'gone';
  const frameIntact = (k) => {
    const entry = dom[k];
    if (!entry) return false;
    const root = entry[0];
    // A frame with no documentElement was never bindable: it contributed no
    // element and no coordinate, so it cannot invalidate one.
    if (!root) return true;
    const doc = root.ownerDocument;
    const win = doc && doc.defaultView;
    if (!doc || !win) return false;
    if (doc.documentElement !== root) return false;
    if (doc.body !== entry[1]) return false;
    return true;
  };
  // The top document always matters: an element in a frame is positioned by it.
  if (!frameIntact(0)) return 'dom';
  const fi = fis[i];
  if (typeof fi !== 'number' || !dom[fi] || !pts[i]) return 'gone';
  if (fi !== 0 && !frameIntact(fi)) return 'dom';
  const el = globalThis.__jarvis_elements && globalThis.__jarvis_elements[i];
  if (el && el.isConnected) {
    // The element's centre in TOP-PAGE viewport space: the same quantity the
    // snapshot stored, walked back up through the same frame offsets.
    let w = el.ownerDocument.defaultView, ox = 0, oy = 0, hops = 0;
    while (w && w.frameElement && hops++ < 10) {
      const fr = w.frameElement.getBoundingClientRect();
      ox += fr.x; oy += fr.y;
      w = w.frameElement.ownerDocument.defaultView;
    }
    if (w && !w.frameElement) {
      const r = el.getBoundingClientRect();
      const x = Math.round(ox + r.x + r.width / 2);
      const y = Math.round(oy + r.y + r.height / 2);
      // One pixel of tolerance for sub-pixel layout, which is also the most a
      // click can be off by and still land on the same place.
      return (Math.abs(x - pts[i][0]) <= 1 && Math.abs(y - pts[i][1]) <= 1) ? 'ok' : 'moved';
    }
  }
  // The node the snapshot held is gone or cannot be placed. That does NOT by
  // itself make the coordinate wrong -- an ordinary SPA re-render replaces
  // nodes constantly while the thing on screen stays put -- so fall back to
  // the frame's scroll offset, which is what the coarse check used to be.
  const entry = dom[fi];
  const root = entry[0];
  const win = root && root.ownerDocument && root.ownerDocument.defaultView;
  if (!win) return 'gone';
  return (Math.round(win.scrollX || 0) === entry[2] && Math.round(win.scrollY || 0) === entry[3]) ? 'ok' : 'moved';
})()`, index)
}

// domSentinelTimeout bounds the sentinel's own read.
//
// It is RENDERER-SERVED, which is new for the click and hover paths: before
// #603 those touched only the browser process and could not be held up by the
// page's main thread at all. Inheriting cdpDefaultTimeout's 30 seconds would
// mean a janked page -- or a modal `alert()`, which nothing here dismisses --
// parked a click for half a minute before refusing it. Long enough that a
// merely slow page still answers, short enough that a blocked one is reported
// as blocked.
const domSentinelTimeout = 4 * time.Second

// domGeneration runs the sentinel in the world the element refs live in, for
// one element index.
//
// Fails CLOSED in two distinguishable ways: "gone" (the world holds no reading
// for this id, or the read failed in a way a retry will not mend) and "busy"
// (the renderer did not answer in time, which is RETRYABLE and must not tell
// the model to take a snapshot the same renderer will not serve either).
//
// DELIBERATELY NOT inside `confirmSameDocument`. That function is
// browser-process-only (`Page.getFrameTree`), which is what makes it safe under
// `browser_element_point`'s 700 ms budget; this is renderer-served and an
// `alert()` can block it, so it belongs to the ACTION paths, which have no such
// budget, and not to the coordinate reply that a narration races.
func (c *cdpClient) domGeneration(contextID float64, index int) string {
	raw, err := c.sendOnTimeout(c.sessionID, "Runtime.evaluate", map[string]any{
		"contextId":     contextID,
		"returnByValue": true,
		"expression":    domGenerationScriptFor(index),
	}, domSentinelTimeout)
	if err != nil {
		// ONLY a timeout is retryable. `sendOnTimeout` also errors for a closed
		// pipe and for a CDP error reply -- and "Cannot find context with
		// specified id", which is what a destroyed world answers, is the
		// commonest one here. Calling that "busy" would tell the model to try
		// again forever instead of to take a fresh snapshot, and would disagree
		// with the daemon's half, which answers 'gone' for the same condition.
		if errors.Is(err, errCDPTimeout) {
			return "busy"
		}
		return "gone"
	}
	var parsed struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "gone"
	}
	switch parsed.Result.Value {
	case "ok", "dom", "moved":
		return parsed.Result.Value
	default:
		return "gone"
	}
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
// budget is tight -- and the number to size against is the TIGHTEST caller's,
// not the brain's 1200 ms narration race this comment used to cite. Five of the
// six callers pass cdpDefaultTimeout and are not what makes a second read
// expensive. The sixth is browser_element_point.go, which since #610 takes
// elementPointBudget (900 ms) at entry for all four of its reads together and
// caps any one of them at elementPointReadTimeout (700 ms). Against that, a
// second frame-tree read to learn the same thing twice is up to ~78% of the
// budget rather than a quarter of it, and -- with elementPointMinRead at 20 ms
// -- two reads that slow leave too little behind for the rest to be issued at
// all. It also makes the two values provably consistent: an identity and a
// digest read a beat apart could describe different moments, which is the class
// of bug this whole change is about.
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
//
// EVERY limit here counts CODE POINTS, not bytes and not UTF-16 units (#597).
// The two formatters have to produce the same text for the same page, and they
// used to disagree the moment a page was not ASCII: Go sliced `snap.Text` by
// BYTES while the daemon sliced the same field by UTF-16 units, so a CJK page
// showed roughly 666 characters here against the daemon's 2000 and the two
// "(N chars truncated)" numbers differed by about three times for one page.
// Byte slicing also cuts a multi-byte character in half, and the half then
// reaches the model as U+FFFD. `snapshot_parity_expected.txt` in testdata is
// the golden rendering both sides are held to, deliberately full of characters
// that make the three countings disagree.
const (
	maxPageText = 2000
	maxElements = 80
	maxSameRole = 15
	// Element fields, cut again here because the snapshot script's own cuts are
	// UTF-16 units in both scripts and these are code points.
	maxElementText = 50
	maxElementHref = 80
	// Attribute values and the Key Elements labels built from them. The
	// snapshot script already cuts every attribute at 200 (UTF-16 units, so
	// never more than 200 code points), which makes this a bound the formatter
	// holds on its own rather than a second cut of the same value.
	maxElementAttr = 200
)

// Caps for the two lines a PAGE writes into the rendered snapshot (#597).
//
// `Page:` is `document.title` and `URL:` is `location.href`, both chosen by the
// page and both previously uncapped -- so a multi-megabyte title pushed the
// whole reply past the brain's 2 MB event cap (MAX_JSON_SIZE in
// src/sidecar/validator.ts) and the read was DROPPED: no text, no error, and
// nothing pointing at the cause. Everything else in this rendering is already
// bounded (page text above, 80 elements, each attribute cut at 200 by the
// snapshot script), so these two lines were the whole exposure.
//
// TRUNCATED rather than refused, which is the opposite of what #594 does to the
// identity fields on the wire, and deliberately: those are a value code BRANCHES
// on, where a shortened URL names a different page and a wrong site playbook is
// worse than none, while these are prose the model READS, and a shortened title
// beats a dropped snapshot. Marked visibly so the model can tell.
//
// Two numbers, not one. 2048 is generous for a title (a real one is under 200)
// and far too small for a URL: a Maps link with an encoded polyline, a Looker
// Studio report state, or an OAuth callback carrying an id_token all exceed it
// routinely, and this is the line the model copies back into browser_navigate.
// So the URL line takes `maxWirePageURL`'s NUMBER instead, so that a URL which
// survives the wire is not cut in the text. One number, two units and two
// different values: this one counts code points of the page's `location.href`,
// the wire check counts bytes of the frame tree's URL. They are not a coupling
// to maintain -- if either side ever needs its own figure, give it a literal
// and say so here.
const (
	maxRenderedTitle = 2048
	maxRenderedURL   = maxWirePageURL
	// Everything else a PAGE chooses and a browser reply then carries: a
	// `browser_evaluate` result, and the `exceptionDetails` a thrown Error
	// fills. Same failure, same marker, a bigger number because a model asks
	// `browser_evaluate` for a value rather than for prose (#597).
	maxPageControlledReply = 20000
)

// renderedValue prepares a page-controlled value for a single LINE of the
// rendering: control characters out, then cut to `limit` code points.
//
// The strip is the same rule `truncateURL` applies, for the same reason. These
// fields are single-line BY CONSTRUCTION -- a title, a label, an element's
// collapsed text -- so a newline in one is a page writing a line of the
// rendering: `document.title = "x\nURL: https://bank.example"` produced a
// second, forged `URL:` line, and an `aria-label` carrying a newline forged an
// element line, inside a block whose every line the model reads as ours.
//
// SCOPE, stated because it is easy to over-read. It covers the title, the URL
// line, the attributes and the element text, and only the C0 range plus DEL:
// U+0085, U+2028 and U+2029 survive, so a consumer that treats those as line
// breaks sees more lines than the formatter wrote. That is deliberate -- both
// formatters emit them identically (see quoteElementText), so removing them
// would be a second rule to keep in step for a reader nothing here has -- and
// the `--- Page Text ---` block is legitimately multi-line and is not stripped
// at all, so a page can still put something that reads like a section header
// or an `[id]` line into its own body text. Nothing escapes the untrusted
// block either way; what this buys is that the lines the FORMATTER writes are
// the formatter's.
//
// `renderedValue` in src/actions/tools/builtin.ts is this function.
func renderedValue(s string, limit int) string {
	return truncateRunes(stripControlChars(s), limit)
}

// stripControlChars replaces every run of C0 controls and DEL with ONE space.
//
// Replaced rather than deleted, and that matters: a multi-line
// `aria-label="Send\nnow"` is ordinary authoring, and deleting the newline
// glues the words into "Sendnow". A space is also what the snapshot scripts
// already do to the whitespace they collapse (`.replace(/\s+/g, ' ')`), so this
// is the same rule reaching the characters that rule does not match.
//
// Only runs of CONTROL characters collapse. Ordinary runs of spaces in an
// attribute are left exactly as they are, so a value with no control character
// in it is returned byte for byte.
//
// `stripControlChars` in src/actions/tools/builtin.ts is this function.
func stripControlChars(s string) string {
	if !strings.ContainsFunc(s, isControlChar) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	inRun := false
	for _, r := range s {
		if isControlChar(r) {
			if !inRun {
				b.WriteByte(' ')
				inRun = true
			}
			continue
		}
		inRun = false
		b.WriteRune(r)
	}
	return b.String()
}

func isControlChar(r rune) bool {
	return r < 0x20 || r == 0x7f
}

// quoteElementText renders an element's own text as a quoted string.
//
// NOT `%q`, which is why this exists. `%q` escapes every rune Go calls
// non-printable, and the daemon's `JSON.stringify` escapes only `"`, `\` and
// the C0 range -- so the two formatters disagreed about any code point that is
// unprintable to Go but ordinary to JSON: a Material Icons or Font Awesome
// LIGATURE GLYPH in a button's text (private-use, and common), a zero-width
// space, a soft hyphen, a bidi mark, a C1 byte off a mis-decoded
// windows-1252 page. Go rendered `""` where the daemon rendered the
// glyph, on exactly the kind of button a template tells the model to click.
//
// So both sides quote the same way: the C0 range is already gone (see
// stripControlChars), and what is left needs `"` and `\` escaped and nothing
// else. This is `JSON.stringify` for that input, implemented here rather than
// relied upon through a formatting verb that answers a different question.
func quoteElementText(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for _, r := range s {
		if r == '"' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

// truncateMarked cuts a page-controlled value to `limit` code points and says
// so in place. No strip: this is for a value that is legitimately MULTI-LINE --
// a `browser_evaluate` result, which is routinely `innerText` or
// pretty-printed JSON, and an `exceptionDetails` blob. Stripping those would
// glue every line of a document together, which is a change to what the model
// reads that has nothing to do with capping it.
//
// The marker is appended directly after the value with no leading space, and it
// reuses the grammar and the quantity the page-text cut above already uses
// ("chars truncated" = characters REMOVED). One marker grammar across both
// formatters; `truncateMarked` in src/actions/tools/builtin.ts is this function.
func truncateMarked(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return fmt.Sprintf("%s... (%d chars truncated)", string(r[:limit]), len(r)-limit)
}

// truncateRendered is truncateMarked for a value that must also be ONE LINE:
// the `Page:` and `URL:` lines, where the cut is the difference between a short
// title and a dropped snapshot.
//
// The count is taken AFTER the strip, so it reports the characters removed from
// the one-line value, not from the page's original.
func truncateRendered(s string, limit int) string {
	return truncateMarked(stripControlChars(s), limit)
}

// formatBrowserSnapshot is a faithful port of the daemon's formatSnapshot.
func formatBrowserSnapshot(snap *pageSnapshot) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("Page: %s", truncateRendered(snap.Title, maxRenderedTitle)))
	lines = append(lines, fmt.Sprintf("URL: %s", truncateRendered(snap.URL, maxRenderedURL)))
	lines = append(lines, "")
	lines = append(lines, "--- Page Text ---")
	if text := []rune(snap.Text); len(text) > maxPageText {
		lines = append(lines, string(text[:maxPageText]))
		lines = append(lines, fmt.Sprintf("... (%d chars truncated)", len(text)-maxPageText))
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
			keyLines = append(keyLines, fmt.Sprintf("[%d] INPUT: %s%s", el.ID, renderedValue(label, maxElementAttr), suffix))
		}
	}
	for _, el := range shown {
		if (el.Tag == "button" || el.Attrs["role"] == "button") && el.Attrs["aria-label"] != "" {
			keyLines = append(keyLines, fmt.Sprintf("[%d] BUTTON: %s", el.ID, renderedValue(el.Attrs["aria-label"], maxElementAttr)))
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
				attrParts = append(attrParts, fmt.Sprintf(format, renderedValue(v, maxElementAttr)))
			}
		}
		addAttr("name", `name="%s"`)
		addAttr("placeholder", `placeholder="%s"`)
		addAttr("type", `type="%s"`)
		if href := el.Attrs["href"]; href != "" {
			attrParts = append(attrParts, fmt.Sprintf(`href="%s"`, renderedValue(href, maxElementHref)))
		}
		addAttr("aria-label", `aria-label="%s"`)
		addAttr("role", `role="%s"`)
		addAttr("contenteditable", `contenteditable="%s"`)
		addAttr("data-testid", `data-testid="%s"`)
		addAttr("iframe", `iframe="%s"`)

		textStr := ""
		if el.Text != "" {
			textStr = " " + quoteElementText(renderedValue(el.Text, maxElementText))
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
//
// The third value is the generation the snapshot filled the element map under
// (#676), for the reply.
func takeFormattedSnapshot(cdp *cdpClient) (string, pageIdentity, string, error) {
	snap, id, err := takePageSnapshot(cdp)
	if err != nil {
		return "", id, "", err
	}
	return formatBrowserSnapshot(snap), id, snap.gen, nil
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
//
// `elem_gen` is the generation of the element map THIS read filled (#676). The
// brain records it at review time and hands it back on the element action it
// approved, and refuseStaleElement compares the two. It travels independently
// of the identity pair: it names the map, not the document.
type pageReply struct {
	Text     string `json:"text"`
	PageURL  string `json:"page_url,omitempty"`
	LoaderID string `json:"loader_id,omitempty"`
	ElemGen  string `json:"elem_gen,omitempty"`
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
// It does NOT by itself make the reply as a whole safe. The rendered text used
// to be the other half of that exposure -- `Page: <document.title>` and `URL:
// <location.href>` had no cap of their own, so a page with a multi-megabyte
// title got its own reads dropped. #597 closed that in both formatters
// (`maxRenderedTitle` / `maxRenderedURL` above), so the whole rendering is now
// bounded; these two fields are bounded here because they travel BESIDE it.
//
// Deliberately NOT the daemon's 2048, so nobody reads the two numbers as a
// coupling to keep in step. An over-long URL is omitted rather than truncated --
// a truncated identity is a different page, and a wrong playbook is worse than
// none. `maxRenderedURL` reuses this NUMBER (see it for why), but the two are
// not the same quantity: the check below counts BYTES of the frame-tree URL
// where the renderer counts code points of the page's `location.href`.
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
// The identity is dropped unless the browser actually named the document. This
// check predates #603, which made the same rule a property of `assertSamePage`
// itself -- so an unnamed document no longer reaches here at all on a read that
// goes through that guard. It stays because this function does not: it packages
// whatever identity its caller hands it, a frame tree can be nameless (a
// pre-commit initial document, or a reply whose shape `json.Unmarshal` fills
// only partly), and a field this cheap to re-check should not depend on which
// guard the caller happened to run. It costs at most one site playbook.
func browserPageResult(formatted string, id pageIdentity, gen string, params map[string]any) *RPCResult {
	if !wantsPageIdentity(params) {
		return &RPCResult{Result: formatted}
	}
	reply := pageReply{Text: formatted, ElemGen: gen}
	if id.loaderID != "" && len(id.loaderID) <= maxWireLoaderID && len(id.url) <= maxWirePageURL {
		reply.PageURL = id.url
		reply.LoaderID = id.loaderID
	}
	return &RPCResult{Result: reply}
}
