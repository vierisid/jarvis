package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestApplyEnrollmentTokenUsesPromptedDashboardURL(t *testing.T) {
	cfg := testConfig()
	token := fakeToken(t, SidecarTokenClaims{
		Sub:   "sidecar:test",
		Jti:   "jti",
		Sid:   "sid",
		Name:  "test",
		Brain: "ws://127.0.0.1:3142/sidecar/connect",
		JWKS:  "http://127.0.0.1:3142/api/sidecars/.well-known/jwks.json",
		Iat:   1,
	})

	var out bytes.Buffer
	if err := applyEnrollmentToken(cfg, token, strings.NewReader("https://brain.example.com\n"), &out, true); err != nil {
		t.Fatalf("applyEnrollmentToken returned error: %v", err)
	}

	if cfg.Token != token {
		t.Fatalf("expected token to be saved on config")
	}
	if cfg.Brain != "https://brain.example.com" {
		t.Fatalf("expected prompted dashboard URL override, got %q", cfg.Brain)
	}
	if !strings.Contains(out.String(), "Dashboard URL") {
		t.Fatalf("expected onboarding prompt output, got %q", out.String())
	}
}

func TestApplyEnrollmentTokenBlankInputUsesTokenDefault(t *testing.T) {
	cfg := testConfig()
	token := fakeToken(t, SidecarTokenClaims{
		Sub:   "sidecar:test",
		Jti:   "jti",
		Sid:   "sid",
		Name:  "test",
		Brain: "wss://brain.example.com/jarvis/sidecar/connect",
		JWKS:  "https://brain.example.com/jarvis/api/sidecars/.well-known/jwks.json",
		Iat:   1,
	})

	if err := applyEnrollmentToken(cfg, token, strings.NewReader("\n"), &bytes.Buffer{}, true); err != nil {
		t.Fatalf("applyEnrollmentToken returned error: %v", err)
	}

	if cfg.Brain != "" {
		t.Fatalf("expected blank input to keep token default, got %q", cfg.Brain)
	}
}

func TestDashboardURLFromBrainEndpointPreservesProxyPath(t *testing.T) {
	got := dashboardURLFromBrainEndpoint("wss://brain.example.com/jarvis/sidecar/connect")
	want := "https://brain.example.com/jarvis"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}
