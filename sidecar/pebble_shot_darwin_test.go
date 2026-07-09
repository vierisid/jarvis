//go:build darwin

package main

import (
	"os"
	"testing"
)

// TestPebbleShot renders the FABLE5 pebble state sheet (8 states × light/dark)
// to the PNG path in JARVIS_PEBBLE_SHOT, using an offscreen bitmap so it needs
// no window or display. It exists so the macOS Core Graphics drawing can be
// eyeballed from CI without a Mac (see .github/workflows/pebble-shot.yml).
// Skipped unless the env var is set, so normal `go test` runs are unaffected.
// TEMPORARY: remove alongside renderPebbleSheet once the render is confirmed.
func TestPebbleShot(t *testing.T) {
	out := os.Getenv("JARVIS_PEBBLE_SHOT")
	if out == "" {
		t.Skip("set JARVIS_PEBBLE_SHOT=<path> to render the pebble sheet")
	}
	if err := renderPebbleSheet(out); err != nil {
		t.Fatal(err)
	}
}
