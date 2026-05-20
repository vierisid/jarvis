//go:build !windows

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

func (s *subPebbleServiceStub) SetLabel(_ string, _ string) error {
	return nil
}

func (s *subPebbleServiceStub) Close(_ string) error {
	return nil
}

func (s *subPebbleServiceStub) CloseAll() error {
	return nil
}
