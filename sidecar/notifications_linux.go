//go:build linux

package main

import (
	"bufio"
	"context"
	"log"
	"os/exec"
)

// platformWatchNotifications watches the D-Bus session bus for
// org.freedesktop.Notifications.Notify method calls and forwards each parsed
// notification via emit. Line parsing lives in notifyParser (observer_
// notifications.go) so it can be unit-tested independently of the process I/O.
//
// Graceful: if dbus-monitor can't start, it logs and returns. Preflight already
// gates the capability on dbus-monitor being present.
func platformWatchNotifications(ctx context.Context, emit func(app, title, body, urgency string)) {
	cmd := exec.CommandContext(ctx, "dbus-monitor", "--session",
		"interface='org.freedesktop.Notifications',member='Notify'")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Printf("[notifications] stdout pipe failed: %v", err)
		return
	}
	if err := cmd.Start(); err != nil {
		log.Printf("[notifications] failed to start dbus-monitor: %v", err)
		return
	}
	log.Printf("[notifications] Monitoring D-Bus notifications")

	emitIfNotEmpty := func(n parsedNotification) {
		if n.Title == "" && n.Body == "" {
			return
		}
		emit(n.App, n.Title, n.Body, n.Urgency)
	}

	parser := &notifyParser{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if n, ok := parser.feed(scanner.Text()); ok {
			emitIfNotEmpty(n)
		}
	}
	if n, ok := parser.flush(); ok {
		emitIfNotEmpty(n)
	}
	_ = cmd.Wait()
}
