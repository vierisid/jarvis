package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	header := `{"alg":"ES256"}`
	payload := `{"sid":"s1","name":"desktop","brain":"wss://x/sidecar/connect","jwks":"https://x/jwks.json","iat":1}`
	enc := func(s string) string {
		return strings.TrimRight(strings.NewReplacer("+", "-", "/", "_").Replace(
			base64StdNoPad(s)), "=")
	}
	return enc(header) + "." + enc(payload) + ".sig"
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
