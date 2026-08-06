package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseEnrollDeepLink(t *testing.T) {
	t.Run("valid link round-trips nonce and token", func(t *testing.T) {
		nonce, token, err := parseEnrollDeepLink("jarvis://enroll?v=1&nonce=abc123&token=eyJ.x.y")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if nonce != "abc123" || token != "eyJ.x.y" {
			t.Fatalf("got nonce=%q token=%q", nonce, token)
		}
	})

	t.Run("token whitespace is trimmed", func(t *testing.T) {
		_, token, err := parseEnrollDeepLink("jarvis://enroll?nonce=n&token=%20%0aeyJ.x.y%0a")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if token != "eyJ.x.y" {
			t.Fatalf("token not trimmed: %q", token)
		}
	})

	t.Run("rejects wrong scheme, wrong host, and missing params", func(t *testing.T) {
		for _, bad := range []string{
			"https://enroll?nonce=n&token=t",
			"jarvis://n?id=x&kind=approval&a=approve", // notification URI namespace
			"jarvis://enroll?nonce=n",
			"jarvis://enroll?token=t",
			"jarvis://enroll",
		} {
			if _, _, err := parseEnrollDeepLink(bad); err == nil {
				t.Fatalf("expected error for %q", bad)
			}
		}
	})
}

// The forwarder and listener speak over the real unix socket under configDir.
func TestEnrollDeepLinkSocketRoundTrip(t *testing.T) {
	orig := configDir
	configDir = t.TempDir()
	defer func() { configDir = orig }()

	got := make(chan string, 2)
	l, err := listenEnrollDeepLinks(func(uri string) { got <- uri })
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close()

	uri := "jarvis://enroll?v=1&nonce=abc&token=e.f.g"
	if err := forwardEnrollDeepLink(uri); err != nil {
		t.Fatalf("forward: %v", err)
	}
	select {
	case u := <-got:
		if u != uri {
			t.Fatalf("got %q want %q", u, uri)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("URI never delivered")
	}

	// Close joins handlers, removes the socket, and further forwards fail —
	// the "no callback after Close" guarantee teardown depends on.
	l.Close()
	l.Close() // idempotent
	if err := forwardEnrollDeepLink(uri); err == nil {
		t.Fatal("forward after Close should fail")
	}
	if _, err := os.Stat(deepLinkSocketPath()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("socket not removed by Close: %v", err)
	}
}

func TestMaybeDropProtocolLaunch(t *testing.T) {
	origArgs := os.Args
	defer func() { os.Args = origArgs }()

	// Any unclaimed jarvis:// URI ends the process instead of booting a full
	// sidecar (the Linux scheme registration makes this web-page-reachable).
	os.Args = []string{"jarvis-sidecar", "jarvis://n?id=x&kind=approval&a=approve"}
	if !maybeDropProtocolLaunch() {
		t.Fatal("unrecognized jarvis:// URI must be dropped")
	}
	os.Args = []string{"jarvis-sidecar"}
	if maybeDropProtocolLaunch() {
		t.Fatal("normal launch must proceed")
	}
	os.Args = []string{"jarvis-sidecar", "--token", "abc"}
	if maybeDropProtocolLaunch() {
		t.Fatal("flag launch must proceed")
	}
}

func TestCapUTF16(t *testing.T) {
	// Astral runes weigh 2 UTF-16 units: 200 of them exceed a 300-unit cap at
	// rune 150, and a surrogate pair is never split.
	astral := strings.Repeat("\U0001D54F", 200)
	capped := capUTF16(astral, 300)
	if n := len([]rune(capped)); n != 150 {
		t.Fatalf("got %d runes, want 150", n)
	}
	if got := capUTF16("héllo", 300); got != "héllo" {
		t.Fatalf("under-limit string mangled: %q", got)
	}
	if got := capUTF16("abcdef", 3); got != "abc" {
		t.Fatalf("BMP cap wrong: %q", got)
	}
}

func TestReportSelfHostResult(t *testing.T) {
	type recorded struct {
		Nonce string  `json:"nonce"`
		OK    bool    `json:"ok"`
		Error *string `json:"error"`
	}
	var last atomic.Pointer[recorded]
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/handshake/self-host-result" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		calls.Add(1)
		var rec recorded
		_ = json.NewDecoder(r.Body).Decode(&rec)
		last.Store(&rec)
		w.WriteHeader(200)
		fmt.Fprint(w, `{"applied":true}`)
	}))
	defer srv.Close()

	t.Run("success posts ok with no error field", func(t *testing.T) {
		reportSelfHostResult(context.Background(), srv.URL, "n1", nil)
		rec := last.Load()
		if rec == nil || !rec.OK || rec.Nonce != "n1" || rec.Error != nil {
			t.Fatalf("bad payload: %+v", rec)
		}
	})

	t.Run("failure posts the user-ready reason, capped at 300 UTF-16 units", func(t *testing.T) {
		// UTF-16 units, NOT runes: the server's zod .max(…) counts UTF-16, so
		// an astral-heavy message must land under ITS cap. 400 astral runes =
		// 800 units -> capped to 150 runes = 300 units.
		reportSelfHostResult(context.Background(), srv.URL, "n2", errors.New(strings.Repeat("\U0001D54F", 400)))
		rec := last.Load()
		if rec == nil || rec.OK || rec.Error == nil {
			t.Fatalf("bad payload: %+v", rec)
		}
		if n := len([]rune(*rec.Error)); n != 150 {
			t.Fatalf("error not capped at 300 UTF-16 units: %d runes", n)
		}
	})

	t.Run("a cancelled verify is teardown, not a verdict", func(t *testing.T) {
		before := calls.Load()
		reportSelfHostResult(context.Background(), srv.URL, "n3", context.Canceled)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		reportSelfHostResult(ctx, srv.URL, "n3", nil)
		if calls.Load() != before {
			t.Fatal("teardown must not report")
		}
	})
}
