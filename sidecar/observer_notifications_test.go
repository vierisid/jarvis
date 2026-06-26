package main

import "testing"

func feedAll(p *notifyParser, lines []string) []parsedNotification {
	var out []parsedNotification
	keep := func(n parsedNotification) {
		if n.Title == "" && n.Body == "" {
			return
		}
		out = append(out, n)
	}
	for _, l := range lines {
		if n, ok := p.feed(l); ok {
			keep(n)
		}
	}
	if n, ok := p.flush(); ok {
		keep(n)
	}
	return out
}

func TestNotifyParserSingle(t *testing.T) {
	lines := []string{
		`method call time=1.0 sender=:1.42 -> destination=org.freedesktop.Notifications serial=7 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify`,
		`   string "Slack"`,
		`   uint32 0`,
		`   string "slack-icon"`,
		`   string "New message"`,
		`   string "Hey there!"`,
		`   array [`,
		`   ]`,
		`   dict entry(`,
		`      string "urgency"`,
		`      variant             byte 2`,
		`   )`,
		`signal time=1.1 sender=:1.42 -> destination=(null) serial=8 path=/x; interface=y; member=Z`,
	}
	got := feedAll(&notifyParser{}, lines)
	if len(got) != 1 {
		t.Fatalf("expected 1 notification, got %d: %+v", len(got), got)
	}
	n := got[0]
	if n.App != "Slack" || n.Title != "New message" || n.Body != "Hey there!" || n.Urgency != "critical" {
		t.Fatalf("unexpected parse: %+v", n)
	}
}

func TestNotifyParserBackToBackAndFlush(t *testing.T) {
	lines := []string{
		`method call member=Notify`,
		`   string "App1"`,
		`   uint32 0`,
		`   string "icon"`,
		`   string "Title1"`,
		`   string "Body1"`,
		// No trailing signal — the next Notify closes the first, and flush() closes the second.
		`method call member=Notify`,
		`   string "App2"`,
		`   uint32 0`,
		`   string "icon"`,
		`   string "Title2"`,
		`   string "Body2"`,
		`      byte 1`,
	}
	got := feedAll(&notifyParser{}, lines)
	if len(got) != 2 {
		t.Fatalf("expected 2 notifications, got %d: %+v", len(got), got)
	}
	if got[0].App != "App1" || got[0].Title != "Title1" || got[0].Body != "Body1" {
		t.Fatalf("first notification wrong: %+v", got[0])
	}
	if got[1].App != "App2" || got[1].Title != "Title2" || got[1].Urgency != "normal" {
		t.Fatalf("second notification wrong: %+v", got[1])
	}
}

func TestNotifyParserDropsEmpty(t *testing.T) {
	// A Notify with no summary/body (e.g. an icon-only update) must be dropped.
	lines := []string{
		`method call member=Notify`,
		`   string "App"`,
		`   uint32 0`,
		`   string "icon"`,
		`signal member=Z`,
	}
	got := feedAll(&notifyParser{}, lines)
	if len(got) != 0 {
		t.Fatalf("expected 0 notifications, got %d: %+v", len(got), got)
	}
}
