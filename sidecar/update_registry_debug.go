//go:build jarvisdebug

package main

import (
	"os"

	"github.com/jarvis/sidecar/internal/update"
)

// updateRegistryURL honors JARVIS_UPDATE_REGISTRY in debug builds only, so an
// end-to-end test can serve payloads from a local fake registry.
func updateRegistryURL() string {
	if v := os.Getenv("JARVIS_UPDATE_REGISTRY"); v != "" {
		return v
	}
	return update.DefaultRegistryURL
}
