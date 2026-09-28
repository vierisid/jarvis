package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Integration test for the in-browser half of #526: what only a real Chromium
// can show. The unit tests prove what we ANSWER a paused request with; this
// proves Chrome pauses the requests we asked it to, that failing them stops a
// browser-initiated file: navigation, and that ordinary pages still load with
// the interception armed. Skipped when no Chromium is installed.
func TestBrowserFileGuardIntegration(t *testing.T) {
	cfg := &SidecarConfig{}
	if _, err := findChromiumExecutable(cfg); err != nil {
		t.Skipf("no Chromium available: %v", err)
	}
	// Not t.TempDir(): its cleanup fails the test if Chromium's children are
	// still releasing profile files (see browser_parity_test.go).
	profileDir, err := os.MkdirTemp("", "jarvis-guard-profile-*")
	if err != nil {
		t.Fatalf("create profile dir: %v", err)
	}
	t.Cleanup(func() {
		var rmErr error
		for i := 0; i < 20; i++ {
			if rmErr = os.RemoveAll(profileDir); rmErr == nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Logf("warning: profile dir cleanup failed after retries: %v", rmErr)
	})
	cfg.Browser.ProfileDir = profileDir

	// closeActiveCDP kills the browser this test started, by the handle the
	// launch returned -- never a process sweep.
	defer closeActiveCDP()
	cdp, err := getCDP(cfg, true, true)
	if err != nil {
		t.Fatalf("launch headless browser: %v", err)
	}

	// The production frame-tree reader, against a real Chrome's reply shape.
	mainFrameURL := func() string {
		t.Helper()
		url, err := cdp.mainFrameURL()
		if err != nil {
			t.Fatalf("mainFrameURL: %v", err)
		}
		return url
	}

	navigateRaw := func(url string) string {
		t.Helper()
		raw, err := cdp.send("Page.navigate", map[string]any{"url": url})
		if err != nil {
			t.Fatalf("Page.navigate %s: %v", url, err)
		}
		var nav struct {
			ErrorText string `json:"errorText"`
		}
		_ = json.Unmarshal(raw, &nav)
		return nav.ErrorText
	}

	// 1. A direct Page.navigate to file:, i.e. exactly what a future call site
	// that forgets the allowlist (or a desktop tool typing into a headed
	// browser's address bar) would produce. Chrome applies no check of its own
	// to a browser-initiated navigation; the guard has to.
	t.Run("file navigation is blocked inside Chrome", func(t *testing.T) {
		started := time.Now()
		errorText := navigateRaw("file:///etc/hostname")
		if errorText == "" {
			t.Fatalf("Chrome reported no error for a file: navigation; the guard did not fire")
		}
		if errorText != "net::ERR_BLOCKED_BY_CLIENT" {
			t.Fatalf("file: navigation failed as %q, want net::ERR_BLOCKED_BY_CLIENT", errorText)
		}
		blocked := cdp.blockedSince(started)
		if blocked == nil {
			t.Fatal("the guard recorded no blocked request")
		}
		if !strings.HasPrefix(strings.ToLower(blocked.url), "file:") {
			t.Fatalf("the guard blocked %q, not the file: URL", blocked.url)
		}
		if got := mainFrameURL(); isLocalContentURL(got) {
			t.Fatalf("the main frame is showing local content: %q", got)
		}
	})

	// 2. Redirects: a permitted http: URL that 302s into file: must not load the
	// file either. Whether the guard fails the redirect hop or Chrome refuses
	// the cross-scheme redirect first, the page must not end up on file:.
	t.Run("a redirect into file is stopped", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "file:///etc/hostname", http.StatusFound)
		}))
		defer srv.Close()
		if strings.Contains(srv.URL, ":9222") || strings.Contains(srv.URL, ":9223") {
			t.Skipf("the test server landed on a blocked DevTools port: %s", srv.URL)
		}

		if got, err := checkNavigationURL(srv.URL); err != nil {
			t.Fatalf("the allowlist refused the test server %s: %v", srv.URL, err)
		} else if got != srv.URL {
			t.Fatalf("the allowlist rewrote %s to %s", srv.URL, got)
		}

		errorText := navigateRaw(srv.URL)
		if errorText == "" {
			t.Fatalf("the redirect into file: reported no error")
		}
		t.Logf("redirect into file: stopped as %s", errorText)
		if got := mainFrameURL(); isLocalContentURL(got) {
			t.Fatalf("the main frame followed the redirect to local content: %q", got)
		}
	})

	// 2b. The redirect case that Chrome does NOT refuse for us: http -> http,
	// into a DevTools port. Nothing needs to be listening there -- if the guard
	// were not in the redirect path the failure would be a connection error, or
	// worse a loaded page, rather than ERR_BLOCKED_BY_CLIENT.
	t.Run("a same-scheme redirect to a DevTools port is blocked", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "http://127.0.0.1:9222/json/list", http.StatusFound)
		}))
		defer srv.Close()
		if strings.Contains(srv.URL, ":9222") || strings.Contains(srv.URL, ":9223") {
			t.Skipf("the test server landed on a blocked DevTools port: %s", srv.URL)
		}

		started := time.Now()
		errorText := navigateRaw(srv.URL)
		if errorText != "net::ERR_BLOCKED_BY_CLIENT" {
			t.Fatalf("the redirect to a DevTools port failed as %q, want net::ERR_BLOCKED_BY_CLIENT "+
				"(the guard must see redirect hops, not only the first request)", errorText)
		}
		blocked := cdp.blockedSince(started)
		if blocked == nil || !strings.Contains(blocked.reason, "DevTools port") {
			t.Fatalf("the guard recorded %+v, want the DevTools-port block", blocked)
		}
		if !strings.Contains(blocked.url, ":9222") {
			t.Fatalf("the guard blocked %q, not the redirect target", blocked.url)
		}
		// And the navigate handler turns that into a message that names it.
		msg := cdp.describeBlockedNavigation(srv.URL, errorText, started)
		if !strings.Contains(msg, "9222") || !strings.Contains(msg, "DevTools port") {
			t.Fatalf("describeBlockedNavigation = %q, want it to name the blocked redirect target", msg)
		}
	})

	// 3. The interception must not change ordinary browsing: this is the case
	// that would hang if a paused request were ever dropped.
	t.Run("ordinary pages still load", func(t *testing.T) {
		const body = `<!DOCTYPE html><html><head><title>Guarded</title></head>` +
			`<body><p>hello</p><img src="/pixel.png" alt="p"></body></html>`
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/pixel.png" {
				w.Header().Set("Content-Type", "image/png")
				w.WriteHeader(http.StatusOK)
				return
			}
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, body)
		}))
		defer srv.Close()
		if strings.Contains(srv.URL, ":9222") || strings.Contains(srv.URL, ":9223") {
			t.Skipf("the test server landed on a blocked DevTools port: %s", srv.URL)
		}

		navigate := makeBrowserNavigateHandler(cfg)
		res, err := navigate(map[string]any{"url": srv.URL, "headless": true})
		if err != nil {
			t.Fatalf("navigate to an ordinary page: %v", err)
		}
		out, _ := res.Result.(string)
		if !strings.Contains(out, "Page: Guarded") {
			t.Fatalf("snapshot of an ordinary page looks wrong:\n%s", out)
		}
	})
}
