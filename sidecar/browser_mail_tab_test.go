package main

import (
	"strings"
	"testing"
	"time"
)

// The notch's own tab is driven over the same pipe as the agent's page, so it
// is tested the same way: a fake browser at the other end, no Chromium.

func TestMailTabURLOpensThreeGoogleSitesAndNothingElse(t *testing.T) {
	for _, ok := range []string{
		"https://mail.google.com/mail/u/0/#inbox",
		"https://calendar.google.com/calendar/u/0/r/week/2026/11/16?hl=en",
		"https://drive.google.com/drive/search?q=pricing%20deck&hl=en",
		"https://MAIL.google.com/mail/u/0/",
	} {
		if _, err := mailTabURL(ok); err != nil {
			t.Errorf("%s was refused: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"",
		"http://mail.google.com/mail/u/0/",           // not https
		"https://accounts.google.com/",               // the sign-in page is landed on, never gone to
		"https://docs.google.com/document/d/x",       // not one of the three
		"https://mail.google.com.evil.example/",      // a look-alike host
		"https://evil.example/?next=mail.google.com", // the name in the wrong place
		"https://mail.google.com@evil.example/",      // a user in front of another host
		"https://user:pass@mail.google.com/",         // a user and password
		"https://mail.google.com:8443/",              // a port
		"javascript:alert(1)",
		"file:///C:/Users/x/secret.txt",
		"https://mail.google.com/mail\nhttps://evil.example/",
		"mail.google.com/mail",
	} {
		if got, err := mailTabURL(bad); err == nil {
			t.Errorf("%q was let through as %q", bad, got)
		}
	}
}

func TestMailTabSiteNamesTheSiteAndNeverTheAddress(t *testing.T) {
	cases := map[string]string{
		"mail.google.com":     "mail",
		"CALENDAR.google.com": "calendar",
		"drive.google.com":    "drive",
		"accounts.google.com": "sign-in",
		"evil.example":        "elsewhere",
		"":                    "elsewhere",
	}
	for host, want := range cases {
		if got := mailTabSite(host); got != want {
			t.Errorf("mailTabSite(%q) = %q, want %q", host, got, want)
		}
	}
}

// answerValue replies to a Runtime.evaluate with a string value.
func (fb *fakeBrowser) answerValue(id int64, value string) {
	fb.t.Helper()
	fb.write(map[string]any{"id": id, "result": map[string]any{"result": map[string]any{"type": "string", "value": value}}})
}

func TestOpenMailTabOpensInTheBackgroundAndEnablesNothing(t *testing.T) {
	fb := newFakeBrowser(t)
	type opened struct {
		session string
		err     error
	}
	done := make(chan opened, 1)
	go func() { s, err := fb.client.openMailTab(); done <- opened{s, err} }()

	cmd := fb.nextCommand()
	if cmd.Method != "Target.createTarget" || cmd.SessionID != "" {
		t.Fatalf("first command is %q on session %q, want a browser-level Target.createTarget", cmd.Method, cmd.SessionID)
	}
	if cmd.Params["background"] != true || cmd.Params["url"] != "about:blank" {
		t.Fatalf("the tab was not opened blank and in the background: %v", cmd.Params)
	}
	fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{"targetId": "T-mail"}})

	cmd = fb.nextCommand()
	if cmd.Method != "Target.attachToTarget" || cmd.Params["targetId"] != "T-mail" || cmd.Params["flatten"] != true {
		t.Fatalf("second command is %q %v, want a flat attach to the new tab", cmd.Method, cmd.Params)
	}
	fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{"sessionId": "S-mail"}})

	got := <-done
	if got.err != nil || got.session != "S-mail" {
		t.Fatalf("openMailTab = %q, %v", got.session, got.err)
	}
	// Nothing more is sent: no Page.enable, no Runtime.enable. An event from
	// this tab would wake whoever waits for the agent's page.
	more := make(chan struct{}, 1)
	go func() {
		if data, _ := fb.fromCmd.Peek(1); len(data) > 0 {
			more <- struct{}{}
		}
	}()
	select {
	case <-more:
		t.Fatal("a command followed the attach: the tab must have nothing enabled on it")
	case <-time.After(150 * time.Millisecond):
	}
}

func TestMailTabEvaluateRunsOnlyOnItsThreeSites(t *testing.T) {
	fb := newFakeBrowser(t)
	type ran struct {
		text string
		err  error
	}
	run := func() chan ran {
		done := make(chan ran, 1)
		go func() { text, err := fb.client.mailTabEvaluate("S-mail", "the script"); done <- ran{text, err} }()
		return done
	}

	// Signed out: Google's sign-in page is where the tab is. The script is not sent.
	done := run()
	cmd := fb.nextCommand()
	if cmd.Method != "Runtime.evaluate" || cmd.SessionID != "S-mail" || cmd.Params["expression"] != "location.hostname" {
		t.Fatalf("the tab was not asked where it is first: %q %v on %q", cmd.Method, cmd.Params, cmd.SessionID)
	}
	fb.answerValue(cmd.ID, "accounts.google.com")
	if got := <-done; got.err == nil || got.err.Error() != mailTabSignedOut {
		t.Fatalf("on the sign-in page: %q, %v; want %q", got.text, got.err, mailTabSignedOut)
	}

	// Somewhere else altogether: refused the same way, with the other word.
	done = run()
	fb.answerValue(fb.nextCommand().ID, "evil.example")
	if got := <-done; got.err == nil || got.err.Error() != mailTabElsewhere {
		t.Fatalf("on another site: %q, %v; want %q", got.text, got.err, mailTabElsewhere)
	}

	// On Gmail: the script runs, on the tab's own session, and its text comes back.
	done = run()
	fb.answerValue(fb.nextCommand().ID, "mail.google.com")
	cmd = fb.nextCommand()
	if cmd.SessionID != "S-mail" || cmd.Params["expression"] != "the script" || cmd.Params["awaitPromise"] != true || cmd.Params["returnByValue"] != true {
		t.Fatalf("the script was not run as asked: %v on %q", cmd.Params, cmd.SessionID)
	}
	fb.answerValue(cmd.ID, "what the page said")
	fb.answerValue(fb.nextCommand().ID, "mail.google.com")
	if got := <-done; got.err != nil || got.text != "what the page said" {
		t.Fatalf("on Gmail: %q, %v", got.text, got.err)
	}

	// The tab left the three sites while the script ran: what came back is not handed on.
	done = run()
	fb.answerValue(fb.nextCommand().ID, "mail.google.com")
	fb.answerValue(fb.nextCommand().ID, "something read on the way out")
	fb.answerValue(fb.nextCommand().ID, "accounts.google.com")
	if got := <-done; got.err == nil || got.text != "" {
		t.Fatalf("after leaving: %q, %v; want nothing and an error", got.text, got.err)
	}
}

func TestMailTabEvaluateCutsWhatThePageSays(t *testing.T) {
	fb := newFakeBrowser(t)
	done := make(chan string, 1)
	go func() { text, _ := fb.client.mailTabEvaluate("S-mail", "the script"); done <- text }()
	fb.answerValue(fb.nextCommand().ID, "drive.google.com")
	fb.answerValue(fb.nextCommand().ID, strings.Repeat("x", maxPageControlledReply*3))
	fb.answerValue(fb.nextCommand().ID, "drive.google.com")
	if got := <-done; len([]rune(got)) > maxPageControlledReply+200 {
		t.Fatalf("a page's answer of %d characters was handed on whole", len([]rune(got)))
	}
}

func TestMailTabEvaluateReportsAScriptThatThrew(t *testing.T) {
	fb := newFakeBrowser(t)
	done := make(chan error, 1)
	go func() { _, err := fb.client.mailTabEvaluate("S-mail", "the script"); done <- err }()
	fb.answerValue(fb.nextCommand().ID, "mail.google.com")
	cmd := fb.nextCommand()
	fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{"exceptionDetails": map[string]any{"text": "Uncaught"}}})
	if err := <-done; err == nil || !strings.HasPrefix(err.Error(), "JS error:") {
		t.Fatalf("a script that threw came back as %v", err)
	}
}

func TestMailTabNavigateSaysWhereItLandedNotTheAddress(t *testing.T) {
	old := mailTabLoadBudget
	mailTabLoadBudget = 2 * time.Second
	t.Cleanup(func() { mailTabLoadBudget = old })

	fb := newFakeBrowser(t)
	type went struct {
		site string
		err  error
	}
	done := make(chan went, 1)
	go func() {
		site, err := fb.client.mailTabNavigate("S-mail", "https://mail.google.com/mail/u/0/")
		done <- went{site, err}
	}()

	cmd := fb.nextCommand()
	if cmd.Method != "Page.navigate" || cmd.SessionID != "S-mail" || cmd.Params["url"] != "https://mail.google.com/mail/u/0/" {
		t.Fatalf("navigate was %q %v on %q", cmd.Method, cmd.Params, cmd.SessionID)
	}
	fb.reply(cmd.ID)
	// Still loading, then there.
	fb.answerValue(fb.nextCommand().ID, "loading")
	fb.answerValue(fb.nextCommand().ID, "complete")
	// Google sent it to the sign-in page: that is an answer, not a failure.
	fb.answerValue(fb.nextCommand().ID, "accounts.google.com")
	got := <-done
	if got.err != nil || got.site != "sign-in" {
		t.Fatalf("navigate = %q, %v; want sign-in", got.site, got.err)
	}
}

func TestMailTabNavigateReportsAnAddressThatCouldNotBeReached(t *testing.T) {
	fb := newFakeBrowser(t)
	done := make(chan error, 1)
	go func() { _, err := fb.client.mailTabNavigate("S-mail", "https://mail.google.com/"); done <- err }()
	cmd := fb.nextCommand()
	fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{"errorText": "net::ERR_INTERNET_DISCONNECTED"}})
	if err := <-done; err == nil || !strings.Contains(err.Error(), "ERR_INTERNET_DISCONNECTED") {
		t.Fatalf("an unreachable address came back as %v", err)
	}
}

// The browser the notch starts hidden for its own tab must not become the
// browser the agent shows the person: a plain call for the agent's page still
// gets a visible one.
func TestHiddenBrowserStartedForTheMailTabGivesWayToAVisibleOne(t *testing.T) {
	cases := []struct {
		name                                                   string
		runningHeadless, startedForMailTab, headless, explicit bool
		keep                                                   bool
	}{
		{"the notch's hidden browser, a plain call for the agent's page", true, true, false, false, false},
		{"the notch's hidden browser, asked for hidden by name", true, true, true, true, true},
		{"the notch's hidden browser, asked for visible by name", true, true, false, true, false},
		{"a browser the agent started hidden, a plain call", true, false, false, false, true},
		{"a visible browser, a plain call", false, false, false, false, true},
		{"a visible browser, asked for hidden by name", false, false, true, true, false},
		{"a visible browser, asked for visible by name", false, false, false, true, true},
	}
	for _, tc := range cases {
		if got := keepRunningBrowser(tc.runningHeadless, tc.startedForMailTab, tc.headless, tc.explicit); got != tc.keep {
			t.Errorf("%s: keep = %v, want %v", tc.name, got, tc.keep)
		}
	}
}
