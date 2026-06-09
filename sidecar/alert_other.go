//go:build !windows && !darwin

package main

import "log"

// platformShowAlert has no native dialog on this platform (Linux is the
// brain/dev host and usually headless for the sidecar), so surface it loudly in
// the log instead.
func platformShowAlert(title, message string) {
	log.Printf("[alert] %s: %s", title, message)
}
