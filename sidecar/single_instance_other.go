//go:build !windows

package main

// No single-instance lock outside Windows yet: every launch starts.
type noInstanceLock struct{}

func newInstanceLock() instanceLock { return noInstanceLock{} }

func (noInstanceLock) tryAcquire() (bool, error) { return false, nil }

func (noInstanceLock) handOff(bool) bool { return false }
