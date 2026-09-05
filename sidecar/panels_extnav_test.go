package main

import "testing"

// isExternallyOpenable is the one platform-independent gate between remote panel
// content and the OS launcher, so pin exactly what it lets through.
func TestIsExternallyOpenable(t *testing.T) {
	for _, c := range []struct {
		url  string
		want bool
	}{
		{"https://accounts.google.com/o/oauth2/v2/auth?x=1", true},
		{"http://localhost:3000/connect", true},
		{"", false},
		{"file:///etc/passwd", false},
		{"javascript:alert(1)", false},
		{"jarvis://enroll?token=x", false},
		{"mailto:a@b.com", false},
		// Scheme match is case-sensitive on purpose: engines normalise to
		// lowercase, and rejecting the uppercase form fails closed.
		{"HTTPS://example.com", false},
		{"ftp://example.com/x", false},
		{" https://example.com", false}, // leading space: not a real URL
	} {
		if got := isExternallyOpenable(c.url); got != c.want {
			t.Errorf("isExternallyOpenable(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}
