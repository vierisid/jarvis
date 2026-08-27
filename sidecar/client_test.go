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

// newTestClientWithPref builds a client whose only interesting property is the
// "Open dashboard at startup" preference. testConfig() restricts capabilities to
// pure-Go ones, so no GTK overlay or browser is constructed.
func newTestClientWithPref(t *testing.T, openAtStartup bool) *SidecarClient {
	t.Helper()
	cfg := testConfig()
	cfg.Token = fakeToken(t, SidecarTokenClaims{
		Sub:   "sidecar:test",
		Sid:   "sid",
		Name:  "test",
		Brain: "ws://127.0.0.1:3142/sidecar/connect",
		Iat:   1,
	})
	cfg.Preferences.OpenDashboardAtStartup = openAtStartup
	client, err := NewSidecarClient(cfg)
	if err != nil {
		t.Fatalf("NewSidecarClient returned error: %v", err)
	}
	return client
}

// TestShouldOpenDashboardAtStartup covers the three cases that matter: the
// preference is off (never), on (exactly once), and the reconnect case — a
// second registration on the same process must NOT re-open a window the user
// deliberately closed.
func TestShouldOpenDashboardAtStartup(t *testing.T) {
	t.Run("off: never opens", func(t *testing.T) {
		c := newTestClientWithPref(t, false)
		if c.shouldOpenDashboardAtStartup() {
			t.Fatal("preference is off — should not open the dashboard")
		}
		if c.shouldOpenDashboardAtStartup() {
			t.Fatal("preference is off — should not open on reconnect either")
		}
	})

	t.Run("on: opens exactly once", func(t *testing.T) {
		c := newTestClientWithPref(t, true)
		if !c.shouldOpenDashboardAtStartup() {
			t.Fatal("preference is on — the first registration should open the dashboard")
		}
		if c.shouldOpenDashboardAtStartup() {
			t.Fatal("a reconnect must not re-open the dashboard")
		}
	})

	t.Run("toggled on mid-session does not retro-fire", func(t *testing.T) {
		c := newTestClientWithPref(t, false)
		if c.shouldOpenDashboardAtStartup() {
			t.Fatal("preference is off — should not open the dashboard")
		}
		// The settings window can flip this while the sidecar is running; it is
		// a *startup* setting, so it must take effect on the next launch, not on
		// the next reconnect.
		c.config.Preferences.OpenDashboardAtStartup = true
		if c.shouldOpenDashboardAtStartup() {
			t.Fatal("a mid-session toggle must not open the dashboard on reconnect")
		}
	})
}
