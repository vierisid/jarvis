package main

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func fakeToken(t *testing.T, claims SidecarTokenClaims) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payloadBytes, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	return header + "." + payload + ".sig"
}

func TestNewSidecarClientUsesConfigBrainOverride(t *testing.T) {
	cfg := testConfig()
	cfg.Token = fakeToken(t, SidecarTokenClaims{
		Sub:   "sidecar:test",
		Jti:   "jti",
		Sid:   "sid",
		Name:  "test",
		Brain: "ws://127.0.0.1:3142/sidecar/connect",
		JWKS:  "http://127.0.0.1:3142/api/sidecars/.well-known/jwks.json",
		Iat:   1,
	})
	cfg.Brain = "10.0.0.25:3142"

	client, err := NewSidecarClient(cfg)
	if err != nil {
		t.Fatalf("NewSidecarClient returned error: %v", err)
	}

	if client.claims.Brain != "ws://10.0.0.25:3142/sidecar/connect" {
		t.Fatalf("expected config brain override, got %q", client.claims.Brain)
	}
}

func TestNormalizeBrainOverrideAcceptsHTTPOrigin(t *testing.T) {
	got := normalizeBrainOverride("https://brain.example.com")
	want := "wss://brain.example.com/sidecar/connect"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}
