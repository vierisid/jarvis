package main

import (
	"strings"
	"testing"
)

// guardTestConfig pins the browser executable to something that cannot exist,
// so a launch attempt fails loudly instead of starting a real Chromium (an
// orphaned test browser holding a profile is a known flake source here). The
// pinned path is used without fallback on every platform, so nothing is
// launched by these tests.
func guardTestConfig() *SidecarConfig {
	cfg := &SidecarConfig{}
	cfg.Browser.ExecutablePath = "/nonexistent/jarvis-test-no-such-browser"
	return cfg
}

const noBrowserLaunched = "configured browser executable not found"

// A refused URL must not even launch a browser: the allowlist runs before
// getCDPForParams (#526, matching the daemon, which checks before connecting).
func TestNavigateHandlerRefusesBeforeLaunchingABrowser(t *testing.T) {
	closeActiveCDP()
	defer closeActiveCDP()

	navigate := makeBrowserNavigateHandler(guardTestConfig())
	cases := map[string]string{
		"file:///etc/passwd":                        "does not open local files",
		"FILE:///etc/passwd":                        "does not open local files",
		"fi\nle:///etc/passwd":                      "does not open local files",
		" file:///home/user/.ssh/id_rsa":            "does not open local files",
		"view-source:file:///etc/passwd":            "is not a web address",
		"filesystem:http://example.com/temporary/x": "is not a web address",
		"chrome://settings":                         "is not a web address",
		"javascript:alert(1)":                       "is not a web address",
		"about:settings":                            "about:blank",
		"http://127.0.0.1:9222/json/list":           "DevTools endpoint",
		"http:127.0.0.1:9223/json/list":             "DevTools endpoint",
		"example.com":                               "is not a valid URL",
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			res, err := navigate(map[string]any{"url": raw})
			if err == nil {
				t.Fatalf("navigate(%q) was allowed, returning %+v", raw, res)
			}
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("navigate(%q) error %q does not mention %q", raw, err, want)
			}
			if strings.Contains(err.Error(), noBrowserLaunched) {
				t.Fatalf("navigate(%q) tried to launch a browser before refusing: %v", raw, err)
			}
		})
	}
}

// The other direction: an allowed URL must reach the browser. It gets as far as
// the launch, which fails because of the pinned bogus executable -- proof that
// the guard passed the URL through rather than refusing it.
func TestNavigateHandlerAllowsWebURLsThroughToTheBrowser(t *testing.T) {
	closeActiveCDP()
	defer closeActiveCDP()

	navigate := makeBrowserNavigateHandler(guardTestConfig())
	for _, raw := range []string{
		"https://example.com/",
		"http://example.com/a?b=c#d",
		"https://user:pw@example.com/",
		"http://127.0.0.1:3000/",
		"http://127.0.0.1:9222@example.com/",
		"about:blank",
		"data:text/html,<h1>hi</h1>",
	} {
		t.Run(raw, func(t *testing.T) {
			_, err := navigate(map[string]any{"url": raw})
			if err == nil {
				t.Fatalf("navigate(%q) unexpectedly succeeded without a browser", raw)
			}
			if !strings.Contains(err.Error(), noBrowserLaunched) {
				t.Fatalf("navigate(%q) did not reach the browser launch: %v", raw, err)
			}
		})
	}
}

func TestNavigateHandlerStillRequiresAURL(t *testing.T) {
	closeActiveCDP()
	defer closeActiveCDP()

	navigate := makeBrowserNavigateHandler(guardTestConfig())
	_, err := navigate(map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "missing required parameter: url") {
		t.Fatalf("navigate with no url: got %v, want the missing-parameter error", err)
	}
	// Whitespace-only is not a missing parameter but it is not a URL either.
	_, err = navigate(map[string]any{"url": "   "})
	if err == nil || !strings.Contains(err.Error(), "No URL given") {
		t.Fatalf("navigate with blank url: got %v, want the no-URL refusal", err)
	}
}
