package main

// Pre-save verification of a manually-supplied enrollment token.
//
// A pasted token used to be checked only structurally (DecodeJWTPayload),
// saved, and then the sidecar restarted into its connect loop — so a token
// that decodes fine but names a wrong/unreachable brain URL produced no UI at
// all: the setup window closed, the pebble never spawned, and the only trace
// was an endless reconnect loop in ~/.jarvis/sidecar.log. verifyBrainToken
// closes that gap: it proves the token actually works against the brain it
// names BEFORE the token is persisted, by asking that brain to mint an access
// token (POST /sidecar/token — the same endpoint accessTokenProvider uses once
// the sidecar runs). The outcome cleanly separates the three failure modes a
// user can act on: the brain can't be reached, the brain rejected the token,
// or the URL answers but isn't a Jarvis brain.
//
// The hosted-handshake token deliberately does NOT go through this: that JWT
// is delivered single-use over the long-poll and must be persisted
// unconditionally (see the capture comment in hosted_window.go).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// verifyBrainTimeout bounds the whole probe. Long enough for a slow first TLS
// handshake, short enough that a black-holed address fails while the user is
// still looking at the "checking" state.
const verifyBrainTimeout = 12 * time.Second

// verifyBrainToken checks that the enrollment token works against the brain
// it will actually be used with: claims.Brain, unless the config's brain
// override replaces it (same precedence as NewSidecarClient). Returns nil when
// the brain minted an access token for it; otherwise an error whose message is
// user-ready (shown verbatim in the setup/settings forms and on stderr for
// --token). A cancelled ctx surfaces as context.Canceled so callers can tell
// "window closed" from a real verdict.
func verifyBrainToken(ctx context.Context, raw, brainOverride string) error {
	claims, err := DecodeJWTPayload(raw)
	if err != nil {
		return fmt.Errorf("That doesn't look like a valid token. Copy the full token printed by 'jarvis enroll'.")
	}
	brainURL := claims.Brain
	if override := normalizeBrainOverride(brainOverride); override != "" {
		brainURL = override
	}
	if strings.TrimSpace(brainURL) == "" {
		return fmt.Errorf("This token doesn't name a brain to connect to. Run 'jarvis enroll \"<device-name>\"' again and paste the fresh token.")
	}
	mintURL := deriveMintURL(brainURL)
	host := hostForDisplay(mintURL)
	// A token minted without daemon.brain_domain names localhost, which only
	// works on the brain machine itself. When the probe then fails from THIS
	// machine, the fix is usually a brain-address override, not a new token —
	// say so instead of sending the user re-enrolling. Keyed on the token's
	// own claim, and only while no override is in play: once the user has
	// supplied one they already know the mechanism, and the probed address is
	// theirs to own.
	loopbackHint := ""
	if isLoopbackBrainURL(claims.Brain) && normalizeBrainOverride(brainOverride) == "" {
		loopbackHint = " The token points at localhost — if your brain runs on another machine, enter that machine's address in the Brain address field (or set 'brain:' in ~/.jarvis/sidecar.yaml) and try again."
	}

	ctx, cancel := context.WithTimeout(ctx, verifyBrainTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, mintURL, nil)
	if err != nil {
		return fmt.Errorf("This token points at an invalid brain address (%s).", brainURL)
	}
	req.Header.Set("Authorization", "Bearer "+raw)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return context.Canceled
		}
		log.Printf("[verify] brain probe %s failed: %v", mintURL, err)
		return fmt.Errorf("Could not reach the brain at %s. Check that it is running and reachable from this machine, then try again.%s", host, loopbackHint)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusOK:
		// Fall through to the body check below.
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return fmt.Errorf("The brain at %s rejected this token — it may be revoked or belong to a different brain. Run 'jarvis enroll \"<device-name>\"' again and paste the fresh token.%s", host, loopbackHint)
	case resp.StatusCode >= 500:
		// A brain (or its proxy) that is up but erroring is not a wrong URL —
		// don't steer the user into re-checking their token or address.
		return fmt.Errorf("The brain at %s answered with a server error (%s). It may be restarting — try again in a moment.", host, resp.Status)
	default:
		return fmt.Errorf("The server at %s doesn't look like a Jarvis brain (unexpected response %s).", host, resp.Status)
	}

	// A 200 alone isn't proof — a captive portal or an unrelated web app can
	// answer 200 to any path. Require the actual mint response shape.
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil || out.AccessToken == "" {
		// Cancellation can also land here, aborting the body read mid-decode —
		// keep the documented contract (window closed ⇒ context.Canceled)
		// instead of misreporting it as a bad response body.
		if errors.Is(ctx.Err(), context.Canceled) {
			return context.Canceled
		}
		return fmt.Errorf("The server at %s doesn't look like a Jarvis brain (unexpected response body).", host)
	}
	return nil
}

// hostForDisplay reduces a URL to its host for user-facing messages, falling
// back to the raw string if it doesn't parse.
func hostForDisplay(rawURL string) string {
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		return u.Host
	}
	return rawURL
}

// isLoopbackBrainURL reports whether a brain connect URL points at a loopback
// address (localhost, 127.0.0.1, ::1). Such URLs only work on the brain
// machine itself; a sidecar anywhere else needs an address override, which is
// exactly what the failure messages steer the user toward.
func isLoopbackBrainURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return false
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}
