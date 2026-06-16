package main

import "testing"

func TestDeriveMintURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"ws://127.0.0.1:3142/sidecar/connect", "http://127.0.0.1:3142/sidecar/token"},
		{"wss://brain.example.com/sidecar/connect", "https://brain.example.com/sidecar/token"},
		{"wss://brain.example.com:8443/sidecar/connect", "https://brain.example.com:8443/sidecar/token"},
		{"ws://localhost:3142/sidecar/connect", "http://localhost:3142/sidecar/token"},
		// No path on the input still yields the mint endpoint.
		{"wss://brain.example.com", "https://brain.example.com/sidecar/token"},
	}
	for _, c := range cases {
		if got := deriveMintURL(c.in); got != c.want {
			t.Errorf("deriveMintURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
