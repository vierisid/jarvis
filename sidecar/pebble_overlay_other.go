//go:build !windows && !darwin && !linux

package main

import "fmt"

// Stub PebbleService for non-Windows. Real Cocoa (T11) / GTK+Cairo (T12)
// implementations land in their own platform-tagged files.

type pebbleServiceStub struct{}

func NewPebbleService() PebbleService {
	return &pebbleServiceStub{}
}

func (s *pebbleServiceStub) Spawn(spec PebbleSpec) error {
	return fmt.Errorf("native pebble overlay not yet implemented on this platform (W2-T11/T12)")
}

func (s *pebbleServiceStub) SetState(state PebbleState) error {
	return fmt.Errorf("native pebble overlay not yet implemented on this platform")
}

func (s *pebbleServiceStub) SetText(text string) error {
	return nil
}

func (s *pebbleServiceStub) Close() error {
	return nil
}

func (s *pebbleServiceStub) OnSummon(callback func()) {
	// no-op — native pebble is Windows-only for now
}
