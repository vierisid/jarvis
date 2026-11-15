package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

// The notch's own tab.
//
// The notch reads the person's mail, calendar and files in this browser, where
// they are signed in, and it does so by itself, every few minutes. The browser
// has one page that the agent drives for the person (browser_navigate and the
// rest). If the notch used that page, a check of the mail would pull it out
// from under whatever the agent was doing there. So the notch has a tab of its
// own, beside that page, and two calls that reach it and nothing else:
// mail_tab_navigate and mail_tab_evaluate.
//
// What holds for this tab:
//
//   - It is taken to three sites and no other: Gmail, Google Calendar and
//     Google Drive (mailTabSites). An address anywhere else is refused before
//     the browser hears of it.
//   - A script runs in it only while it is on one of those three. Google sends
//     a browser that is not signed in to its sign-in page: there nothing is
//     run, and the answer says "signed out". Nothing is ever typed there.
//   - What a script returns is the page's text. It is cut like every other
//     reply a page controls (maxPageControlledReply).
//   - It never opens a window nobody asked for. When no browser is running one
//     is started hidden, and a browser started that way gives way to a visible
//     one the moment the agent's own page is asked for without a word about
//     visibility (getCDP).
//   - No events are asked of it. The client wakes whoever waits for an event by
//     the event's name alone, so an event from this tab would be taken for one
//     from the agent's page. A load is waited for by asking the tab.

// featureBrowserMailTab says this desktop app has the notch's own tab. The
// brain checks mail by itself only through a desktop app that says so.
const featureBrowserMailTab = "browser_mail_tab"

// mailTabSites are the hosts the tab is taken to, and what each is called in an
// answer. An answer names the site, never the address: the address can hold a
// search, a thread or a file.
var mailTabSites = map[string]string{
	"mail.google.com":     "mail",
	"calendar.google.com": "calendar",
	"drive.google.com":    "drive",
}

// What the brain reads in an error to know that the way through the browser is
// not there, as opposed to there and broken.
const (
	mailTabSignedOut = "mail tab: signed out"
	mailTabElsewhere = "mail tab: not on a site it reads"
)

// mailTabLoadBudget is how long a page of mail may take to come up.
var mailTabLoadBudget = 30 * time.Second

// mailTabEvaluateBudget is how long one script may run: a batch of threads is
// several pages fetched one after the other.
const mailTabEvaluateBudget = 90 * time.Second

// mailTabURL checks an address the tab is asked to go to and gives back the
// form the browser is handed. Only https, only the three hosts, no user and
// password in front of the host, no port.
func mailTabURL(raw string) (string, error) {
	input := strings.TrimSpace(raw)
	if input == "" || len(input) > 4000 || strings.ContainsAny(input, "\x00\r\n\t ") {
		return "", errors.New("mail tab: not an address")
	}
	parsed, err := url.Parse(input)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.Opaque != "" {
		return "", errors.New("mail tab: only an https address at Gmail, Google Calendar or Google Drive is opened here")
	}
	if _, ok := mailTabSites[strings.ToLower(parsed.Hostname())]; !ok {
		return "", errors.New("mail tab: only an https address at Gmail, Google Calendar or Google Drive is opened here")
	}
	return parsed.String(), nil
}

// mailTabSite names the site a host is: one of the three, "sign-in" for
// Google's sign-in page, "elsewhere" for anything else.
func mailTabSite(host string) string {
	host = strings.ToLower(host)
	if site, ok := mailTabSites[host]; ok {
		return site
	}
	if host == "accounts.google.com" {
		return "sign-in"
	}
	return "elsewhere"
}

// mailTabState is the one tab, and whose it is. A browser that was closed and
// started again has no such tab yet: it is opened again on the next call.
var mailTabState struct {
	mu      sync.Mutex // held for a whole call: the tab does one thing at a time
	client  *cdpClient
	session string
}

// openMailTab opens a tab in the background and gives the session to talk to
// it with. Nothing is enabled on it: see the note on events above.
func (c *cdpClient) openMailTab() (string, error) {
	raw, err := c.sendOn("", "Target.createTarget", map[string]any{"url": "about:blank", "background": true})
	if err != nil {
		return "", err
	}
	var made struct {
		TargetID string `json:"targetId"`
	}
	_ = json.Unmarshal(raw, &made)
	if made.TargetID == "" {
		return "", errors.New("mail tab: the browser opened no tab")
	}
	raw, err = c.sendOn("", "Target.attachToTarget", map[string]any{"targetId": made.TargetID, "flatten": true})
	if err != nil {
		return "", err
	}
	var att struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(raw, &att)
	if att.SessionID == "" {
		return "", errors.New("mail tab: attach returned no session")
	}
	return att.SessionID, nil
}

// mailTabText runs an expression in the tab and gives back what it returned as
// text. An exception in the page is an error, not an empty answer.
func (c *cdpClient) mailTabText(session, expression string, timeout time.Duration) (string, error) {
	raw, err := c.sendOnTimeout(session, "Runtime.evaluate", map[string]any{
		"expression":    expression,
		"returnByValue": true,
		"awaitPromise":  true,
	}, timeout)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("mail tab: parse reply: %w", err)
	}
	if parsed.ExceptionDetails != nil {
		return "", fmt.Errorf("JS error: %s", truncateMarked(string(parsed.ExceptionDetails), maxPageControlledReply))
	}
	if parsed.Result.Value == nil || string(parsed.Result.Value) == "null" {
		return "", nil
	}
	var asString string
	if json.Unmarshal(parsed.Result.Value, &asString) == nil {
		return asString, nil
	}
	return string(parsed.Result.Value), nil
}

// mailTabHost is the host the tab is on now, as the tab says it.
func (c *cdpClient) mailTabHost(session string) (string, error) {
	return c.mailTabText(session, "location.hostname", 5*time.Second)
}

// mailTabNavigate takes the tab to an address that mailTabURL has passed, waits
// for the page to be there, and says which site it landed on. Landing on the
// sign-in page is an answer, not an error: the caller is told "sign-in".
func (c *cdpClient) mailTabNavigate(session, target string) (string, error) {
	// The page that is there now is marked, so that the page that comes can be
	// told from it: both say "complete", and the old one goes on answering for
	// a moment after the browser has been told to leave it. A move inside the
	// same document (only the part after # differs) brings no new page, so
	// nothing is marked for it.
	current, _ := c.mailTabText(session, "location.href", 5*time.Second)
	newPage := !sameDocument(current, target)
	if newPage {
		_, _ = c.mailTabText(session, "window.__jarvisLeaving = true, ''", 5*time.Second)
	}
	raw, err := c.sendOn(session, "Page.navigate", map[string]any{"url": target})
	if err != nil {
		return "", fmt.Errorf("mail tab: navigate failed: %w", err)
	}
	var nav struct {
		ErrorText string `json:"errorText"`
	}
	_ = json.Unmarshal(raw, &nav)
	if nav.ErrorText != "" {
		return "", fmt.Errorf("mail tab: navigate failed: %s", truncateMarked(nav.ErrorText, 200))
	}
	// The load is asked for, not listened for.
	stop := time.Now().Add(mailTabLoadBudget)
	for {
		state, err := c.mailTabText(session, "(window.__jarvisLeaving || location.href === 'about:blank') ? '' : document.readyState", 5*time.Second)
		if err == nil && state == "complete" {
			break
		}
		if time.Now().After(stop) {
			// A page of mail that never says it is complete may still be usable:
			// the caller's own script decides, as the agent's navigate does.
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	host, err := c.mailTabHost(session)
	if err != nil {
		return "", fmt.Errorf("mail tab: the page did not say where it is: %w", err)
	}
	return mailTabSite(host), nil
}

// sameDocument says whether going from one address to the other stays in the
// same document: everything but the part after # is the same.
func sameDocument(from, to string) bool {
	cut := func(address string) string {
		if at := strings.Index(address, "#"); at >= 0 {
			return address[:at]
		}
		return address
	}
	return from != "" && cut(from) == cut(to)
}

// mailTabEvaluate runs a script in the tab, only while the tab is on one of its
// three sites, and gives back the text it returned, cut to what a page may say.
func (c *cdpClient) mailTabEvaluate(session, expression string) (string, error) {
	host, err := c.mailTabHost(session)
	if err != nil {
		return "", fmt.Errorf("mail tab: the page did not say where it is: %w", err)
	}
	switch mailTabSite(host) {
	case "sign-in":
		return "", errors.New(mailTabSignedOut)
	case "elsewhere":
		return "", errors.New(mailTabElsewhere)
	}
	text, err := c.mailTabText(session, expression, mailTabEvaluateBudget)
	if err != nil {
		return "", err
	}
	// What ran, ran on the page that was there. If the tab has since been sent
	// off the three sites, what came back is not handed on.
	after, err := c.mailTabHost(session)
	if err != nil {
		return "", fmt.Errorf("mail tab: the page did not say where it is: %w", err)
	}
	switch mailTabSite(after) {
	case "sign-in":
		return "", errors.New(mailTabSignedOut)
	case "elsewhere":
		return "", errors.New(mailTabElsewhere)
	}
	return truncateMarked(text, maxPageControlledReply), nil
}

// getCDPForMailTab gives the running browser, or starts one hidden: nobody
// asked for a window. It never changes how a running browser is shown.
func getCDPForMailTab(cfg *SidecarConfig) (*cdpClient, error) {
	activeCDP.mu.Lock()
	defer activeCDP.mu.Unlock()
	if c := activeCDP.client; c != nil && !c.closed.Load() {
		return c, nil
	}
	client, err := launchCDP(cfg, true)
	if err != nil {
		return nil, err
	}
	activeCDP.client = client
	activeCDP.startedForMailTab = client
	return client, nil
}

// withMailTab runs one call on the tab, opening it first when this browser has
// none, and once more when the tab it had is gone (the person closed it).
func withMailTab(cfg *SidecarConfig, do func(c *cdpClient, session string) (any, error)) (any, error) {
	mailTabState.mu.Lock()
	defer mailTabState.mu.Unlock()
	for attempt := 0; ; attempt++ {
		c, err := getCDPForMailTab(cfg)
		if err != nil {
			return nil, err
		}
		if mailTabState.client != c || mailTabState.session == "" {
			session, err := c.openMailTab()
			if err != nil {
				return nil, fmt.Errorf("mail tab: could not be opened: %w", err)
			}
			mailTabState.client, mailTabState.session = c, session
		} else if _, err := c.mailTabHost(mailTabState.session); err != nil && attempt == 0 {
			// The tab does not answer: it was closed. A new one, once.
			mailTabState.session = ""
			continue
		}
		return do(c, mailTabState.session)
	}
}

func makeMailTabNavigateHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		raw, _ := params["url"].(string)
		// Before the browser is started: an address that will be refused starts none.
		target, err := mailTabURL(raw)
		if err != nil {
			return nil, err
		}
		result, err := withMailTab(cfg, func(c *cdpClient, session string) (any, error) {
			site, err := c.mailTabNavigate(session, target)
			if err != nil {
				return nil, err
			}
			return map[string]any{"site": site}, nil
		})
		if err != nil {
			return nil, err
		}
		return &RPCResult{Result: result}, nil
	}
}

func makeMailTabEvaluateHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		expression, _ := params["expression"].(string)
		if expression == "" {
			return nil, errors.New("missing required parameter: expression")
		}
		result, err := withMailTab(cfg, func(c *cdpClient, session string) (any, error) {
			return c.mailTabEvaluate(session, expression)
		})
		if err != nil {
			return nil, err
		}
		return &RPCResult{Result: result}, nil
	}
}
