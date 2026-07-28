package main

// Tray-driven actions: open dashboard rooms as native panels. Cross-platform
// (the tray itself is Windows/macOS, but these reuse the panel webview service).

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
)

// panelOrigin derives the dashboard http(s) origin from the brain WS URL carried
// in the JWT claim (ws://host -> http://host, wss -> https).
func (c *SidecarClient) panelOrigin() (string, error) {
	u, err := url.Parse(c.claims.Brain)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("brain origin unknown")
	}
	scheme := "http"
	if u.Scheme == "wss" || u.Scheme == "https" {
		scheme = "https"
	}
	return scheme + "://" + u.Host, nil
}

// openRoom spawns (or focuses) a native panel window showing a dashboard route.
// route is a hash route, e.g. "#/" (home/chat) or "#/_room_settings".
func (c *SidecarClient) openRoom(id PanelID, route, title string, w, h int) {
	if c.panels == nil {
		log.Printf("[tray] cannot open %q: the 'windows' capability is disabled", title)
		return
	}
	origin, err := c.panelOrigin()
	if err != nil {
		log.Printf("[tray] cannot open %q: %v", title, err)
		return
	}
	// Mint a short-lived access token for the panel. The dashboard data plane
	// (/api, /ws, the HTML load itself) accepts ONLY these minted access tokens,
	// never the long-lived enrollment JWT (c.config.Token) — so injecting the
	// enrollment JWT here returns a 401. Mirrors the brain-driven panel.spawn
	// path, which mints via this same provider (NewHandlerRegistry(..., c.tokenProvider.Token)).
	ctx := c.obsCtx
	if ctx == nil {
		ctx = context.Background()
	}
	accessToken, err := c.tokenProvider.Token(ctx)
	if err != nil {
		log.Printf("[tray] cannot open %q: mint access token: %v", title, err)
		return
	}
	// sanitizePanelURL host-checks against the brain origin and appends the
	// short-lived access token (so the panel authenticates as this sidecar).
	safeURL, err := sanitizePanelURL(origin+"/"+route, c.claims.Brain, accessToken)
	if err != nil {
		log.Printf("[tray] cannot open %q: %v", title, err)
		return
	}
	_, err = c.panels.Spawn(PanelSpec{
		ID:        id,
		URL:       safeURL,
		Title:     title,
		Bounds:    PanelBounds{X: -1, Y: -1, W: w, H: h},
		Resizable: true,
	})
	if errors.Is(err, ErrPanelExists) {
		_ = c.panels.Focus(id) // already open — bring it forward instead
		return
	}
	if err != nil {
		log.Printf("[tray] open %q failed: %v", title, err)
		return
	}
	log.Printf("[tray] opened %q", title)
}

// OpenChat opens the main chat room (dashboard home).
func (c *SidecarClient) OpenChat() { c.openRoom("tray:chat", "#/", "JARVIS", 1100, 760) }

// OpenSettings now opens the local sidecar settings window (see
// settings_window.go), not the remote dashboard settings room.
