package main

// The browser read reply's shape (#583). No browser needed: the decisions worth
// pinning are which fields go on the wire and when, and those are pure.

import (
	"encoding/json"
	"strings"
	"testing"
)

// The invariant, end to end over the fake CDP pipe: `page_url` is the FRAME
// TREE's url, never the one the page reports about itself.
//
// This is #572/#579 on the sidecar side. The page below claims to be
// `https://mail.google.com/` in its own `location.href` while the browser says
// it is on `https://attacker.example/`. Before #583 the brain recovered the URL
// by regexing the rendered text, where the page's claim is what appears -- so a
// page chose its own playbook. The reply must carry the browser's answer, and
// the page's claim must survive only as text inside the untrusted block.
func TestSnapshotHandlerReportsTheFrameTreeUrlNotThePagesClaim(t *testing.T) {
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)

	type outcome struct {
		res *RPCResult
		err error
	}
	done := make(chan outcome, 1)
	handler := makeBrowserSnapshotHandler(guardTestConfig())
	go func() {
		res, err := handler(map[string]any{"page_identity": true})
		done <- outcome{res, err}
	}()

	// CHECK: the browser is asked where it is, before anything runs in the page.
	frameTree := fb.nextCommand()
	if frameTree.Method != "Page.getFrameTree" {
		t.Fatalf("first command was %q, want Page.getFrameTree", frameTree.Method)
	}
	fb.frameTreeReplyFull(frameTree.ID, "https://attacker.example/", "LOADER-A", "https://attacker.example")

	// The isolated world the element refs go in (#592) -- minted before the
	// script runs, because the script must not run in the page's own world.
	fb.expectIsolatedWorld()

	// READ: the page answers, and lies about which site it is.
	script := fb.nextCommand()
	if script.Method != "Runtime.evaluate" {
		t.Fatalf("second command was %q, want Runtime.evaluate", script.Method)
	}
	fb.write(map[string]any{
		"id": script.ID,
		"result": map[string]any{
			"result": map[string]any{
				"type":  "string",
				"value": `{"title":"Inbox","url":"https://mail.google.com/","text":"hello","elements":[]}`,
			},
		},
	})

	// CHECK AGAIN: same document, so the read stands.
	after := fb.nextCommand()
	if after.Method != "Page.getFrameTree" {
		t.Fatalf("third command was %q, want the second Page.getFrameTree", after.Method)
	}
	fb.frameTreeReplyFull(after.ID, "https://attacker.example/", "LOADER-A", "https://attacker.example")

	got := <-done
	if got.err != nil {
		t.Fatalf("snapshot failed: %v", got.err)
	}
	reply := replyJSON(t, got.res)
	if reply["page_url"] != "https://attacker.example/" {
		t.Fatalf("page_url = %v, want the frame tree's url", reply["page_url"])
	}
	if reply["loader_id"] != "LOADER-A" {
		t.Fatalf("loader_id = %v", reply["loader_id"])
	}
	// The page's claim really is in the text -- so this test would pass for the
	// wrong reason if the claim were simply absent.
	text, _ := reply["text"].(string)
	if !strings.Contains(text, "URL: https://mail.google.com/") {
		t.Fatalf("the page's own claim should still be rendered as text:\n%s", text)
	}
}

// NAVIGATE is the handler this whole issue exists for, so it gets the same test
// with the knife turned the other way: the URL the caller ASKED for is available
// here, and it must never be the one reported.
//
// #583 spells out why, and it is not hypothetical: the requested URL is
// pre-redirect, open redirects are ordinary on exactly the hosts site playbooks
// are written for, and the playbook announces "You are now on <host>" OUTSIDE
// the untrusted block. A redirect would put that sentence over a page that is
// not that host, which is worse than naming no site at all.
//
// So this navigates to one host and lands on another, and asserts BOTH
// directions: the reported identity is the landed document, and it is not the
// request. The negative matters as much as the positive -- with equal URLs the
// test would pass for either implementation.
func TestNavigateHandlerReportsTheLandedUrlNotTheRequestedOne(t *testing.T) {
	const requested = "https://redirector.example/go"
	const landed = "https://attacker.example/landed"

	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)

	type outcome struct {
		res *RPCResult
		err error
	}
	done := make(chan outcome, 1)
	handler := makeBrowserNavigateHandler(guardTestConfig())
	go func() {
		res, err := handler(map[string]any{"url": requested, "page_identity": true})
		done <- outcome{res, err}
	}()

	// The navigation itself. Chrome reports network failures in `errorText`
	// rather than as a protocol error, so an empty result is success.
	nav := fb.nextCommand()
	if nav.Method != "Page.navigate" {
		t.Fatalf("first command was %q, want Page.navigate", nav.Method)
	}
	fb.reply(nav.ID)
	// ...and the page finishes loading somewhere else entirely.
	fb.write(map[string]any{"method": "Page.loadEventFired"})

	// Then the ordinary check-read-check, which is where the identity comes from.
	frameTree := fb.nextCommand()
	if frameTree.Method != "Page.getFrameTree" {
		t.Fatalf("after navigating, the next command was %q, want Page.getFrameTree", frameTree.Method)
	}
	fb.frameTreeReplyFull(frameTree.ID, landed, "LOADER-L", "https://attacker.example")

	fb.expectIsolatedWorld()

	script := fb.nextCommand()
	if script.Method != "Runtime.evaluate" {
		t.Fatalf("command was %q, want Runtime.evaluate", script.Method)
	}
	fb.write(map[string]any{
		"id": script.ID,
		"result": map[string]any{
			"result": map[string]any{
				"type": "string",
				// The page claims the requested host as well, so neither the
				// request nor the rendering can be the source of the answer.
				"value": `{"title":"Welcome","url":"https://redirector.example/go","text":"hi","elements":[]}`,
			},
		},
	})

	after := fb.nextCommand()
	fb.frameTreeReplyFull(after.ID, landed, "LOADER-L", "https://attacker.example")

	got := <-done
	if got.err != nil {
		t.Fatalf("navigate failed: %v", got.err)
	}
	reply := replyJSON(t, got.res)
	if reply["page_url"] != landed {
		t.Fatalf("page_url = %v, want the landed url %q", reply["page_url"], landed)
	}
	if reply["page_url"] == requested {
		t.Fatalf("page_url is the REQUESTED url; a redirect would mis-select a site playbook")
	}
	if reply["loader_id"] != "LOADER-L" {
		t.Fatalf("loader_id = %v", reply["loader_id"])
	}
}

// A document that commits under the read is refused outright, so no identity is
// reported for bytes that came from somewhere else. The daemon's local path
// answers the same question with a null `browserUrl`; here the whole read goes.
func TestSnapshotHandlerRefusesWhenTheDocumentChangedUnderIt(t *testing.T) {
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)

	done := make(chan error, 1)
	handler := makeBrowserSnapshotHandler(guardTestConfig())
	go func() {
		_, err := handler(map[string]any{"page_identity": true})
		done <- err
	}()

	frameTree := fb.nextCommand()
	fb.frameTreeReplyFull(frameTree.ID, "https://app.example.com/", "LOADER-A", "https://app.example.com")

	fb.expectIsolatedWorld()

	script := fb.nextCommand()
	fb.write(map[string]any{
		"id": script.ID,
		"result": map[string]any{
			"result": map[string]any{
				"type":  "string",
				"value": `{"title":"x","url":"https://app.example.com/","text":"hello","elements":[]}`,
			},
		},
	})

	// Same URL, new loaderId: a different document at the same address, which is
	// exactly the case a URL comparison alone would miss.
	after := fb.nextCommand()
	fb.frameTreeReplyFull(after.ID, "https://app.example.com/", "LOADER-B", "https://app.example.com")

	err := <-done
	if err == nil {
		t.Fatal("a read across a document commit was returned")
	}
	if !strings.Contains(err.Error(), "navigated to") {
		t.Fatalf("refusal %q does not say the page changed", err)
	}
}

const replyText = "Page: Fixture\nURL: https://app.example.com/inbox\n\n--- Page Text ---\nhi"

func goodIdentity() pageIdentity {
	return pageIdentity{url: "https://app.example.com/inbox", loaderID: "9A1F2C", origin: "https://app.example.com"}
}

// decode the RPCResult's payload the way sendResult marshals it, so the test
// reads the actual JSON the brain receives rather than the Go struct.
func replyJSON(t *testing.T, res *RPCResult) map[string]any {
	t.Helper()
	raw, err := json.Marshal(res.Result)
	if err != nil {
		t.Fatalf("marshal reply: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("reply is not a JSON object (%s): %v", raw, err)
	}
	return out
}

// A brain that did not ask keeps getting exactly what it got before: one string.
// This is the half of the change that lets an OLDER daemon talk to a NEWER
// sidecar -- it never sends the flag, so it never sees the object and never
// JSON-stringifies a snapshot into the model's context.
func TestPageResultIsABareStringWhenNotAsked(t *testing.T) {
	for name, params := range map[string]map[string]any{
		"no params":        {},
		"flag false":       {"page_identity": false},
		"flag not a bool":  {"page_identity": "true"},
		"flag is a number": {"page_identity": 1},
	} {
		t.Run(name, func(t *testing.T) {
			res := browserPageResult(replyText, goodIdentity(), "", params)
			got, ok := res.Result.(string)
			if !ok {
				t.Fatalf("result is %T, want string: %+v", res.Result, res.Result)
			}
			if got != replyText {
				t.Fatalf("text changed:\n got %q\nwant %q", got, replyText)
			}
		})
	}
}

// Asked for, and the browser named the document: both fields travel, and the
// text is byte-identical to the string reply. Parity is the premise of the whole
// sidecar snapshot path, so the object must not reformat anything.
func TestPageResultCarriesTheConfirmedIdentity(t *testing.T) {
	res := browserPageResult(replyText, goodIdentity(), "", map[string]any{"page_identity": true})
	got := replyJSON(t, res)
	if got["text"] != replyText {
		t.Fatalf("text = %q, want %q", got["text"], replyText)
	}
	if got["page_url"] != "https://app.example.com/inbox" {
		t.Fatalf("page_url = %v", got["page_url"])
	}
	if got["loader_id"] != "9A1F2C" {
		t.Fatalf("loader_id = %v", got["loader_id"])
	}
	// The origin stays here. Nothing on the brain reads it, and a field nobody
	// consumes is a field nobody validates.
	if _, ok := got["origin"]; ok {
		t.Fatalf("origin should not be on the wire: %v", got)
	}
}

// The identity is dropped as a PAIR whenever it cannot be trusted to name this
// document. Each case below would otherwise hand the brain a URL it would then
// resolve a playbook from.
func TestPageResultOmitsAnIdentityItCannotVouchFor(t *testing.T) {
	cases := map[string]pageIdentity{
		// No loaderID: an unnamed document cannot be vouched for. #603 also
		// made `assertSamePage` refuse an empty id, so a read no longer gets
		// this far -- this holds the REPLY to the same rule independently of
		// which guard ran. The daemon's local path refuses it too
		// (`before.loaderId !== ''`), and the three must agree.
		"no loader id": {url: "https://app.example.com/", loaderID: ""},
		// Over the wire bound: a `data:` document's frame-tree URL can be
		// megabytes and would push the event past the brain's 2 MB cap, which
		// drops the whole reply and loses the page text as well.
		"url past the wire bound": {url: "https://app.example.com/" + strings.Repeat("a", maxWirePageURL), loaderID: "9A1F2C"},
		// A loader id is a short hex string; anything else is a malfunction, and
		// the same cap argument applies.
		"loader id past the wire bound": {url: "https://app.example.com/", loaderID: strings.Repeat("b", maxWireLoaderID+1)},
	}
	for name, id := range cases {
		t.Run(name, func(t *testing.T) {
			got := replyJSON(t, browserPageResult(replyText, id, "", map[string]any{"page_identity": true}))
			// The text still goes: losing a playbook is the cost, losing the page
			// would be a regression.
			if got["text"] != replyText {
				t.Fatalf("text = %q, want the page", got["text"])
			}
			if _, ok := got["page_url"]; ok {
				t.Fatalf("page_url travelled anyway: %v", got["page_url"])
			}
			if _, ok := got["loader_id"]; ok {
				t.Fatalf("loader_id travelled without a url: %v", got["loader_id"])
			}
		})
	}
}

// A URL exactly on the bound travels: this check is a SIZE GUARD, not a policy.
//
// Which is also why the exact number here costs nothing: the daemon's own
// `MAX_LOOKUP_URL_LENGTH` is 2048, so anything between that and this bound
// crosses the wire and is refused there anyway. The off-by-one that could cost a
// real playbook is the daemon's, not this one -- what this pins is that the two
// numbers are not a pair to keep in step.
func TestPageResultAcceptsTheBoundExactly(t *testing.T) {
	url := "https://app.example.com/" + strings.Repeat("a", maxWirePageURL-len("https://app.example.com/"))
	if len(url) != maxWirePageURL {
		t.Fatalf("fixture is %d bytes, want %d", len(url), maxWirePageURL)
	}
	got := replyJSON(t, browserPageResult(replyText, pageIdentity{url: url, loaderID: "9A1F2C"}, "",
		map[string]any{"page_identity": true}))
	if got["page_url"] != url {
		t.Fatalf("a URL on the bound was dropped")
	}
}

// Hostile-looking URLs are NOT filtered here, and that is deliberate: the daemon
// owns URL policy in `usablePageUrl`, and a second validator in another language
// is how the two drift apart. This pins the division of labour so nobody "fixes"
// it by adding a scheme check here and assuming the brain's is now redundant.
func TestPageResultDoesNotSecondGuessUrlPolicy(t *testing.T) {
	for _, url := range []string{
		"data:text/html,<h1>x</h1><!--.app.example.com",
		"about:blank",
		"blob:https://evil.example/x",
	} {
		got := replyJSON(t, browserPageResult(replyText, pageIdentity{url: url, loaderID: "9A1F2C"}, "",
			map[string]any{"page_identity": true}))
		if got["page_url"] != url {
			t.Fatalf("page_url = %v, want %q verbatim (the brain refuses it, not us)", got["page_url"], url)
		}
	}
}
