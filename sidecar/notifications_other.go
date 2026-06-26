//go:build !linux

package main

import (
	"context"
	"log"
)

// platformWatchNotifications is a no-op on non-Linux platforms. Capturing
// notifications on Windows (WinRT UserNotificationListener) or macOS (the
// sandboxed NotificationCenter store) needs native APIs the sidecar does not
// yet implement, so checkNotifications reports the capability unavailable and
// this is only reached if it is force-enabled. It blocks until ctx is done so
// the observer goroutine stays parked rather than spinning.
func platformWatchNotifications(ctx context.Context, emit func(app, title, body, urgency string)) {
	log.Printf("[notifications] not supported on this platform; observer idle")
	<-ctx.Done()
}
