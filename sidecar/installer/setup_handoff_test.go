package main

import "testing"

func TestSetupHandoffAllowed(t *testing.T) {
	if setupHandoffAllowed("0.9.0") {
		t.Error("0.9.0 predates --setup and must not get the flag")
	}
	if !setupHandoffAllowed(minSetupSidecarVersion) {
		t.Errorf("%s introduces --setup and must get the flag", minSetupSidecarVersion)
	}
	if !setupHandoffAllowed("1.0.0") {
		t.Error("1.0.0 must get the flag")
	}
}
