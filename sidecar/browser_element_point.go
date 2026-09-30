package main

import (
	"encoding/json"
	"fmt"
	"math"
	"time"
)

// ── browser_element_point: where a snapshot element is on the screen ─────
//
// A READ-ONLY answer to one question: for an element id the last snapshot
// minted, where would a click at that id land on this machine's screen?
//
// Why it exists (#591). #585 made the pebble narration point at the element the
// snapshot actually named, and fail closed -- "(location unknown)", pebble does
// not move -- when no honest coordinate is available. On a DEFAULT install that
// is every browser action: CapBrowser is in the sidecar's default capability set
// (config.go), the pebble only exists for a connected sidecar, so the click
// routes here and its coordinates live in this process's own map with no RPC
// carrying them back. The daemon had nothing honest to point at, so PR #590 was
// held in draft. This is the RPC that turns the pointer back on.
//
// READ AUTHORITY, and it is enforced by construction rather than by comment:
//
//   - It takes no *SidecarConfig. The registry hands one to every other browser
//     handler because they may need to FIND and LAUNCH a browser; this handler
//     is registered as a bare function, so the launch path is not reachable
//     from it -- there is nothing to launch with. #585's review found the
//     narration it replaces reaching execute_command authority through
//     browser_evaluate and able to lazily start a headed Chromium for a
//     cosmetic code path; this inherits none of that.
//   - It uses existingCDP(), never getCDP/getCDPForParams. No browser, no
//     answer. See existingCDP for why it also ignores `headless`: honouring it
//     would let a read-only call tear a running browser down.
//   - It sends four commands and three distinct CDP methods, all of them
//     getters: Page.getFrameTree (twice, as the check and the re-check),
//     Browser.getWindowForTarget and Page.getLayoutMetrics. Four on every path,
//     including an in-frame element -- the frame digest rides along on the
//     re-check's reading rather than costing a read of its own. No Runtime.*,
//     so no script; no Input.*, no DOM.focus, no Page.bringToFront, no
//     Target.activateTarget, so no focus move; no Page.navigate/reload; no
//     Browser.setWindowBounds, no Emulation.*, no Page.setDeviceMetricsOverride.
//     That list is prose and prose is not a proof, which is why
//     TestBrowserElementPointSendsOnlyReads asserts the sent sequence EXACTLY,
//     for the main-document and in-frame paths both -- a later edit that adds a
//     fifth command fails a test rather than a review.
//   - Browser.getWindowForTarget is treated as read-only on reasoned grounds
//     rather than measured ones: the mutator in that domain is
//     Browser.setWindowBounds, and it cannot create a window -- it errors with
//     "No web contents in the target" when the session has none. Note WHY it is
//     safe here: it is a browser-level command, and it is scoped to the attached
//     page only because `send` tags it with the flat-mode session id. An edit
//     that sent it on sendOn("") with a caller-supplied targetId would be
//     reading another target's window.
//   - It hands back four scalars. No page text, no title, no element list, and
//     deliberately no URL -- see the reply shape below.
//
// The browser cannot be KILLED from here either, and that is worth stating
// because it is the obvious worry: shutdown() is reachable only from getCDP's
// headless flip, closeActiveCDP (browser_close), launchCDP's own failure paths,
// and c.fail(), which readLoop calls on a pipe error and sendOn never does. So
// even a read that times out cannot take the browser down from this handler.

// The coordinate space this RPC answers in, named on the wire.
//
// SCREEN DIP: Chromium device-independent pixels, absolute on this machine's
// screen, top-left origin. Measured against a real Chromium at
// --force-device-scale-factor 1, 1.5 and 2: Browser.getWindowForTarget's bounds
// are DIP and invariant under the scale factor, and identical to the page's own
// window.screenX/screenY -- which is why this reads the Browser domain instead,
// and never asks the page. A page can install a screenX getter; it cannot
// install a frame tree.
//
// How that relates to where the pebble actually flies, per platform.
// pebble.point_at has exactly one unit contract and it is not written as a unit:
// pebbleCore.PointAt stores x/y and advanceFrame eases toward them in whatever
// space platformGetCursorPos() returns (pebble_runtime.go).
//
//	macOS    Cocoa POINTS, and panels_darwin.go already flips y to a top-left
//	         origin. Points are the 1x logical space, so this IS screen DIP.
//	Linux    GDK logical px, top-left (panels_linux.go). Equal to DIP whenever
//	         Chromium's device scale factor matches GDK's, which is the ordinary
//	         case since Chromium derives it from GDK.
//	Windows  GetCursorPos under a PerMonitorV2 manifest, i.e. PHYSICAL
//	         virtual-screen px (panels_windows.go). Equal to DIP at 100% DPI and
//	         off by the monitor's scale factor otherwise.
//
// So this is exact on macOS and Linux and on Windows at 100% DPI, and off by the
// DPI scale on Windows above that. A per-platform conversion is deliberately NOT
// done here: #585 removed a devicePixelRatio multiply that was wrong on two of
// three platforms, there is no scale-factor helper in this tree to reuse (the
// only backing-scale read is a C file-static in region_select_darwin.go, and
// platformGetScreenSize is a hardcoded stub on darwin and linux), and the
// daemon's own local narration path has the identical Windows behaviour today --
// so this introduces no new error anywhere. The `space` field is the hook for
// closing it later: a measured conversion ships a new space name, and the daemon
// refuses a space it does not recognise rather than misplacing the pointer.
const elementPointSpace = "screen_dip"

// Absolute bound on a screen coordinate this handler will answer.
//
// The pebble stores the point in atomic.Int32 (pebble_runtime.go), so a value
// that does not fit truncates and the pebble flies somewhere unrelated -- a
// wrong pointer, which is the one outcome every part of #585 and #591 exists to
// prevent. This is far outside any real multi-monitor desktop and is a sanity
// bound, not a screen size: platformGetScreenSize cannot be used for a real one
// because it is a hardcoded 1920x1080 stub on darwin and linux.
const maxElementPointCoord = 1 << 20

// Page-zoom bounds. `zoom` is the CSS-px -> DIP ratio and multiplies every term
// in the answer, so a nonsense value is not something to clamp and carry on
// with. Chrome's own zoom range is 25%-500%.
const (
	minElementPointZoom = 0.1
	maxElementPointZoom = 10.0
)

// The renderer-served reads get a short budget of their own instead of
// inheriting cdpDefaultTimeout's 30 seconds.
//
// Upstream, #590 races the whole resolution against 1200 ms and shows
// "(location unknown)" when it loses -- so a read that sits for 30 seconds
// produces the same user-visible outcome as a read that fails in one, while
// holding a goroutine and a pending-reply slot for the other 29. Page.* is
// answered by the renderer, so a long task, a janked page or a modal alert()
// blocks it; that is a page being busy, not a sidecar being broken, and the
// honest answer is to give up quickly.
const elementPointReadTimeout = 700 * time.Millisecond

// RPC error codes for this handler.
//
// CODED, not free text, because the daemon must classify the refusal WITHOUT
// reading the message (#594's rule: classification never parses display text).
// There is a second reason here, and it is the sharper one: the refusals this
// handler can hit include refuseLocalContent's, whose messages embed the page
// URL via truncateURL. The daemon writes a log line about a skipped coordinate,
// and #594 refused to put a URL in one -- a refused URL is precisely the value
// that may be carrying the characters that must not reach a log. So the daemon
// maps these codes to its own strings and never interpolates the message.
const (
	errNoBrowser    = "BROWSER_NOT_RUNNING"
	errBadElementID = "BROWSER_BAD_ELEMENT_ID"
	errNoElement    = "BROWSER_ELEMENT_NOT_IN_SNAPSHOT"
	errStalePage    = "BROWSER_SNAPSHOT_STALE"
	errNoGeometry   = "BROWSER_GEOMETRY_UNAVAILABLE"
)

func codedRefusal(code string, format string, args ...any) error {
	return &codedError{code: code, err: fmt.Errorf(format, args...)}
}

// handleBrowserElementPoint answers browser_element_point.
//
// Registered as a bare handler (no *SidecarConfig) so that the browser-launch
// path is structurally out of reach. See the file header.
func handleBrowserElementPoint(params map[string]any) (*RPCResult, error) {
	// Strictly, and the same way every other browser handler reads it: JSON
	// numbers arrive as float64, and a 1-based integer is the only thing the
	// snapshot ever minted. A coerced "5" or a 5.5 names nothing, and answering
	// for something the click will refuse is a confident pointer at an action
	// that will not happen.
	raw, ok := params["element_id"].(float64)
	if !ok {
		return nil, codedRefusal(errBadElementID, "missing required parameter: element_id")
	}
	if raw != math.Trunc(raw) || raw < 1 || raw > math.MaxInt32 {
		return nil, codedRefusal(errBadElementID, "element_id must be a snapshot element id (a whole number from 1)")
	}
	id := int(raw)

	cdp := existingCDP()
	if cdp == nil {
		// No browser, no answer, and NOTHING IS LAUNCHED. A narration runs
		// before the action it previews has been approved; it must never be the
		// reason a browser window appears on someone's desktop.
		return nil, codedRefusal(errNoBrowser, "no browser is running, so there is no element to locate")
	}

	// A HIDDEN browser has no position on anybody's screen, and this is the one
	// refusal only the sidecar can make.
	//
	// `--headless=new` still reports window bounds, and they look completely
	// ordinary: --window-position=137,91 comes back as left:137, top:91 with
	// windowState "normal" (measured). Nothing in the reply says "there is no
	// window". So without this the handler would compute a well-formed point on
	// the user's REAL desktop, and the pebble would fly there and sit over
	// whichever application actually occupies it -- with a confident label and
	// no "(location unknown)". That is precisely the wrong-pointer outcome #585
	// and #591 exist to remove.
	//
	// It is not an exotic mode either: `headless` is a model-settable parameter
	// whose own tool description recommends it ("useful ... when the user is
	// focused on something else and a popping browser window would be
	// intrusive", src/actions/tools/builtin.ts). So the considerate path is
	// exactly the path that would misplace the pointer.
	//
	// The daemon cannot make this call: only this process knows how its browser
	// was launched.
	if cdp.headless {
		return nil, codedRefusal(errNoGeometry,
			"the browser is running hidden, so it has no position on the screen")
	}

	// CHECK, READ, CHECK AGAIN (browser_read_guard.go). The first check
	// establishes which document we are looking at and refuses local content
	// (#526) -- a coordinate is not page text, but there is no reason for this
	// path to be the one exception to "we do not read a file: page", and the
	// frame-tree read is needed anyway.
	before, beforeStamp, err := cdp.frameTreeState(elementPointReadTimeout)
	if err != nil {
		return nil, codedRefusal(errStalePage, "could not check which page the browser is showing: %w", err)
	}
	if err := refuseLocalIdentity(before); err != nil {
		// The reason is coded; the MESSAGE is this handler's own. Every
		// refusal that refuseLocalIdentity writes interpolates the page URL via
		// truncateURL, and the daemon turns a refusal here into a log line
		// about a skipped coordinate -- #594 refused to put a URL in one,
		// because a refused URL is exactly the value that may be carrying the
		// characters that must not reach a log. Keeping the substitution here
		// makes that guarantee local and permanent rather than a property of
		// daemon code that has to keep remembering.
		return nil, codedRefusal(errStalePage,
			"the browser is showing content that is not read back to the model")
	}
	// Named, and short enough to put on the wire. #594 caps the loader id at 64
	// because one oversized field drops the brain's whole event (its 2 MB
	// MAX_JSON_SIZE), and then the RPC never resolves at all. Refused rather
	// than truncated, for #594's reason: a truncated identity is a different
	// document.
	if before.loaderID == "" || len(before.loaderID) > maxWireLoaderID {
		return nil, codedRefusal(errStalePage, "the browser did not usably name the document it is showing")
	}

	// One critical section for the coordinate and everything that proves it
	// belongs to this document, so a concurrent snapshot cannot tear them apart.
	el, found := cdp.snapshotElementFor(id)
	if !found {
		return nil, codedRefusal(errNoElement, "element [%d] is not in the current snapshot", id)
	}

	// CURRENT GENERATION ONLY. A stale coordinate is the bug #585 exists to
	// remove, so this refuses rather than guesses: the document the map was
	// filled under must be the document the browser is showing now.
	if el.identity.loaderID == "" || el.identity.loaderID != before.loaderID {
		return nil, codedRefusal(errStalePage,
			"element [%d] came from a document the browser has since left", id)
	}
	// And for an element the snapshot took from a same-origin SUBFRAME, the
	// subframe must not have committed a document of its own. A child can
	// navigate itself while the main frame's loaderId never moves (measured),
	// which leaves the coordinate pointing into a destroyed document. Checked
	// only for in-frame ids: an unrelated advertising iframe reloading must not
	// cost a pointer for a main-document element.
	if el.inFrame && el.stamp != beforeStamp {
		return nil, codedRefusal(errStalePage,
			"element [%d] came from a frame that has since navigated", id)
	}

	origin, err := cdp.viewportScreenOrigin()
	if err != nil {
		return nil, &codedError{code: errNoGeometry, err: err}
	}

	// The element must be INSIDE the viewport to have a screen position at all.
	//
	// The snapshot filters on display, visibility, opacity and a 5x5 minimum
	// size -- it does not filter on viewport containment, and the coordinates
	// are getBoundingClientRect centres. So a button 2500 CSS px below the fold
	// sits in the map with y=2500, and without this the handler would answer a
	// point that far below the window: usually off-screen, and in any case not
	// where the element is. The generous 2^20 sanity bound does nothing about
	// it. This is the other half of making "no pointer, never a wrong pointer"
	// true rather than aspirational.
	//
	// It costs nothing to check because the bound is already in the reply being
	// parsed: cssLayoutViewport carries clientWidth beside clientHeight.
	// Nothing is lost by refusing, either -- the click would not land on the
	// element either, which is the same staleness the playbooks already warn
	// about (webapp-templates/goodreads.yaml).
	if el.x < 0 || el.y < 0 || el.x > origin.clientW || el.y > origin.clientH {
		return nil, codedRefusal(errNoGeometry,
			"element [%d] is not inside the visible viewport, so it has no position on the screen", id)
	}

	// The element's snapshot coordinate is a VIEWPORT offset in CSS px
	// (getBoundingClientRect, offset to top-page space for subframes), so the
	// scroll position is already excluded -- cssLayoutViewport.pageX/pageY is
	// deliberately NOT added here, it would double-count the scroll. The click
	// dispatches at this same viewport-relative number, so the pointer and the
	// click agree about scroll by construction, including when both are stale
	// because the page scrolled. That is the invariant #590 states and not
	// something this RPC may improve unilaterally.
	x := origin.x + el.x*origin.zoom
	y := origin.y + el.y*origin.zoom
	if !isSaneElementPoint(x) || !isSaneElementPoint(y) {
		return nil, codedRefusal(errNoGeometry,
			"the element's screen position is not a usable coordinate")
	}

	// CHECK AGAIN, in ONE round trip that answers both questions and carries
	// this handler's own short budget.
	//
	// confirmSameDocument compares the loaderId and NOT the url: the reply
	// carries no URL, so there is nothing a URL change could make false, and
	// comparing it would refuse a pointer on every SPA pushState (see that
	// function). The same reading gives the frame digest, so an in-frame
	// element costs no extra send -- an earlier version called
	// assertSameDocument and then re-read the very tree it had just thrown
	// away, at cdpDefaultTimeout's 30 seconds each, on a path the daemon
	// abandons after 1200 ms.
	after, afterStamp, err := cdp.confirmSameDocument(before, elementPointReadTimeout)
	if err != nil {
		return nil, &codedError{code: errStalePage, err: err}
	}
	if el.inFrame && afterStamp != el.stamp {
		return nil, codedRefusal(errStalePage,
			"element [%d] came from a frame that navigated while its position was being read", id)
	}

	// The map must not have been refilled while any of that was happening, and
	// this is the LAST thing checked so that nothing can land after it.
	//
	// The loaderId cannot see this: a snapshot of the SAME document re-mints
	// every coordinate and leaves the document identity untouched, so without
	// it the answer could be a previous snapshot's number for an id the click
	// now resolves elsewhere.
	if cdp.snapshotGeneration() != el.gen {
		return nil, codedRefusal(errStalePage,
			"a new snapshot replaced element [%d] while its position was being read", id)
	}

	// x, y, space and loader_id are ONE indivisible answer -- all four or an
	// error. #594's rule is that a page_url never travels without a loader_id,
	// because the loader id is what makes the URL name THIS document; transposed
	// here, a coordinate never travels without the loader id of the document it
	// belongs to. There is no reply shape carrying a coordinate whose document
	// is unnamed, so the daemon has nothing to half-trust.
	//
	// There is deliberately NO page_url. Nothing on this path reads a URL: the
	// pebble needs two numbers, the guard needs a document token, and the
	// daemon's log line must not print a URL anyway. And browser_ax.go already
	// warns that once several object-shaped browser replies carry a URL-ish
	// field, a daemon decoder keying on "a url in an object reply" hands a page
	// its own choice of site playbook again (#572). A coords reply cannot select
	// a playbook because it carries nothing a playbook could be selected from.
	return &RPCResult{Result: map[string]any{
		"x":         int(math.Round(x)),
		"y":         int(math.Round(y)),
		"space":     elementPointSpace,
		"loader_id": after.loaderID,
	}}, nil
}

func isSaneElementPoint(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) &&
		v >= -maxElementPointCoord && v <= maxElementPointCoord
}

// viewportOrigin is where the page's viewport sits on the screen, plus the
// factor that converts a CSS pixel to that space.
type viewportOrigin struct {
	x, y float64
	zoom float64
	// The viewport's own size in CSS px, so a caller can tell whether an
	// element is inside it. Both come from the one getLayoutMetrics reply.
	clientW, clientH float64
}

// viewportScreenOrigin reads the viewport's top-left corner in screen DIP.
//
// WITHOUT RUNNING PAGE SCRIPT, which is the part that matters. #585's local
// narration reads window.screenX in an isolated world precisely because a page
// can install its own screenX getter; asking the Browser and Page domains is one
// better, because the page is not asked at all -- there is nothing to shadow and
// no world to mint. Measured equal to the page's own values at three device
// scale factors.
//
// The terms, each measured:
//
//	bounds          Browser.getWindowForTarget with NO targetId, sent on the
//	                attached page session, returns {windowId, bounds} in ONE
//	                call -- so there is no second getWindowBounds round trip and
//	                no need to keep the page target id (attachToPage does not).
//	                At browser level the same call fails ("No web contents in
//	                the target"), which is why it goes through `send`.
//	                left/top/height are DIP and invariant under the device
//	                scale factor.
//	cssLayout...    Page.getLayoutMetrics.cssLayoutViewport.clientHeight is the
//	                viewport height in CSS px (equal to window.innerHeight).
//	                cssVisualViewport is NOT used and that is load-bearing: it
//	                shrinks under pinch zoom (measured: clientHeight 437 -> 218.5
//	                at scale 2) and would have thrown the pointer on every
//	                pinch-zoomed page. The layout viewport is unchanged there.
//	zoom            cssVisualViewport.zoom, the CSS-px -> DIP ratio. Measured 1
//	                at every device scale factor, and measured NOT to be the
//	                pinch factor (pinch moves `scale` and leaves `zoom` at 1),
//	                which is exactly what is needed here. The term is
//	                dimensionally required rather than guessed -- without it a
//	                CSS-px offset is added to a DIP origin -- and it is a
//	                different animal from the devicePixelRatio multiply #585
//	                removed, which scaled an absolute screen coordinate.
//
// KNOWN INEXACTNESS, stated rather than hidden. cssLayoutViewport.clientHeight
// EXCLUDES scrollbars while the window height includes them, so on a page with
// a horizontal scrollbar the chrome height comes out one scrollbar too large and
// the point lands that far low: measured 158 vs 143, i.e. 15 CSS px, y only --
// there is no viewport-width term, so x is unaffected. There is no
// scrollbar-inclusive height anywhere in getLayoutMetrics
// (cssVisualViewport.clientHeight excludes it too), so recovering the term needs
// page script, which read authority forbids and 15 px does not justify. For
// scale: the pebble's own disc is 72x64, so it still covers the element.
//
// Also unverified: browser page zoom != 1 could not be produced headlessly
// (--headless=new ignores the profile's persisted zoom level), and x assumes all
// window chrome is vertical -- true for Chromium's own frame, but a Windows
// resizable border or a GTK client-side-decoration shadow would make
// bounds.left sit left of the client area. Both need a real desktop.
func (c *cdpClient) viewportScreenOrigin() (viewportOrigin, error) {
	raw, err := c.sendOnTimeout(c.sessionID, "Browser.getWindowForTarget", nil, elementPointReadTimeout)
	if err != nil {
		return viewportOrigin{}, fmt.Errorf("could not read the browser window's position: %w", err)
	}
	var win struct {
		Bounds struct {
			Left        *float64 `json:"left"`
			Top         *float64 `json:"top"`
			Height      *float64 `json:"height"`
			WindowState string   `json:"windowState"`
		} `json:"bounds"`
	}
	if err := json.Unmarshal(raw, &win); err != nil {
		return viewportOrigin{}, fmt.Errorf("unexpected Browser.getWindowForTarget reply: %w", err)
	}
	// Pointers, so an absent field is absent rather than silently 0. A window at
	// x=0 is ordinary; a reply that did not say where the window is, is not, and
	// the two must not look the same.
	if win.Bounds.Left == nil || win.Bounds.Top == nil || win.Bounds.Height == nil {
		return viewportOrigin{}, fmt.Errorf("the browser did not report its window bounds")
	}
	// A minimized window reports the bounds it would be RESTORED to, which is a
	// position it is not currently at -- the same class of answer as a headless
	// browser's, and refused for the same reason. "normal" and "fullscreen" and
	// "maximized" are all really on screen; only minimized is not. An empty
	// string is accepted because the field is optional in the protocol and every
	// measured reply filled it.
	if win.Bounds.WindowState == "minimized" {
		return viewportOrigin{}, fmt.Errorf("the browser window is minimized, so it has no position on the screen")
	}

	raw, err = c.sendOnTimeout(c.sessionID, "Page.getLayoutMetrics", nil, elementPointReadTimeout)
	if err != nil {
		return viewportOrigin{}, fmt.Errorf("could not read the page's viewport metrics: %w", err)
	}
	var metrics struct {
		CSSLayoutViewport struct {
			ClientWidth  *float64 `json:"clientWidth"`
			ClientHeight *float64 `json:"clientHeight"`
		} `json:"cssLayoutViewport"`
		CSSVisualViewport struct {
			Zoom *float64 `json:"zoom"`
		} `json:"cssVisualViewport"`
	}
	if err := json.Unmarshal(raw, &metrics); err != nil {
		return viewportOrigin{}, fmt.Errorf("unexpected Page.getLayoutMetrics reply: %w", err)
	}
	if metrics.CSSLayoutViewport.ClientHeight == nil || metrics.CSSLayoutViewport.ClientWidth == nil {
		return viewportOrigin{}, fmt.Errorf("the browser did not report the viewport size")
	}

	// An absent zoom is 1, which is what every measured reply reported; a
	// PRESENT but nonsensical one is refused rather than clamped, because it
	// multiplies every term in the answer and a silently corrected coordinate is
	// a confident wrong pointer.
	zoom := 1.0
	if metrics.CSSVisualViewport.Zoom != nil {
		zoom = *metrics.CSSVisualViewport.Zoom
	}
	if math.IsNaN(zoom) || math.IsInf(zoom, 0) || zoom < minElementPointZoom || zoom > maxElementPointZoom {
		return viewportOrigin{}, fmt.Errorf("the browser reported an unusable page zoom")
	}

	// The chrome height, between two readings in the SAME space: the window
	// height is DIP, the viewport height is CSS px, so the latter is converted
	// before subtracting.
	//
	// A NEGATIVE result is refused, not clamped to zero. A viewport taller than
	// the window it lives in cannot be true, so the two readings describe
	// different moments or different states -- which is the same signal the
	// windowState and headless checks above act on, and clamping would throw
	// away the only evidence of it while still answering a coordinate. Same
	// argument as the zoom guard: a silently corrected coordinate is a
	// confident wrong pointer.
	chrome := *win.Bounds.Height - *metrics.CSSLayoutViewport.ClientHeight*zoom
	if chrome < 0 {
		return viewportOrigin{}, fmt.Errorf("the browser reported a viewport taller than its own window")
	}
	return viewportOrigin{
		x:       *win.Bounds.Left,
		y:       *win.Bounds.Top + chrome,
		zoom:    zoom,
		clientW: *metrics.CSSLayoutViewport.ClientWidth,
		clientH: *metrics.CSSLayoutViewport.ClientHeight,
	}, nil
}
