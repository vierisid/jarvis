//go:build darwin

package main

import "log"

// macOS notifications land in their own increment. A native vibrancy card with
// inline actions (design §01) means UNUserNotificationCenter, which requires a
// bundled, code-signed app — the sidecar isn't always bundled, so it needs the
// .app packaging work first. For now log the trigger so the brain→sidecar path
// is verifiable end to end on a Mac.
func init() {
	showNotification = func(n Notification) {
		log.Printf("[notify] (macOS card TODO) %s: %s — %s", n.Kind, n.Title, n.Body)
	}
}
