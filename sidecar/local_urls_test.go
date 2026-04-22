package main

import "testing"

func TestLocalCDPHTTPURLUsesIPv4Loopback(t *testing.T) {
	got := localCDPHTTPURL(9222, "/json/version")
	want := "http://127.0.0.1:9222/json/version"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestPreferIPv4LoopbackRewritesLocalhostWSURL(t *testing.T) {
	got := preferIPv4Loopback("ws://localhost:9222/devtools/page/abc")
	want := "ws://127.0.0.1:9222/devtools/page/abc"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestPreferIPv4LoopbackLeavesNonLocalhostUntouched(t *testing.T) {
	input := "wss://brain.example.com/sidecar/connect"
	if got := preferIPv4Loopback(input); got != input {
		t.Fatalf("expected %q, got %q", input, got)
	}
}
