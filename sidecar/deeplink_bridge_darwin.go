//go:build darwin

package main

// C→Go bridge for macOS URL opens (separate file per the cgo //export rule).
// Runs on the Cocoa main thread when LaunchServices delivers a jarvis:// URL.
// Enroll links are re-routed through the SAME unix socket the first-run
// window listens on — one code path owns nonce-gating and serialization on
// every OS; no listener simply means no setup window is waiting, and the URI
// is dropped (matching maybeDropProtocolLaunch elsewhere). Off-thread because
// the forward dials a socket with deadlines and the Cocoa main thread must
// not block.

import "C"

import (
	"log"
	"strings"
)

//export goHandleURLOpen
func goHandleURLOpen(curl *C.char) {
	uri := C.GoString(curl)
	if !strings.HasPrefix(uri, enrollDeepLinkPrefix) {
		log.Printf("[deeplink] ignoring non-enroll URL open")
		return
	}
	go func() {
		if err := forwardEnrollDeepLink(uri); err != nil {
			log.Printf("[deeplink] URL open dropped: no setup window is waiting (%v)", err)
		}
	}()
}
