//go:build !windows

package main

import "fmt"

// The input-hook recorder is Windows-first. On macOS/Linux recording is not
// yet available: recorder_start fails, so the brain never opens a session.
func init() {
	inputHookStart = func() error {
		return fmt.Errorf("skill recording is not yet supported on this platform")
	}
	inputHookStop = func() {}
}
