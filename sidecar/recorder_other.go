//go:build !windows

package main

import "fmt"

// The input-hook recorder is Windows-first (roadmap Phase 4). On macOS/Linux
// recording is not yet available; record_skill degrades gracefully brain-side
// ("no interactions captured").
func startInputRecording() error {
	return fmt.Errorf("skill recording is not yet supported on this platform")
}

func stopInputRecording() {}
