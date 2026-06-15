package main

// Anonymous sidecar usage telemetry.
//
// Mirrors the brain's telemetry (src/telemetry) but is INDEPENDENT: it has its
// own anon-id namespace, its own collector table (sidecar_pings), and its own
// opt-out. It deliberately does NOT honor the brain's JARVIS_TELEMETRY /
// DO_NOT_TRACK env vars — the sidecar is opted out only via its own Settings >
// Privacy toggle (sidecar.yaml telemetry.enabled) or JARVIS_SIDECAR_TELEMETRY=0.
//
// Sends are fire-and-forget and total-failure-safe: nothing here may crash or
// block the sidecar. Set JARVIS_SIDECAR_TELEMETRY_DEBUG=1 to log each outcome.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/user"
	"runtime"
	"strings"
	"time"
)

// Collector endpoint. PUBLIC by design: the Supabase anon key is scoped by an
// INSERT-only RLS policy on sidecar_pings (it can write pings, never read).
// Vars (not consts) so tests can point sendTelemetryPing at a local server.
var (
	telemetryURL     = "https://wmrxnfhghycxyabdhczn.supabase.co/rest/v1/sidecar_pings"
	telemetryAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtcnhuZmhnaHljeHlhYmRoY3puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5OTQ4OTgsImV4cCI6MjA5NjU3MDg5OH0.phREIq3UEKPUyTNT077q-LWBqCw16wajIoTC50Z0J0E"
)

const (
	sidecarAnonNamespace = "jarvis-sidecar-telemetry-v1"
	telemetryInterval    = time.Hour
)

// var (not const) so tests can shorten it to exercise the timeout path.
var telemetrySendTimeout = 5 * time.Second

// telemetryPayload is the full set of fields sent to the collector. No
// hostname, username, IP, file paths, or screen content — just a hashed
// machine id, version, platform, and coarse environment facts.
type telemetryPayload struct {
	SidecarAnonID   string   `json:"sidecar_anon_id"`
	BrainAnonID     string   `json:"brain_anon_id,omitempty"`
	SidecarVersion  string   `json:"sidecar_version"`
	Platform        string   `json:"platform"`
	Arch            string   `json:"arch"`
	OSVersion       string   `json:"os_version,omitempty"`
	TZOffsetMin     int      `json:"tz_offset_min"`
	BrainConnected  bool     `json:"brain_connected"`
	InstallMethod   string   `json:"install_method"`
	CapsAvailable   []string `json:"caps_available"`
	CapsUnavailable []string `json:"caps_unavailable"`
}

// isFalsy treats unset/empty/0/false/no/off as "not enabled".
func isFalsy(v string) bool {
	s := strings.ToLower(strings.TrimSpace(v))
	return s == "" || s == "0" || s == "false" || s == "no" || s == "off"
}

// resolveTelemetryEnabled decides if telemetry runs. Precedence:
// JARVIS_SIDECAR_TELEMETRY env (if set) > config flag > default on.
// configEnabled is nil when the config key is absent.
func resolveTelemetryEnabled(configEnabled *bool, sidecarEnv string) bool {
	if strings.TrimSpace(sidecarEnv) != "" {
		return !isFalsy(sidecarEnv)
	}
	if configEnabled != nil {
		return *configEnabled
	}
	return true
}

// sidecarAnonID is a deterministic, non-reversible id for this machine:
// sha256("jarvis-sidecar-telemetry-v1:"+hostname+":"+username), 128-bit hex.
// Stable across restarts; the raw hostname/username never leave the machine.
// Its own namespace (distinct from the brain's) so a co-located brain+sidecar
// don't collide — brain correlation is via brain_anon_id, not id equality.
func sidecarAnonID() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown-host"
	}
	uname := "unknown-user"
	if u, err := user.Current(); err == nil && u.Username != "" {
		uname = u.Username
	} else if env := firstNonEmpty(os.Getenv("USER"), os.Getenv("USERNAME")); env != "" {
		uname = env
	}
	sum := sha256.Sum256([]byte(sidecarAnonNamespace + ":" + host + ":" + uname))
	return hex.EncodeToString(sum[:])[:32]
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// normalizeArch maps Go's GOARCH onto the brain's arch vocabulary so cross-
// dashboard comparisons line up (Node reports "x64", Go reports "amd64").
func normalizeArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x64"
	default:
		return goarch // arm64, 386, etc. pass through
	}
}

// installMethod is coarse: a stamped release vs an unstamped local build.
func installMethod() string {
	if sidecarVersion == "" || sidecarVersion == "dev" {
		return "dev"
	}
	return "release"
}

// buildTelemetryPayload snapshots the current state into a payload.
func buildTelemetryPayload(c *SidecarClient) telemetryPayload {
	unavail := c.UnavailableCaps()
	un := make([]string, 0, len(unavail))
	for _, u := range unavail {
		un = append(un, u.Name)
	}
	_, offSec := time.Now().Zone()
	return telemetryPayload{
		SidecarAnonID:   sidecarAnonID(),
		BrainAnonID:     c.BrainAnonID(),
		SidecarVersion:  sidecarVersion,
		Platform:        runtime.GOOS,
		Arch:            normalizeArch(runtime.GOARCH),
		OSVersion:       osVersion(),
		TZOffsetMin:     offSec / 60,
		BrainConnected:  c.Connected(),
		InstallMethod:   installMethod(),
		CapsAvailable:   c.AvailableCaps(),
		CapsUnavailable: un,
	}
}

// sendOutcome is the structured result of a send attempt (never an error).
type sendOutcome struct {
	ok     bool
	reason string // "unconfigured" | "http" | "network" | "timeout"
	status int
	errMsg string
}

// sendTelemetryPing POSTs one ping. Total-failure-safe: returns an outcome,
// never panics or blocks beyond telemetrySendTimeout. url/key are passed in so
// tests can target a loopback server.
func sendTelemetryPing(ctx context.Context, url, key string, payload telemetryPayload) sendOutcome {
	if url == "" || strings.Contains(url, "YOUR_PROJECT_REF") || key == "" {
		return sendOutcome{reason: "unconfigured"}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return sendOutcome{reason: "network", errMsg: err.Error()}
	}
	reqCtx, cancel := context.WithTimeout(ctx, telemetrySendTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return sendOutcome{reason: "network", errMsg: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", key)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Prefer", "return=minimal")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if reqCtx.Err() == context.DeadlineExceeded {
			return sendOutcome{reason: "timeout"}
		}
		return sendOutcome{reason: "network", errMsg: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return sendOutcome{ok: true, status: resp.StatusCode}
	}
	return sendOutcome{reason: "http", status: resp.StatusCode}
}

// StartTelemetry launches the telemetry loop in a goroutine: one ping at
// startup, then hourly, until ctx is cancelled. Enablement is re-checked every
// tick so the Settings > Privacy toggle takes effect without a restart.
func StartTelemetry(ctx context.Context, c *SidecarClient) {
	debug := !isFalsy(os.Getenv("JARVIS_SIDECAR_TELEMETRY_DEBUG"))

	enabled := func() bool {
		return resolveTelemetryEnabled(telemetryEnabledPtr(c), os.Getenv("JARVIS_SIDECAR_TELEMETRY"))
	}

	// A hard env opt-out skips the loop entirely. A config-only opt-out still
	// starts an inert loop (fire() gates on enabled()) so the Settings > Privacy
	// checkbox takes effect live in BOTH directions without a restart.
	if envVal := strings.TrimSpace(os.Getenv("JARVIS_SIDECAR_TELEMETRY")); envVal != "" && isFalsy(envVal) {
		log.Printf("[telemetry] sidecar telemetry disabled via JARVIS_SIDECAR_TELEMETRY")
		return
	}
	if enabled() {
		log.Printf("[telemetry] anonymous sidecar metrics on (disable in Settings > Privacy or set JARVIS_SIDECAR_TELEMETRY=0)")
	} else {
		log.Printf("[telemetry] sidecar telemetry currently off (enable in Settings > Privacy)")
	}

	fire := func() {
		if !enabled() {
			return
		}
		out := sendTelemetryPing(ctx, telemetryURL, telemetryAnonKey, buildTelemetryPayload(c))
		if debug {
			if out.ok {
				log.Printf("[telemetry] debug: ping ok (HTTP %d)", out.status)
			} else {
				log.Printf("[telemetry] debug: ping failed (%s status=%d %s)", out.reason, out.status, out.errMsg)
			}
		}
	}

	go func() {
		fire()
		t := time.NewTicker(telemetryInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				fire()
			}
		}
	}()
}

// telemetryEnabledPtr bridges the live config flag for resolveTelemetryEnabled:
// it returns a *bool reflecting the client's current config (nil-safe), so the
// pure resolver stays testable while the loop reads live state.
func telemetryEnabledPtr(c *SidecarClient) *bool {
	v := c.TelemetryEnabled()
	return &v
}
