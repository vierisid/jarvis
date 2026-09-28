package main

// browser_fetch_guard.go — in-browser enforcement of the local-file ban (#526),
// the sidecar's port of the daemon's src/actions/browser/browser-request-guard.ts.
//
// browser_url_policy.go refuses a file: URL before we hand it to Chrome. That
// covers one door: our own Page.navigate. This covers the rest, by failing the
// request inside Chrome whichever way it was started:
//
//   - file: anything. Chrome already refuses a web page's own attempts (script
//     navigation, iframes, fetch, redirects), so what is left is every
//     browser-initiated load that does not go through the allowlist: a future
//     caller that forgets the check, the user (or a desktop tool typing into the
//     address bar) on a HEADED automation browser, a redirect from a permitted
//     http: URL into file:, and any disagreement between net/url and Chrome's
//     own parser.
//   - the DevTools HTTP endpoints of the browsers Jarvis drives. This browser
//     has none of its own -- it speaks CDP over an inherited pipe, which is the
//     point of the pipe -- but a daemon on this same machine serves
//     `PUT /json/new?file:///...` on 9222/9223, and a page on that origin can
//     call it with a plain same-origin fetch. Chrome hands us the CANONICAL url
//     here, so the port patterns catch spellings the navigate-time check cannot
//     (an IDN host, a name like 127.0.0.1.nip.io that merely resolves to
//     loopback).
//
// Mechanism: CDP `Fetch.enable` on the BROWSER-level session -- for us the pipe
// itself, sessionID "". A browser-level interception applies to every tab,
// including tabs created after it and tabs the user opens by hand, where a
// page-level one would cover only the page it was enabled on. The patterns limit
// it to file: URLs and the DevTools ports, so ordinary web requests are never
// paused and cost nothing.
//
// WHAT THIS DOES NOT COVER: Fetch interception is HTTP(S)-only. A WebSocket
// handshake is never paused (verified: a page opening
// ws://127.0.0.1:9222/devtools/browser/<uuid> produces no requestPaused event),
// so blockedRequestReason's port branch is not what stops that route. What stops
// it is that the uuid lives behind /json/version, which this guard DOES block,
// plus Chrome's own origin checks on the DevTools websocket. A `filesystem:`
// URL makes no request at all (ERR_FILE_NOT_FOUND), so there is nothing to
// pause; the read guards cover a page that somehow shows one.
//
// Lifetime: the interception lives exactly as long as the pipe. When the pipe
// dies, cdpClient.fail() drops the cached client and the next browser tool call
// relaunches a browser with the guard armed again -- there is no path that keeps
// driving a browser whose guard has gone, which is what the daemon needs its
// reconnect logic for. One gap that leaves: if the pipe dies while a request is
// paused, Chrome CONTINUES it, so a file: load can commit with no guard
// involvement. The read-path guards (browser_read_guard.go) are the backstop for
// exactly that page.

import (
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// fetchGuardReplyTimeoutForTest bounds the one CDP call that answers a paused
// request. Short compared to cdpDefaultTimeout: Chrome is holding a request open
// while we decide, and if it has stopped listening there is nothing to wait for.
// Giving up is harmless -- the command is already on the wire, so Chrome acts on
// it whether or not we read the acknowledgement; only the log line is lost. A
// variable so the tests can shorten it; nothing else writes it.
var fetchGuardReplyTimeoutForTest = 10 * time.Second

// fetchGuardSlots bounds how many paused requests are being answered at once.
// The patterns are page-reachable text, so a page can pause thousands of
// requests (a few thousand <img src="http://x:9222/..."> will do it), and each
// answer is a CDP round-trip that queues on the one pipe write mutex every other
// CDP call needs -- without a bound, a page can push ordinary browser calls into
// their 30s timeout. Queueing costs nothing here: Chrome is already holding those
// requests, and they are still answered in order.
var fetchGuardSlots = make(chan struct{}, 32)

// blockedRequest is the last request the guard failed, kept so a navigation that
// died as ERR_BLOCKED_BY_CLIENT can be reported as what it was.
type blockedRequest struct {
	url          string
	reason       string
	resourceType string
	at           time.Time
}

// installFetchGuard arms browser-wide request interception. Call it before
// anything can navigate; the caller must NOT drive the browser if it fails.
func (c *cdpClient) installFetchGuard() error {
	_, err := c.sendOn("", "Fetch.enable", map[string]any{"patterns": fetchGuardPatterns()})
	return err
}

// handlePausedRequest answers one `Fetch.requestPaused`: fail it if it is a
// local file or a DevTools endpoint, continue it otherwise.
//
// MUST run off the read loop (readLoop starts it in its own goroutine). The
// answer is a CDP round-trip whose reply only the read loop can deliver, so
// answering inline would deadlock the connection on the first paused request.
// Every request that is not blocked is continued, including ones that matched a
// pattern only by accident -- the port patterns are wildcards over the URL text,
// so a ":9222" in a path reaches us -- because a request that is neither failed
// nor continued hangs the page load until Chrome gives up.
func (c *cdpClient) handlePausedRequest(sessionID string, params json.RawMessage) {
	fetchGuardSlots <- struct{}{}
	defer func() { <-fetchGuardSlots }()

	var ev struct {
		RequestID    string `json:"requestId"`
		ResourceType string `json:"resourceType"`
		Request      struct {
			URL string `json:"url"`
		} `json:"request"`
	}
	if err := json.Unmarshal(params, &ev); err != nil || ev.RequestID == "" {
		// Nothing to answer with. Chrome releases the request when the pipe
		// closes; until then this one load stalls, which is the safe direction.
		// The params are logged (truncated) because without them the line says
		// nothing: on the missing-requestId branch there is no error to print.
		log.Printf("[browser] guard could not read a paused request (err %v): %s",
			err, truncateURL(string(params), 200))
		return
	}

	if reason := blockedRequestReason(ev.Request.URL); reason != "" {
		c.recordBlocked(blockedRequest{
			url:          ev.Request.URL,
			reason:       reason,
			resourceType: ev.ResourceType,
			at:           time.Now(),
		})
		c.logBlocked(ev.Request.URL, ev.ResourceType, reason)
		if _, err := c.sendOnTimeout(sessionID, "Fetch.failRequest", map[string]any{
			"requestId":   ev.RequestID,
			"errorReason": "BlockedByClient",
		}, fetchGuardReplyTimeoutForTest); err != nil {
			log.Printf("[browser] guard could not fail %s: %v", truncateURL(ev.Request.URL, 200), err)
		}
		return
	}

	if _, err := c.sendOnTimeout(sessionID, "Fetch.continueRequest", map[string]any{
		"requestId": ev.RequestID,
	}, fetchGuardReplyTimeoutForTest); err != nil {
		// The request went away, or the pipe did. Logged rather than retried:
		// Chrome continues what it had paused when the connection closes.
		log.Printf("[browser] guard could not continue %s: %v", truncateURL(ev.Request.URL, 200), err)
	}
}

// blockLogInterval throttles the block log. A page can pause requests as fast as
// it can call fetch() -- 50,000 in thirteen seconds, measured -- and one log line
// each would push that through log's global mutex and bloat the sidecar log.
// Only the log is throttled: every request is still answered, because queueing
// the answers would hold legitimate paused requests behind a flood.
const blockLogInterval = time.Second

func (c *cdpClient) logBlocked(url, resourceType, reason string) {
	c.blockedMu.Lock()
	suppressed := c.blockedSuppressed
	quiet := time.Since(c.blockedLoggedAt) < blockLogInterval
	if quiet {
		c.blockedSuppressed++
	} else {
		c.blockedLoggedAt = time.Now()
		c.blockedSuppressed = 0
	}
	c.blockedMu.Unlock()
	if quiet {
		return
	}
	extra := ""
	if suppressed > 0 {
		extra = fmt.Sprintf(" (+%d more since the last line)", suppressed)
	}
	log.Printf("[browser] guard blocked %s (%s): %s%s",
		truncateURL(url, 200), resourceType, reason, extra)
}

func (c *cdpClient) recordBlocked(b blockedRequest) {
	c.blockedMu.Lock()
	c.lastBlocked = &b
	c.blockedMu.Unlock()
}

// blockedSince returns the last request the guard failed if it was failed at or
// after `since`, so a navigation only reports a block that belongs to it.
//
// BEST-EFFORT ATTRIBUTION, deliberately not load-bearing. The guard is
// browser-level and this is one slot, so the record can come from another tab or
// from a browser_navigate running concurrently in another RPC goroutine; the
// timestamp and the Document resource type narrow that but do not settle it. The
// consequence is a wrong URL in an error message, never a block that did not
// happen: the refusal itself is Chrome's ERR_BLOCKED_BY_CLIENT.
func (c *cdpClient) blockedSince(since time.Time) *blockedRequest {
	c.blockedMu.Lock()
	defer c.blockedMu.Unlock()
	if c.lastBlocked == nil || c.lastBlocked.at.Before(since) {
		return nil
	}
	b := *c.lastBlocked
	return &b
}

// describeBlockedNavigation turns Chrome's generic ERR_BLOCKED_BY_CLIENT into a
// message that says which URL was blocked and why -- the interesting case being
// a permitted http: URL that redirected into file:, where the URL the caller
// asked for is not the URL that was refused. Returns "" when the failure was
// something else, so the caller reports Chrome's own error text.
func (c *cdpClient) describeBlockedNavigation(target, errorText string, navigatedAt time.Time) string {
	if errorText != "net::ERR_BLOCKED_BY_CLIENT" {
		return ""
	}
	blocked := c.blockedSince(navigatedAt)
	if blocked == nil || blocked.resourceType != "Document" {
		return ""
	}
	if blocked.url == target {
		return fmt.Sprintf("navigation to %s was blocked: %s", truncateURL(target, 120), blocked.reason)
	}
	return fmt.Sprintf("navigation to %s was blocked: it led to %s, and %s",
		truncateURL(target, 120), truncateURL(blocked.url, 200), blocked.reason)
}
