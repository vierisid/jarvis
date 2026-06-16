package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// accessTokenProvider mints and caches short-lived access tokens from the brain.
//
// The long-lived enrollment JWT (config.Token) is sent ONLY here, as an
// Authorization: Bearer header to POST <brain>/sidecar/token over TLS — never
// embedded in a panel URL, cookie, or log. Panel webviews carry the returned
// short-lived access token instead, so a leaked panel credential is bounded to
// the token's TTL rather than being the permanent enrollment credential.
//
// Tokens are cached and refreshed slightly ahead of expiry so panel spawns
// don't each pay a mint round-trip. Note: this refreshes the token used for
// NEW spawns; a panel left open past the TTL still needs to be reopened to pick
// up a fresh token (background re-injection into a live webview is a follow-up).
type accessTokenProvider struct {
	mintURL     string
	enrollToken string

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func newAccessTokenProvider(brainWsURL, enrollToken string) *accessTokenProvider {
	return &accessTokenProvider{
		mintURL:     deriveMintURL(brainWsURL),
		enrollToken: enrollToken,
	}
}

// deriveMintURL converts the brain's ws(s)://host/sidecar/connect URL into the
// http(s)://host/sidecar/token mint endpoint (scheme mapped, path replaced).
func deriveMintURL(brainWsURL string) string {
	s := brainWsURL
	switch {
	case strings.HasPrefix(s, "wss://"):
		s = "https://" + strings.TrimPrefix(s, "wss://")
	case strings.HasPrefix(s, "ws://"):
		s = "http://" + strings.TrimPrefix(s, "ws://")
	}
	// Strip everything after the host (the /sidecar/connect path).
	if i := strings.Index(s, "://"); i >= 0 {
		rest := s[i+3:]
		if j := strings.IndexByte(rest, '/'); j >= 0 {
			s = s[:i+3+j]
		}
	}
	return strings.TrimRight(s, "/") + "/sidecar/token"
}

// Token returns a currently-valid access token, minting or refreshing as
// needed. Safe for concurrent use.
func (p *accessTokenProvider) Token(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.token != "" && time.Now().Before(p.expiresAt) {
		return p.token, nil
	}
	tok, ttl, err := p.mint(ctx)
	if err != nil {
		return "", err
	}
	p.token = tok
	// Refresh a minute before the real expiry to avoid handing out a token
	// that's about to be rejected. Clamp so a tiny TTL still caches briefly.
	lead := 60 * time.Second
	if d := time.Duration(ttl) * time.Second; d > lead {
		p.expiresAt = time.Now().Add(d - lead)
	} else {
		p.expiresAt = time.Now().Add(d / 2)
	}
	return tok, nil
}

func (p *accessTokenProvider) mint(ctx context.Context) (string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.mintURL, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Authorization", "Bearer "+p.enrollToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("mint access token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("mint access token: status %d", resp.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", 0, fmt.Errorf("mint access token: decode: %w", err)
	}
	if out.AccessToken == "" {
		return "", 0, fmt.Errorf("mint access token: empty token in response")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 600
	}
	return out.AccessToken, out.ExpiresIn, nil
}
