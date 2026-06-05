//go:build !windows && !linux && !darwin

package main

import "fmt"

// Stub region-selection service for non-Windows platforms. macOS +
// Linux ports land in T19b; the daemon's voice intent handles the
// "no region service" error gracefully so this isn't load-bearing.

type regionSelectionStub struct{}

func NewRegionSelectionService() RegionSelectionService {
	return &regionSelectionStub{}
}

func (s *regionSelectionStub) Start(_ func([]byte, int, int), onCancel func()) error {
	if onCancel != nil {
		onCancel()
	}
	return fmt.Errorf("region selection not yet supported on this platform")
}
