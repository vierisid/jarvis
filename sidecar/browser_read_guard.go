package main

// browser_read_guard.go — nothing local is read back to the model (#526), the
// sidecar's port of BrowserController.assertNotLocalContent in the daemon's
// src/actions/browser/session.ts.
//
// The other two guards keep a local page from loading. This is the backstop for
// the cases they cannot see:
//
//   - a page already showing local content when we attached: the automation
//     profile's browser can be left on a file: page by a desktop tool typing
//     into a headed window's address bar, or by a session that predates these
//     guards;
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
// tree, not from script the page controls, so the page cannot lie about where
// it is -- unlike `location.href`, which is checked too, as a second line, in
// takePageSnapshot.

import (
	"encoding/json"
	"fmt"
)

// mainFrameURL is the URL of the attached page's main frame, as the BROWSER
// knows it.
func (c *cdpClient) mainFrameURL() (string, error) {
	raw, err := c.send("Page.getFrameTree", nil)
	if err != nil {
		return "", err
	}
	var tree struct {
		FrameTree struct {
			Frame struct {
				URL string `json:"url"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := json.Unmarshal(raw, &tree); err != nil {
		return "", fmt.Errorf("unexpected Page.getFrameTree reply: %w", err)
	}
	return tree.FrameTree.Frame.URL, nil
}

// assertNotLocalContent refuses to hand the model anything from a page showing
// local content. Fails closed: if the main frame cannot be established, the read
// does not happen.
func (c *cdpClient) assertNotLocalContent() error {
	url, err := c.mainFrameURL()
	if err != nil {
		return fmt.Errorf("could not check what the page is showing, so refusing to read it: %w", err)
	}
	return refuseLocalContent(url)
}

// refuseLocalContent is the shared refusal, so the frame-tree check and the
// snapshot's own URL check word it identically.
func refuseLocalContent(url string) error {
	if !isLocalContentURL(url) {
		return nil
	}
	return fmt.Errorf("Refusing to read %s: the browser does not show local files to the model",
		truncateURL(url, 200))
}
