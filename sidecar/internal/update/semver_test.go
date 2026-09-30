package update

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
		if got := VersionLess(c.a, c.b); got != c.want {
			t.Errorf("VersionLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// StrictlyNewer gates self-updates: only a parseable candidate strictly above
// a parseable running version passes, so a dev build or a garbage version
// from the brain never triggers an install, and neither does a downgrade.
func TestStrictlyNewer(t *testing.T) {
	cases := []struct {
		candidate, current string
		want               bool
	}{
		{"0.10.0", "0.9.7", true},
		{"0.9.7", "0.9.7", false},
		{"0.9.6", "0.9.7", false},
		{"1.0.0", "1.0.0-rc.1", true},
		{"1.0.0-rc.1", "1.0.0", false},
		{"0.10.0", "dev", false},
		{"garbage", "0.9.7", false},
		{"", "0.9.7", false},
	}
	for _, c := range cases {
		if got := StrictlyNewer(c.candidate, c.current); got != c.want {
			t.Errorf("StrictlyNewer(%q, %q) = %v, want %v", c.candidate, c.current, got, c.want)
		}
	}
}
