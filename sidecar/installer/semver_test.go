package main

import "testing"

func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.9.0", "0.9.1", true},
		{"0.9.1", "0.9.0", false},
		{"0.9.1", "0.9.1", false},
		{"0.9.9", "0.10.0", true},
		{"1.0.0", "0.99.99", false},
		{"v0.9.0", "0.9.1", true}, // tolerated v prefix
		{"1.2.3-rc.1", "1.2.3", true},
		{"1.2.3", "1.2.3-rc.1", false},
		{"1.2.3-rc.1", "1.2.3-rc.2", true},
		{"1.2.3-alpha", "1.2.3-beta", true},
		{"1.2.3-rc.1", "1.2.3-rc.1.1", true},    // shorter prerelease sorts first
		{"1.2.3-1", "1.2.3-alpha", true},        // numeric < alphanumeric
		{"1.2.3+build5", "1.2.3+build9", false}, // build metadata ignored
		{"garbage", "0.0.1", true},              // unparseable side loses
		{"0.0.1", "garbage", false},
		{"garbage", "garbage", false},
	}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

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
