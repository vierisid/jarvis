package main

// browser_read_guard.go — nothing local is read back to the model (#526), the
// sidecar's port of BrowserController.assertNotLocalContent in the daemon's
// src/actions/browser/session.ts.
//
// The other two guards keep a local page from loading. This is the backstop for
// the cases they cannot see:
//
//   - a page already showing local content when we attached: the automation
//     profile is a persistent directory, so a restored session can put the tab
//     on a file: page, and a desktop tool can type one into a headed window's
//     address bar;
//   - a document restored from the back/forward cache, where no request is made
//     and so nothing is paused;
//   - a load that slipped through because the pipe died while a request was
//     paused (Chrome continues what it had paused when the connection closes).
//
// MAIN FRAME, NOT TARGET, AND NOT SUBFRAMES. `Page.getFrameTree` returns the
// attached page's main frame in `frameTree.frame` and its children under
// `childFrames`; only the main frame decides. A web page cannot create a file:
// iframe (Chrome refuses it, and the Fetch guard fails the request anyway), so
// refusing a whole page because some descendant frame failed to load would
// refuse ordinary pages for no gain. The URL comes from the browser's frame
// tree, not from script the page controls, so the page cannot lie about where it
// is -- unlike `location.href`, which is checked too, as a second line, in
// takePageSnapshot and the AX snapshot.
//
// CHECK, READ, CHECK AGAIN. The check and the read are two CDP round-trips, and
// the sidecar dispatches every RPC on its own goroutine, so between them the
// main frame can commit a different document -- a slow navigation landing, a meta
// refresh, or a concurrent browser_navigate. So the check returns the page's
// IDENTITY (its loaderId, which changes on every commit, same URL or not) and
// the read paths hold it against the page afterwards, discarding anything read
// across a commit. Without that, the backstop can be stepped over by a race
// instead of by a bypass.

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// pageIdentity is which document the attached page was showing, as the BROWSER
// reported it. A new loaderId means a different document, even at the same URL.
type pageIdentity struct {
	url      string
	loaderID string
	origin   string
	// The main frame's id, for the one caller that needs to address the frame
	// rather than describe it: Page.createIsolatedWorld is per-frame (#592).
	// Deliberately NOT part of what makes two identities equal -- the frame id
	// is stable across navigations in the same tab, so comparing it would say
	// "same page" about two different documents.
	frameID string
}

// pageIdentityNow reads the attached page's main frame.
//
// Do NOT "simplify" this onto the page's own `location.href` (which the snapshot
// script already reports): a page can be talked into lying about that, and the
// whole point of asking the browser is that it cannot.
func (c *cdpClient) pageIdentityNow() (pageIdentity, error) {
	raw, err := c.send("Page.getFrameTree", nil)
	if err != nil {
		return pageIdentity{}, err
	}
	var tree struct {
		FrameTree struct {
			Frame struct {
				URL            string `json:"url"`
				LoaderID       string `json:"loaderId"`
				SecurityOrigin string `json:"securityOrigin"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := json.Unmarshal(raw, &tree); err != nil {
		return pageIdentity{}, fmt.Errorf("unexpected Page.getFrameTree reply: %w", err)
	}
	f := tree.FrameTree.Frame
	return pageIdentity{url: f.URL, loaderID: f.LoaderID, origin: f.SecurityOrigin}, nil
}

// mainFrameURL is the URL of the attached page's main frame. For callers that
// only need to know where the tab is (the adopted-tab check at launch).
func (c *cdpClient) mainFrameURL() (string, error) {
	id, err := c.pageIdentityNow()
	return id.url, err
}

// assertNotLocalContent refuses to hand the model anything from a page showing
// local content, and returns the identity of the document it approved so the
// caller can prove the bytes it then read came from that same document. Fails
// closed: if the main frame cannot be established, the read does not happen.
func (c *cdpClient) assertNotLocalContent() (pageIdentity, error) {
	id, err := c.pageIdentityNow()
	if err != nil {
		return id, fmt.Errorf("could not check what the page is showing, so refusing to read it: %w", err)
	}
	return id, refuseLocalIdentity(id)
}

// refuseLocalIdentity is the decision on one frame-tree reading. Kept separate so
// each check costs exactly one round-trip: a page that is holding a request open
// should not wait on two.
func refuseLocalIdentity(id pageIdentity) error {
	if err := refuseLocalContent(id.url); err != nil {
		return err
	}
	// Belt and braces for an origin the URL does not reveal: a blob:, about:blank
	// or srcdoc document INHERITS the origin of whatever created it, so a local
	// document can wear a URL that matches none of the prefixes above. An
	// ordinary page reports its own scheme+host here, about:blank and data:
	// report "://", and a local document reports a file: origin.
	if strings.HasPrefix(strings.ToLower(id.origin), "file:") {
		return fmt.Errorf("Refusing to read %s: it has a local-file origin, and the browser does "+
			"not show local files to the model.", truncateURL(id.url, 200))
	}
	return nil
}

// assertSamePage refuses when the attached page has committed a different
// document since `before` was taken -- the read raced a navigation, and whatever
// was read may have come from a page nobody checked.
func (c *cdpClient) assertSamePage(before pageIdentity) error {
	now, err := c.pageIdentityNow()
	if err != nil {
		return fmt.Errorf("could not confirm the page did not change while it was read: %w", err)
	}
	if now.loaderID != before.loaderID || now.url != before.url {
		return fmt.Errorf("the page navigated to %s while it was being read, so the result is discarded; "+
			"try again", truncateURL(now.url, 200))
	}
	// Same document, and it is still one we may read -- decided on the reading we
	// just took, so this is one round-trip, not two.
	return refuseLocalIdentity(now)
}

// confirmSameDocument refuses when the attached page has committed a different
// DOCUMENT since `before` was taken. It is `assertSamePage` without the URL
// term, and the difference is the whole reason it exists.
//
// `assertSamePage` guards a READ: it hands a URL back, so a URL that changed
// makes the answer wrong, and refusing costs one retry. This guards a use of
// something minted under a document -- a cached element coordinate, an element
// reference in an isolated world -- where the question is only "is this the
// same document those were minted in".
//
// Dropping the URL term is not a relaxation, it is the correct question. A
// same-document `history.pushState` CHANGES `frameTree.frame.url` while the
// loaderId holds (measured), and that is how every SPA navigates -- Gmail,
// Linear, Notion, and the cell-to-cell moves `webapp-templates/gsheets.yaml`
// tells the model to reuse an element id across. Comparing the URL here would
// refuse an ordinary click on exactly the sites the playbooks are written for,
// to protect a field the caller is not given. A fragment change does not even
// reach this: CDP reports it separately as `urlFragment`.
//
// The daemon already compares the loaderId alone for this purpose
// (`sameDocument` in BrowserController.snapshot, src/actions/browser/session.ts),
// so this is parity with the other half rather than a new rule.
//
// An EMPTY loaderId is refused outright. `assertSamePage` compares two empty
// ids as equal, so a frame tree that named no document would pass it; a guard
// that cannot tell which document it is looking at has nothing to offer.
// It returns the fresh identity and the whole-tree frame digest from the SAME
// round trip, and it takes its own timeout, for two reasons that both come from
// being a use-time guard rather than a read-time one. A caller that also has to
// check whether a subframe navigated would otherwise read the frame tree twice
// to learn one thing, and a caller on a latency budget -- the pebble narration
// is abandoned upstream after 1200 ms -- cannot inherit `cdpDefaultTimeout`'s
// 30 seconds for a renderer-served read that an `alert()` can block.
func (c *cdpClient) confirmSameDocument(before pageIdentity, timeout time.Duration) (pageIdentity, string, error) {
	if before.loaderID == "" {
		return pageIdentity{}, "", fmt.Errorf("the browser did not name the document these coordinates came from, so they cannot be used")
	}
	now, stamp, err := c.frameTreeState(timeout)
	if err != nil {
		return pageIdentity{}, "", fmt.Errorf("could not confirm the page is still the same document: %w", err)
	}
	if now.loaderID == "" {
		return pageIdentity{}, "", fmt.Errorf("the browser no longer names the document, so the page cannot be confirmed")
	}
	if now.loaderID != before.loaderID {
		return pageIdentity{}, "", fmt.Errorf("the page navigated to a new document, so the element from the previous " +
			"snapshot no longer exists; take a new browser_snapshot")
	}
	// Same document, and it is still one we may touch -- decided on the reading
	// just taken, so this is one round-trip and not two.
	if err := refuseLocalIdentity(now); err != nil {
		return pageIdentity{}, "", err
	}
	return now, stamp, nil
}

// refuseLocalContent is the shared refusal, so the frame-tree check and the
// page-reported URL checks word it identically. Trailing full stop and all: the
// daemon's message reads the same way.
func refuseLocalContent(url string) error {
	if isLocalContentURL(url) {
		return fmt.Errorf("Refusing to read %s: the browser does not show local files to the model.",
			truncateURL(url, 200))
	}
	// Beyond the daemon, and beyond the three prefixes #526 names: the browser's
	// own pages (chrome://settings/passwords, chrome://history, devtools://) are
	// not local files but are worth as much, and a headed automation browser has
	// an address bar. See privilegedPagePrefixes.
	if isPrivilegedPageURL(url) {
		return fmt.Errorf("Refusing to read %s: the browser does not show its own internal pages to the model.",
			truncateURL(url, 200))
	}
	return nil
}
