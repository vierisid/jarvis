//go:build !jarvisdebug

package main

import "github.com/jarvis/sidecar/internal/update"

// updateRegistryURL is the only payload source a release build updates from:
// no config or environment override, so a tampered sidecar.yaml or
// environment cannot point the updater at another registry. (The sha512 and
// signature pins would still refuse a foreign payload; this keeps the source
// fixed as well.) `-tags jarvisdebug` builds may override it for testing.
func updateRegistryURL() string { return update.DefaultRegistryURL }
