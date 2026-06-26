package main

import (
	"context"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// NotificationObserver streams desktop notifications to the brain. The actual
// capture is platform-specific (platformWatchNotifications): Linux/WSL reads
// the D-Bus session bus; other platforms are no-ops until a native listener
// lands (see checkNotifications in the per-platform preflight files).
//
// The emitted payload {app, title, body, urgency} matches the brain's old
// NotificationListener so the classifier, vault, and
// `observer.notification_received` workflow trigger keep working unchanged.
type NotificationObserver struct{}

func NewNotificationObserver() *NotificationObserver {
	return &NotificationObserver{}
}

func (o *NotificationObserver) Run(ctx context.Context, send EventSender) {
	emit := func(app, title, body, urgency string) {
		if title == "" && body == "" {
			return
		}
		if app == "" {
			app = "unknown"
		}
		if urgency == "" {
			urgency = "normal"
		}
		event := SidecarEvent{
			Type:      "sidecar_event",
			EventType: "notification",
			Timestamp: time.Now().UnixMilli(),
			Priority:  "normal",
			Payload: map[string]any{
				"app":     app,
				"title":   title,
				"body":    body,
				"urgency": urgency,
			},
		}
		if err := send(ctx, event, nil); err != nil {
			log.Printf("[notifications] Failed to send event: %v", err)
		}
	}

	platformWatchNotifications(ctx, emit)
}

// parsedNotification is one notification extracted from dbus-monitor output.
type parsedNotification struct {
	App     string
	Title   string
	Body    string
	Urgency string
}

var (
	notifStringRe = regexp.MustCompile(`^string\s+"(.*)"`)
	notifByteRe   = regexp.MustCompile(`byte\s+(\d+)`)
)

// notifyParser is a small state machine that turns dbus-monitor output lines
// for org.freedesktop.Notifications.Notify into parsedNotification values. It is
// platform-agnostic and pure (no I/O) so it can be unit-tested; the Linux D-Bus
// reader feeds it line by line.
//
// Among a Notify call's string arguments, index 0 is app_name, 1 is the icon
// (skipped), 2 is the summary (title), and 3 is the body; the urgency hint
// arrives as a byte (2=critical, 1=normal, 0=low).
type notifyParser struct {
	inCall      bool
	stringIndex int
	cur         parsedNotification
}

// feed processes one raw line. When a line closes a Notify block (the next
// method call / signal / method return), it returns the completed notification
// with ok=true. The caller decides whether to emit it (e.g. dropping ones with
// empty title and body).
func (p *notifyParser) feed(line string) (parsedNotification, bool) {
	line = strings.TrimSpace(line)

	isNotify := strings.HasPrefix(line, "method call") && strings.Contains(line, "member=Notify")
	if isNotify {
		done := p.cur
		hadPrev := p.inCall
		p.inCall = true
		p.stringIndex = 0
		p.cur = parsedNotification{}
		return done, hadPrev
	}
	if p.inCall && (strings.HasPrefix(line, "method call") ||
		strings.HasPrefix(line, "signal") ||
		strings.HasPrefix(line, "method return")) {
		done := p.cur
		p.inCall = false
		p.stringIndex = 0
		p.cur = parsedNotification{}
		return done, true
	}
	if !p.inCall {
		return parsedNotification{}, false
	}

	if m := notifStringRe.FindStringSubmatch(line); m != nil {
		switch p.stringIndex {
		case 0:
			p.cur.App = m[1]
		case 2:
			p.cur.Title = m[1]
		case 3:
			p.cur.Body = m[1]
		}
		p.stringIndex++
		return parsedNotification{}, false
	}
	if m := notifByteRe.FindStringSubmatch(line); m != nil {
		if lvl, err := strconv.Atoi(m[1]); err == nil {
			switch lvl {
			case 2:
				p.cur.Urgency = "critical"
			case 1:
				p.cur.Urgency = "normal"
			default:
				p.cur.Urgency = "low"
			}
		}
	}
	return parsedNotification{}, false
}

// flush returns any in-progress notification when the stream ends.
func (p *notifyParser) flush() (parsedNotification, bool) {
	if p.inCall {
		p.inCall = false
		return p.cur, true
	}
	return parsedNotification{}, false
}
