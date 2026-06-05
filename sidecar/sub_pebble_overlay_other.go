//go:build !windows && !linux && !darwin

package main

import "fmt"

// Stub SubPebbleService for non-Windows. Native renderers for macOS / Linux
// land alongside the main pebble's T11 / T12 ports.

type subPebbleServiceStub struct{}

func NewSubPebbleService() SubPebbleService {
	return &subPebbleServiceStub{}
}

func (s *subPebbleServiceStub) Spawn(_ SubPebbleSpec) error {
	return fmt.Errorf("native sub-pebble overlay not yet implemented on this platform")
}

func (s *subPebbleServiceStub) SetState(_ string, _ PebbleState) error {
	return nil
}

func (s *subPebbleServiceStub) SetColor(_ string, _ SubPebbleColor) error {
	return nil
}

func (s *subPebbleServiceStub) SetLabel(_ string, _ string) error {
	return nil
}

func (s *subPebbleServiceStub) SetExpanded(_ string, _ bool, _, _, _ string, _ int) error {
	return nil
}

func (s *subPebbleServiceStub) Close(_ string) error {
	return nil
}

func (s *subPebbleServiceStub) CloseAll() error {
	return nil
}

func (s *subPebbleServiceStub) OnClick(_ func(string)) {}

func (s *subPebbleServiceStub) OnOpenFull(_ func(string)) {}
