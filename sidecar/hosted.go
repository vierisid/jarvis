package main

// Hosted-onboarding handshake client (usejarvis).
//
// A sidecar with no token binds its Go process to the user's web identity via
// a single-use NONCE (docs/ONBOARDING.md in the hosting repo): it registers
// {nonce, hostname} with the hosted server, opens the connect page (Clerk +
// Stripe) in a webview carrying only the nonce, and LONG-POLLS the server
// until provisioning enrolls this device and resolves the handshake with the
// enrollment JWT. The JWT travels Go <-> server only - it is never placed in
// page JavaScript.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// hostedDefaultBaseURL is the production connect origin. Overriding it (env
// JARVIS_HOSTED_URL or sidecar.yaml hosted_base_url) is honored ONLY in
// builds compiled with `-tags jarvisdebug` - a release binary always talks
// to the real origin, so a tampered config/env cannot redirect the JWT
// handshake to an attacker-controlled server.
const hostedDefaultBaseURL = "https://app.usejarvis.dev"

func resolveHostedBaseURL(cfgValue string) string {
	return resolveHostedBaseURLWith(hostedOverrideAllowed, cfgValue, os.Getenv("JARVIS_HOSTED_URL"))
}

func resolveHostedBaseURLWith(overrideAllowed bool, cfgValue, envValue string) string {
	if overrideAllowed {
		if v := strings.TrimSpace(envValue); v != "" {
			return strings.TrimRight(v, "/")
		}
		if v := strings.TrimSpace(cfgValue); v != "" {
			return strings.TrimRight(v, "/")
		}
	}
	return hostedDefaultBaseURL
}

// submitTokenHandler builds the `window.submitToken` binding. isActive gates
// it to the LOCAL token form: bindings are callable by whatever page the
// webview shows, and the hosted flow navigates to remote content - without
// the gate, any page in the Clerk/Stripe redirect chain could silently
// enroll this sidecar to an attacker-controlled brain (enrollment JWTs are
// self-describing via their brain/jwks claims). accept receives a
// structurally valid JWT; the caller then verifies it against its brain
// (verify_token.go) and closes the window only on success.
func submitTokenHandler(isActive func() bool, accept func(token string)) func(string) error {
	return func(raw string) error {
		if !isActive() {
			log.Printf("[hosted] submitToken called while the token form is not active - ignored")
			return fmt.Errorf("Token entry is not active.")
		}
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return fmt.Errorf("Paste your enrollment token to continue.")
		}
		if _, err := DecodeJWTPayload(raw); err != nil {
			return fmt.Errorf("That doesn't look like a valid token. Copy the full token printed by 'jarvis enroll'.")
		}
		accept(raw)
		return nil
	}
}

// reportSelfHostResult posts the verdict of a LOCALLY-verified self-host
// enroll (jarvis:// deep link) so the connect page can show success or the
// reason for rejection: {nonce, ok, error?} — the token itself never leaves
// this machine. Nonce-authed server-side; the error string is user-ready
// (verify_token.go messages) and the server caps it at 300 chars. Bounded
// retries: losing the verdict leaves the page waiting on a spinner even
// though this side already moved on.
func reportSelfHostResult(ctx context.Context, base, nonce string, verr error) {
	if ctx.Err() != nil || errors.Is(verr, context.Canceled) {
		return // window tearing down — not a verdict
	}
	payload := map[string]any{"nonce": nonce, "ok": verr == nil}
	if verr != nil {
		// Cap in UTF-16 CODE UNITS, not runes — the server's zod .max counts
		// UTF-16, and a rune-capped astral-plane message (host names ride in
		// from the token's own claims) would be rejected there, losing the
		// verdict entirely.
		payload["error"] = capUTF16(verr.Error(), 300)
	}
	body, _ := json.Marshal(payload)
	for attempt := 1; attempt <= 3; attempt++ {
		rctx, rcancel := context.WithTimeout(ctx, 10*time.Second)
		err := postSelfHostResultOnce(rctx, base, body)
		rcancel()
		if err == nil {
			return
		}
		log.Printf("[hosted] self-host verdict report failed (attempt %d/3): %v", attempt, err)
		var pe *permanentReportError
		if errors.As(err, &pe) {
			return // a 4xx repeats identically — retrying is noise
		}
		select {
		case <-time.After(2 * time.Second):
		case <-ctx.Done():
			return
		}
	}
}

// capUTF16 truncates s to at most max UTF-16 code units, never splitting a
// rune (a surrogate pair either fits whole or is dropped).
func capUTF16(s string, max int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > max {
			return s[:i]
		}
		units += w
	}
	return s
}

// permanentReportError marks a server verdict rejection (4xx) that retries
// cannot fix.
type permanentReportError struct{ status string }

func (e *permanentReportError) Error() string { return "server returned " + e.status }

func postSelfHostResultOnce(ctx context.Context, base string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/handshake/self-host-result", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := hostedHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 && res.StatusCode < 500 {
		return &permanentReportError{status: res.Status}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("server returned %s", res.Status)
	}
	return nil
}

// generateHandshakeNonce returns a 256-bit unguessable correlation id.
func generateHandshakeNonce() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate handshake nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func connectPageURL(base, nonce string) string {
	return base + "/connect?handshake=" + url.QueryEscape(nonce)
}

// The long-poll request is held open server-side; keep the client timeout
// comfortably above the server's hold (~55s).
var hostedHTTPClient = &http.Client{Timeout: 75 * time.Second}

// A well-behaved server holds the poll, so consecutive requests are ~55s
// apart. If a poll returns "pending" faster than this (an intermediary that
// buffers instead of holding, or a simple server), wait out the remainder -
// verified without the floor: ~2900 requests/second.
const minPendingPollInterval = 2 * time.Second

// isNoSuchHostErr reports whether err is a DNS "no such host" failure —
// the hosted origin does not resolve from this machine (offline, or an
// air-gapped/self-hosted network that will never see usejarvis).
func isNoSuchHostErr(err error) bool {
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr) && dnsErr.IsNotFound
}

// registerHandshake announces the nonce (+ this machine's hostname) so the
// connect page can claim it after Clerk login.
func registerHandshake(ctx context.Context, base, nonce, hostname string) error {
	body, _ := json.Marshal(map[string]string{
		"nonce":    nonce,
		"hostname": hostname,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/handshake/register", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := hostedHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("handshake register: server returned %s", res.Status)
	}
	return nil
}

type handshakePollResponse struct {
	// "pending" | "complete" | "failed"
	Status string `json:"status"`
	// Enrollment JWT, present when Status == "complete".
	Token string `json:"token,omitempty"`
	// Human-readable reason, present when Status == "failed".
	Error string `json:"error,omitempty"`
	// Optional progress hint while pending ("provisioning", "starting", ...).
	Step string `json:"step,omitempty"`
}

// errHandshakeFailed marks a terminal server-side failure (vs a transient
// network error, which awaitHandshakeToken retries).
type errHandshakeFailed struct{ reason string }

func (e *errHandshakeFailed) Error() string { return e.reason }

// errHandshakeResolvedLocally: the handshake completed with NO token — a
// self-host verdict resolved it, meaning the deep-link path on THIS machine
// (or none at all, for a stranger's report) owns the outcome. Not an error to
// paint on the shell: the deep-link goroutine already accepted the token and
// is closing the window, or there is nothing for the hosted path to do.
var errHandshakeResolvedLocally = errors.New("handshake resolved by a local self-host enroll")

func pollHandshakeOnce(ctx context.Context, base, nonce string) (*handshakePollResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/handshake/poll?nonce="+url.QueryEscape(nonce), nil)
	if err != nil {
		return nil, err
	}
	res, err := hostedHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("handshake poll: server returned %s", res.Status)
	}
	var parsed handshakePollResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("handshake poll: unparseable response: %w", err)
	}
	return &parsed, nil
}

// awaitHandshakeToken long-polls until the handshake resolves with the JWT.
// Transient errors and "pending" responses re-poll (the nonce stays valid
// server-side until its TTL); a "failed" status is terminal. onProgress
// receives step hints for the shell UI ("" filtered).
func awaitHandshakeToken(ctx context.Context, base, nonce string, onProgress func(step string)) (string, error) {
	backoff := 2 * time.Second
	for {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		pollStart := time.Now()
		res, err := pollHandshakeOnce(ctx, base, nonce)
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			log.Printf("[hosted] handshake poll error (will retry in %s): %v", backoff, err)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return "", ctx.Err()
			}
			backoff = min(backoff*2, 15*time.Second)
			continue
		}
		backoff = 2 * time.Second

		switch res.Status {
		case "complete":
			if res.Token == "" {
				return "", errHandshakeResolvedLocally
			}
			if _, err := DecodeJWTPayload(res.Token); err != nil {
				return "", fmt.Errorf("handshake returned an invalid token: %w", err)
			}
			return res.Token, nil
		case "failed":
			reason := res.Error
			if reason == "" {
				reason = "setup failed on the server"
			}
			return "", &errHandshakeFailed{reason: reason}
		default: // "pending" (or unknown) -> re-issue the long-poll
			if onProgress != nil && res.Step != "" {
				onProgress(res.Step)
			}
			if wait := minPendingPollInterval - time.Since(pollStart); wait > 0 {
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return "", ctx.Err()
				}
			}
		}
	}
}
