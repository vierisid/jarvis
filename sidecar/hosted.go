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
// structurally valid JWT and closes the window.
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
