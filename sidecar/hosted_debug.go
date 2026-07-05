//go:build jarvisdebug

package main

// Debug/staging builds (`go build -tags jarvisdebug`) honor JARVIS_HOSTED_URL
// and sidecar.yaml `hosted_base_url` so the handshake can point at a local or
// staging control plane.
const hostedOverrideAllowed = true
