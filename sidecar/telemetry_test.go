package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"testing"
	"time"
)

func boolPtr(b bool) *bool { return &b }

func TestSidecarAnonIDFormatAndStability(t *testing.T) {
	a := sidecarAnonID()
	b := sidecarAnonID()
	if a != b {
		t.Fatalf("anon id not stable: %q vs %q", a, b)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(a) {
		t.Fatalf("anon id not 32-char lowercase hex: %q", a)
	}
	if host, _ := os.Hostname(); host != "" && len(host) > 2 && regexp.MustCompile(regexp.QuoteMeta(host)).MatchString(a) {
		t.Fatalf("anon id leaks hostname")
	}
}

func TestResolveTelemetryEnabled(t *testing.T) {
	cases := []struct {
		name string
		cfg  *bool
		env  string
		want bool
	}{
		{"default on when unset", nil, "", true},
		{"config true", boolPtr(true), "", true},
		{"config false", boolPtr(false), "", false},
		{"env 0 overrides config-on", boolPtr(true), "0", false},
		{"env false overrides config-on", boolPtr(true), "false", false},
		{"env off overrides", nil, "off", false},
		{"env 1 overrides config-off", boolPtr(false), "1", true},
		{"env true overrides config-off", boolPtr(false), "true", true},
	}
	for _, tc := range cases {
		if got := resolveTelemetryEnabled(tc.cfg, tc.env); got != tc.want {
			t.Errorf("%s: resolveTelemetryEnabled(%v,%q)=%v, want %v", tc.name, tc.cfg, tc.env, got, tc.want)
		}
	}
}

func TestNormalizeArch(t *testing.T) {
	if got := normalizeArch("amd64"); got != "x64" {
		t.Errorf("amd64 -> %q, want x64", got)
	}
	for _, a := range []string{"arm64", "386", "riscv64"} {
		if got := normalizeArch(a); got != a {
			t.Errorf("%s -> %q, want passthrough", a, got)
		}
	}
}

func TestInstallMethodDefaultsToDev(t *testing.T) {
	// In `go test` builds sidecarVersion is unstamped ("dev").
	if got := installMethod(); got != "dev" {
		t.Errorf("installMethod()=%q, want dev for unstamped build", got)
	}
}

func TestPayloadOmitsEmptyBrainID(t *testing.T) {
	b, _ := json.Marshal(telemetryPayload{SidecarAnonID: "x", BrainConnected: false})
	if regexp.MustCompile(`brain_anon_id`).Match(b) {
		t.Errorf("empty brain_anon_id should be omitted, got %s", b)
	}
	b2, _ := json.Marshal(telemetryPayload{SidecarAnonID: "x", BrainAnonID: "deadbeef"})
	if !regexp.MustCompile(`"brain_anon_id":"deadbeef"`).Match(b2) {
		t.Errorf("non-empty brain_anon_id should be present, got %s", b2)
	}
}

func TestSendTelemetryPing(t *testing.T) {
	ctx := context.Background()
	payload := telemetryPayload{SidecarAnonID: "abc", SidecarVersion: "1.2.3", Platform: "linux", Arch: "x64"}

	t.Run("unconfigured", func(t *testing.T) {
		out := sendTelemetryPing(ctx, "", "k", payload)
		if out.ok || out.reason != "unconfigured" {
			t.Fatalf("got %+v, want unconfigured", out)
		}
	})

	t.Run("2xx posts payload + auth headers", func(t *testing.T) {
		var gotKey string
		var gotBody telemetryPayload
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotKey = r.Header.Get("apikey")
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &gotBody)
			w.WriteHeader(201)
		}))
		defer srv.Close()
		out := sendTelemetryPing(ctx, srv.URL, "secret-key", payload)
		if !out.ok || out.status != 201 {
			t.Fatalf("got %+v, want ok 201", out)
		}
		if gotKey != "secret-key" {
			t.Errorf("apikey header = %q", gotKey)
		}
		if gotBody.SidecarAnonID != "abc" {
			t.Errorf("server got payload %+v", gotBody)
		}
	})

	t.Run("5xx -> http", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(500)
		}))
		defer srv.Close()
		out := sendTelemetryPing(ctx, srv.URL, "k", payload)
		if out.ok || out.reason != "http" || out.status != 500 {
			t.Fatalf("got %+v, want http 500", out)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		orig := telemetrySendTimeout
		telemetrySendTimeout = 50 * time.Millisecond
		defer func() { telemetrySendTimeout = orig }()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(300 * time.Millisecond)
			w.WriteHeader(201)
		}))
		defer srv.Close()
		out := sendTelemetryPing(ctx, srv.URL, "k", payload)
		if out.ok || out.reason != "timeout" {
			t.Fatalf("got %+v, want timeout", out)
		}
	})
}
