package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// enrollJWT builds a structurally valid (unsigned) enrollment JWT whose brain
// claim points at the given ws(s) URL.
func enrollJWT(t *testing.T, brain string) string {
	t.Helper()
	header := `{"alg":"ES256"}`
	payload := `{"sid":"s1","name":"desktop","brain":"` + brain + `","jwks":"https://x/jwks.json","iat":1}`
	enc := func(s string) string {
		return strings.TrimRight(strings.NewReplacer("+", "-", "/", "_").Replace(base64StdNoPad(s)), "=")
	}
	return enc(header) + "." + enc(payload) + ".sig"
}

// wsURLFor maps an httptest server to the ws:// connect URL a real enrollment
// token would carry (deriveMintURL maps it back to http://.../sidecar/token).
func wsURLFor(srv *httptest.Server) string {
	return "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/sidecar/connect"
}

func TestVerifyBrainTokenSuccess(t *testing.T) {
	var gotAuth, gotPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		gotMethod = r.Method
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "expires_in": 600})
	}))
	t.Cleanup(srv.Close)

	jwt := enrollJWT(t, wsURLFor(srv))
	if err := verifyBrainToken(context.Background(), jwt, ""); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/sidecar/token" {
		t.Fatalf("probe hit %s %s, want POST /sidecar/token", gotMethod, gotPath)
	}
	if gotAuth != "Bearer "+jwt {
		t.Fatalf("enrollment token not sent as bearer: %q", gotAuth)
	}
}

func TestVerifyBrainTokenRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)

	err := verifyBrainToken(context.Background(), enrollJWT(t, wsURLFor(srv)), "")
	if err == nil || !strings.Contains(err.Error(), "rejected this token") {
		t.Fatalf("403 must read as a rejection, got %v", err)
	}
}

func TestVerifyBrainTokenUnreachable(t *testing.T) {
	// A server that existed and is gone: connection refused on a real port.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	dead := wsURLFor(srv)
	srv.Close()

	err := verifyBrainToken(context.Background(), enrollJWT(t, dead), "")
	if err == nil || !strings.Contains(err.Error(), "Could not reach the brain") {
		t.Fatalf("dead endpoint must read as unreachable, got %v", err)
	}
}

func TestVerifyBrainTokenServerError(t *testing.T) {
	// A brain (or proxy) that is up but erroring must not read as a wrong
	// URL ("doesn't look like a Jarvis brain") — it should invite a retry.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)

	err := verifyBrainToken(context.Background(), enrollJWT(t, wsURLFor(srv)), "")
	if err == nil || !strings.Contains(err.Error(), "server error") {
		t.Fatalf("5xx must read as a server error, got %v", err)
	}
	if strings.Contains(err.Error(), "doesn't look like a Jarvis brain") {
		t.Fatalf("5xx must not read as not-a-brain: %v", err)
	}
}

func TestVerifyBrainTokenNotABrain(t *testing.T) {
	// Wrong URL that answers: a plain web server 404s the mint path.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	err := verifyBrainToken(context.Background(), enrollJWT(t, wsURLFor(srv)), "")
	if err == nil || !strings.Contains(err.Error(), "doesn't look like a Jarvis brain") {
		t.Fatalf("404 must read as not-a-brain, got %v", err)
	}

	// A captive portal / unrelated app answering 200 to anything must not pass.
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>welcome</html>"))
	}))
	t.Cleanup(portal.Close)
	err = verifyBrainToken(context.Background(), enrollJWT(t, wsURLFor(portal)), "")
	if err == nil || !strings.Contains(err.Error(), "doesn't look like a Jarvis brain") {
		t.Fatalf("200-with-garbage must read as not-a-brain, got %v", err)
	}
}

func TestVerifyBrainTokenOverrideWins(t *testing.T) {
	// The token names a dead brain, but the config's brain override points at
	// a live one — verification must probe the override, like the client does.
	deadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	dead := wsURLFor(deadSrv)
	deadSrv.Close()

	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at"})
	}))
	t.Cleanup(live.Close)

	if err := verifyBrainToken(context.Background(), enrollJWT(t, dead), live.URL); err != nil {
		t.Fatalf("override should have been probed, got %v", err)
	}
}

func TestVerifyBrainTokenGarbageToken(t *testing.T) {
	err := verifyBrainToken(context.Background(), "not-a-jwt", "")
	if err == nil || !strings.Contains(err.Error(), "valid token") {
		t.Fatalf("garbage must fail structurally, got %v", err)
	}
}

func TestVerifyBrainTokenCancelled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := verifyBrainToken(ctx, enrollJWT(t, wsURLFor(srv)), "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled check must surface context.Canceled, got %v", err)
	}
}
