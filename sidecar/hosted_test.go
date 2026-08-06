package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGenerateHandshakeNonce(t *testing.T) {
	a, err := generateHandshakeNonce()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := generateHandshakeNonce()
	if a == b {
		t.Fatal("nonces must be unique")
	}
	// 32 bytes base64url unpadded = 43 chars, URL-safe alphabet only.
	if len(a) != 43 {
		t.Fatalf("unexpected nonce length %d", len(a))
	}
	if strings.ContainsAny(a, "+/=") {
		t.Fatalf("nonce is not base64url: %q", a)
	}
}

func TestResolveHostedBaseURL(t *testing.T) {
	// Release builds: overrides ignored, production origin always.
	if got := resolveHostedBaseURLWith(false, "https://evil.example", "https://evil2.example"); got != hostedDefaultBaseURL {
		t.Fatalf("release build must ignore overrides, got %q", got)
	}
	// Debug builds: env wins, then config, then default; trailing slash trimmed.
	if got := resolveHostedBaseURLWith(true, "https://cfg.example/", ""); got != "https://cfg.example" {
		t.Fatalf("config override failed, got %q", got)
	}
	if got := resolveHostedBaseURLWith(true, "https://cfg.example", "https://env.example"); got != "https://env.example" {
		t.Fatalf("env should beat config, got %q", got)
	}
	if got := resolveHostedBaseURLWith(true, "", ""); got != hostedDefaultBaseURL {
		t.Fatalf("debug build without overrides should use default, got %q", got)
	}
}

func TestConnectPageURLEscapesNonce(t *testing.T) {
	got := connectPageURL("https://app.usejarvis.dev", "abc/+?=")
	if got != "https://app.usejarvis.dev/connect?handshake=abc%2F%2B%3F%3D" {
		t.Fatalf("unexpected URL: %q", got)
	}
}

// fakeHandshakeServer scripts /api/handshake/register + /poll responses.
func fakeHandshakeServer(t *testing.T, poll func(n int, w http.ResponseWriter)) (*httptest.Server, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var registers, polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/handshake/register":
			if r.Method != http.MethodPost {
				w.WriteHeader(405)
				return
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["nonce"] == "" || body["hostname"] == "" {
				w.WriteHeader(400)
				return
			}
			registers.Add(1)
			w.WriteHeader(200)
		case "/api/handshake/poll":
			if r.URL.Query().Get("nonce") == "" {
				w.WriteHeader(400)
				return
			}
			poll(int(polls.Add(1)), w)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &registers, &polls
}

// A structurally valid unsigned-looking JWT for DecodeJWTPayload.
func testJWT(t *testing.T) string {
	t.Helper()
	return enrollJWT(t, "wss://x/sidecar/connect")
}

func base64StdNoPad(s string) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out []byte
	data := []byte(s)
	for i := 0; i < len(data); i += 3 {
		var b [3]byte
		n := copy(b[:], data[i:])
		out = append(out, alphabet[b[0]>>2], alphabet[(b[0]&0x3)<<4|b[1]>>4])
		if n > 1 {
			out = append(out, alphabet[(b[1]&0xF)<<2|b[2]>>6])
		}
		if n > 2 {
			out = append(out, alphabet[b[2]&0x3F])
		}
	}
	return string(out)
}

func TestHandshakeRegisterAndPollToCompletion(t *testing.T) {
	jwt := testJWT(t)
	srv, registers, _ := fakeHandshakeServer(t, func(n int, w http.ResponseWriter) {
		switch n {
		case 1:
			_ = json.NewEncoder(w).Encode(handshakePollResponse{Status: "pending", Step: "provisioning"})
		case 2:
			_ = json.NewEncoder(w).Encode(handshakePollResponse{Status: "complete", Token: jwt})
		default:
			t.Errorf("unexpected extra poll %d", n)
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	nonce, _ := generateHandshakeNonce()
	if err := registerHandshake(ctx, srv.URL, nonce, "desktop-A"); err != nil {
		t.Fatal(err)
	}
	if registers.Load() != 1 {
		t.Fatalf("expected 1 register, got %d", registers.Load())
	}

	var steps []string
	got, err := awaitHandshakeToken(ctx, srv.URL, nonce, func(s string) { steps = append(steps, s) })
	if err != nil {
		t.Fatal(err)
	}
	if got != jwt {
		t.Fatalf("wrong token: %q", got)
	}
	if len(steps) != 1 || steps[0] != "provisioning" {
		t.Fatalf("progress steps not forwarded: %v", steps)
	}
}

func TestHandshakeFailedIsTerminal(t *testing.T) {
	srv, _, polls := fakeHandshakeServer(t, func(n int, w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(handshakePollResponse{Status: "failed", Error: "provisioning failed permanently"})
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := awaitHandshakeToken(ctx, srv.URL, "nonce", nil)
	if err == nil || !strings.Contains(err.Error(), "provisioning failed permanently") {
		t.Fatalf("expected terminal failure, got %v", err)
	}
	if polls.Load() != 1 {
		t.Fatalf("a failed handshake must not be re-polled, got %d polls", polls.Load())
	}
}

func TestHandshakeCompleteWithGarbageTokenErrors(t *testing.T) {
	srv, _, _ := fakeHandshakeServer(t, func(n int, w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(handshakePollResponse{Status: "complete", Token: "not-a-jwt"})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := awaitHandshakeToken(ctx, srv.URL, "nonce", nil)
	if err == nil || !strings.Contains(err.Error(), "invalid token") {
		t.Fatalf("garbage token must be rejected, got %v", err)
	}
}

func TestHandshakeCancelledByContext(t *testing.T) {
	srv, _, _ := fakeHandshakeServer(t, func(n int, w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(handshakePollResponse{Status: "pending"})
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(150 * time.Millisecond)
		cancel() // window closed / self-host chosen
	}()
	_, err := awaitHandshakeToken(ctx, srv.URL, "nonce", nil)
	if err != context.Canceled {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestSubmitTokenHandlerGate(t *testing.T) {
	jwt := testJWT(t)
	active := false
	var accepted string
	handler := submitTokenHandler(func() bool { return active }, func(tok string) { accepted = tok })

	// Regression (review major 1): with the hosted flow showing remote
	// content (Clerk/Stripe redirects), any page can call the binding. While
	// the local form is NOT active it must refuse even a valid JWT.
	if err := handler(jwt); err == nil {
		t.Fatal("submitToken must be refused while the token form is inactive")
	}
	if accepted != "" {
		t.Fatalf("token must not be accepted while inactive, got %q", accepted)
	}

	// Active form: garbage rejected, valid JWT accepted.
	active = true
	if err := handler("not-a-jwt"); err == nil {
		t.Fatal("garbage token must be rejected")
	}
	if err := handler("  " + jwt + "  "); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if accepted != jwt {
		t.Fatalf("accepted token mismatch: %q", accepted)
	}
}

func TestPendingRepollIsRateLimited(t *testing.T) {
	// Regression (review major 2): a server/proxy answering "pending"
	// instantly must not be hammered. Unfixed this measured ~2900 polls/s.
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		polls.Add(1)
		_ = json.NewEncoder(w).Encode(handshakePollResponse{Status: "pending"})
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 1100*time.Millisecond)
	defer cancel()
	_, _ = awaitHandshakeToken(ctx, srv.URL, "nonce", nil)

	// With the 2s floor: one immediate poll, the second lands at ~2s (after
	// the window). Allow slack for scheduling but nothing like a hot loop.
	if n := polls.Load(); n > 2 {
		t.Fatalf("pending re-poll not rate-limited: %d polls in 1.1s", n)
	}
}

func TestHostedShellWithErrorBakesTheMessageIn(t *testing.T) {
	// Regression (review medium 4): the error must be part of the document
	// (boot script), not an Eval racing the fresh SetHtml.
	html := hostedShellWithError("Setup did not complete: it's broken <script>")
	if !strings.Contains(html, `window.__setError('Setup did not complete: it\'s broken \x3cscript>')`) {
		t.Fatalf("boot script missing or badly escaped:\n%s", html)
	}
	if strings.Contains(html, "/*__BOOT__*/") {
		t.Fatal("placeholder was not replaced")
	}
}

func TestHostedShellWithSelfHostHintBakesTheBootIn(t *testing.T) {
	html := hostedShellWithSelfHostHint()
	if !strings.Contains(html, "window.__setSelfHostHint();") {
		t.Fatalf("boot script missing:\n%s", html)
	}
	if strings.Contains(html, "/*__BOOT__*/") {
		t.Fatal("placeholder was not replaced")
	}
}

func TestIsNoSuchHostErr(t *testing.T) {
	// The wrapped shape url.Error{Op:"Post"} -> net.OpError -> net.DNSError is
	// what hostedHTTPClient.Do returns when the hosted origin doesn't resolve.
	dns := &net.DNSError{Err: "no such host", Name: "app.usejarvis.dev", IsNotFound: true}
	wrapped := &url.Error{Op: "Post", URL: "https://app.usejarvis.dev/api/handshake/register",
		Err: &net.OpError{Op: "dial", Net: "tcp", Err: dns}}
	if !isNoSuchHostErr(wrapped) {
		t.Fatal("wrapped DNS not-found error not detected")
	}
	if isNoSuchHostErr(&net.DNSError{Err: "server misbehaving", Name: "app.usejarvis.dev"}) {
		t.Fatal("transient DNS error must not count as no-such-host")
	}
	if isNoSuchHostErr(errors.New("connection refused")) {
		t.Fatal("non-DNS error must not count as no-such-host")
	}
}
