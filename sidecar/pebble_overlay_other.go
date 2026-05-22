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

func (s *pebbleServiceStub) SetEye(active bool) error {
	return nil
}

func (s *pebbleServiceStub) SetAnswerOverflow(_ string) error {
	return nil
}

func (s *pebbleServiceStub) SetBlinded(blinded bool) error {
	return nil
}

func (s *pebbleServiceStub) PointAt(_, _ int, _ string, _ int) error {
	return nil
}

func (s *pebbleServiceStub) Close() error {
	return nil
}

func (s *pebbleServiceStub) OnSummon(callback func()) {
	// no-op — native pebble is Windows-only for now
}

func (s *pebbleServiceStub) OnPalette(callback func()) {
	// no-op — palette hotkey is Windows-only for now
}

func (s *pebbleServiceStub) OnBlindToggle(callback func()) {
	// no-op — long-press detection is Windows-only for now
}

func (s *pebbleServiceStub) OnAnswerOpen(_ func(string)) {
	// no-op — bubble overflow button is Windows-only for now
}
